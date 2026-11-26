import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PatchExport } from "@mars/contracts";
import type { ArtifactData } from "../shared/methods";
import type { PatchHandoffResult } from "../shared/patch-handoff";
import type { Bridge } from "./bridge";
import { RendererExportParamsSchema } from "./protocol";

const blocked = (reason: string): PatchHandoffResult => ({
  status: "blocked",
  reason,
});

export function createPatchHandoff(
  currentBridge: () => Bridge,
  chooseFolder: () => Promise<string | undefined>,
) {
  let busy = false;
  return async (payload: unknown): Promise<PatchHandoffResult> => {
    const parsed = RendererExportParamsSchema.safeParse(payload);
    if (!parsed.success) return blocked("Invalid patch handoff request.");
    if (busy) return blocked("A patch handoff is already open.");
    busy = true;
    const bridge = currentBridge();
    let folder: string | undefined;
    try {
      const parent = await chooseFolder();
      if (!parent) return { status: "cancelled" };
      const destination = await realpath(parent);
      if (bridge !== currentBridge())
        return blocked(
          "The source project changed. Open its task review and try again.",
        );
      const params = parsed.data;
      const result = await bridge.call("tasks.export", {
        ...params,
        review_handoff: true,
        review_destination: destination,
      });
      if (!result.ok)
        return blocked(
          result.error.kind === "conflict"
            ? "The task or verified patch changed. Refresh the diff and verify the current candidate before saving."
            : result.error.message,
        );
      const exported = result.result as PatchExport;
      const { handoff, candidate, artifact, patch_sha256 } = exported;
      if (handoff?.destination === "inside_source")
        return blocked(
          "Choose a destination outside the source checkout. Saving there would change the task baseline.",
        );
      if (!handoff || handoff.source_baseline === "unavailable")
        return blocked(
          "The source checkout could not be compared with the task baseline. Reconnect to the local source project and retry.",
        );
      if (handoff.source_baseline === "mismatch")
        return blocked(
          "The source checkout differs from the task baseline. Return to the original source state or start a new task and run the checks against the current checkout.",
        );
      if (handoff.destination !== "outside_source")
        return blocked(
          "The destination could not be confirmed to be outside the source checkout. Choose another folder.",
        );
      const { verdict } = handoff;
      if (
        !exported.verified ||
        exported.round_trip.status !== "passed" ||
        candidate.revision !== params.expected_revision ||
        patch_sha256 !== params.expected_patch_sha256 ||
        !verdict.verified ||
        verdict.run_id !== exported.verdict_run_id ||
        verdict.task_id !== params.task_id ||
        verdict.candidate?.revision !== candidate.revision ||
        verdict.candidate.workspace_id !== candidate.workspace_id ||
        verdict.candidate.provider !== candidate.provider ||
        verdict.patch_sha256 !== patch_sha256
      )
        return blocked("The check receipt does not match the reviewed patch.");
      const fetched = await bridge.call("tasks.artifact", {
        task_id: params.task_id,
        artifact,
      });
      if (!fetched.ok) return blocked(fetched.error.message);
      const patch = Buffer.from(
        (fetched.result as ArtifactData).data_base64,
        "base64",
      );
      if (
        patch.byteLength !== artifact.byte_length ||
        createHash("sha256").update(patch).digest("hex") !== patch_sha256
      )
        return blocked("The downloaded patch failed SHA-256 verification.");
      if (bridge !== currentBridge())
        return blocked(
          "The source project changed. Open its task review and try again.",
        );
      folder = await mkdtemp(join(destination, "mars-review-"));
      const receipt = {
        schema_version: 1,
        patch_file: "candidate.patch",
        patch_sha256,
        source_baseline: handoff.source_baseline,
        round_trip: exported.round_trip.status,
        verdict,
      };
      await writeFile(join(folder, receipt.patch_file), patch, {
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(
        join(folder, "check-receipt.json"),
        `${JSON.stringify(receipt, null, 2)}\n`,
        {
          flag: "wx",
          mode: 0o600,
        },
      );
      return { status: "saved", folder: basename(folder) };
    } catch {
      if (folder)
        await rm(folder, { recursive: true, force: true }).catch(() => {});
      return blocked(
        "Could not save the handoff. Choose a writable folder and retry.",
      );
    } finally {
      busy = false;
    }
  };
}
