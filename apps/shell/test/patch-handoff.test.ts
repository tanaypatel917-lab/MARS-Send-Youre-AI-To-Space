import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReviewVerificationViewSchema,
  VerificationViewSchema,
} from "@mars/contracts";
import { serveWorkbench, WorkbenchError } from "@mars/workbench";
import {
  canonicalPatchBytes,
  createFixtureOperations,
  sha256Hex,
} from "../scripts/fixture-workbench";
import { createBridge } from "../src/main/bridge";
import { type IpcEventLike, registerPatchHandoff } from "../src/main/ipc";
import { createPatchHandoff } from "../src/main/patch-handoff";
import { createLoopbackTransport } from "../src/main/transport";
import { createController } from "../src/renderer/controller";
import {
  PATCH_HANDOFF_CHANNEL,
  type PatchHandoffResult,
} from "../src/shared/patch-handoff";
import { ipcFixture } from "./ipc-fixture";
import { findAll, MiniDocument, serialize } from "./mini-dom";
import { fakeBridge, loadFixtureData } from "./test-utils";

test("desktop reviewer sees check logs and saves the same reviewed patch with its check receipt only on a matching source", async () => {
  const data = await loadFixtureData();
  const taskId = "fixture-completed-verified";
  const detail = data.details[taskId];
  const record = detail?.verification.record;
  if (!detail?.diff || !record || !record.checks[0])
    throw new Error("Missing fixture review");
  detail.diff.files = detail.diff.files.map((file) => ({
    ...file,
    patch: `${file.patch.trimEnd()}\n`,
  }));
  const expectedPatch = canonicalPatchBytes(detail.diff);
  record.patch_sha256 = sha256Hex(expectedPatch);
  detail.verification.patch_sha256 = record.patch_sha256;
  Object.assign(record.checks[0], {
    kind: "host_test",
    check_id: "fixture-check",
    exit_code: 0,
  });
  detail.verification.records = [record];
  const api = createFixtureOperations(data);
  const fixtureVerification = api.verification;
  let supportsLogs = true;
  api.verification = (context, id, includeCheckLogs) => {
    if (includeCheckLogs && !supportsLogs)
      throw new WorkbenchError("invalid_request");
    if (id !== taskId) return fixtureVerification(context, id);
    return Promise.resolve({
      ...detail.verification,
      ...(includeCheckLogs
        ? {
            check_logs: [
              {
                run_id: record.run_id,
                checks: [
                  {
                    check_index: 0,
                    output_tail: "1 passed <script>not markup</script>",
                  },
                ],
              },
            ],
          }
        : {}),
    });
  };
  const fixtureExport = api.export;
  let sourceBaseline: "matches" | "mismatch" | "unavailable" = "mismatch";
  let destinationStatus: "inside_source" | "outside_source" = "outside_source";
  let refuseRoundTrip = false;
  const parent = await mkdtemp(join(tmpdir(), "mars-handoff-test-"));
  api.export = async (context, params) => {
    if (refuseRoundTrip) throw new WorkbenchError("patch_round_trip_failed");
    const result = await fixtureExport(context, params);
    expect(params.review_handoff).toBe(true);
    expect(params.review_destination).toBe(await realpath(parent));
    return {
      ...result,
      handoff: {
        source_baseline: sourceBaseline,
        destination: destinationStatus,
        verdict: record,
      },
    };
  };
  const token = "fixture-token-0123456789abcdefghijklmnopqrstuvwxyz";
  const server = serveWorkbench({ api, token, port: 0 });
  try {
    const bridge = createBridge({
      transport: createLoopbackTransport({
        url: `http://127.0.0.1:${server.port}`,
        token,
      }),
      connectionScope: data.describe.scope,
    });
    const fixture = ipcFixture();
    let ipc: ((event: IpcEventLike, payload: unknown) => unknown) | undefined;
    let chosen = 0;
    registerPatchHandoff(
      {
        handle(channel, listener) {
          expect(channel).toBe(PATCH_HANDOFF_CHANNEL);
          ipc = listener;
        },
      },
      createPatchHandoff(
        () => bridge,
        async () => {
          chosen++;
          return parent;
        },
      ),
      fixture.options,
    );
    if (!ipc) throw new Error("Missing IPC handler");
    expect(await ipc(fixture.childFrame, {})).toMatchObject({
      status: "blocked",
    });
    expect(await ipc(fixture.owner, { folder: parent })).toMatchObject({
      status: "blocked",
    });
    expect(chosen).toBe(0);

    const document = new MiniDocument();
    const legacy = await bridge.call("tasks.verification", { task_id: taskId });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error("Missing compatible verdict");
    expect(VerificationViewSchema.parse(legacy.result)).not.toHaveProperty(
      "check_logs",
    );
    const controller = createController(
      {
        ...fakeBridge(data),
        "tasks.verification": async (params) => {
          const result = await bridge.call("tasks.verification", params);
          return result.ok
            ? {
                ok: true,
                result: ReviewVerificationViewSchema.parse(result.result),
              }
            : result;
        },
      },
      document,
      document.root,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        save: async (params) =>
          (await ipc?.(fixture.owner, params)) as PatchHandoffResult,
      },
    );
    await controller.load();
    const root = document.root;
    findAll(
      root,
      (element) => element.getAttribute("data-task-id") === taskId,
    )[0]?.click();
    await controller.settled();
    const changes = findAll(
      root,
      (element) =>
        element.tagName === "SECTION" &&
        element.children[0]?.textContent === "Changes",
    )[0];
    if (!changes) throw new Error("Missing Changes review");
    const html = serialize(changes);
    expect(html).toContain("passed · 4 ms · exit 0");
    expect(html).toContain("1 passed &lt;script&gt;not markup&lt;/script&gt;");
    expect(html).toContain("workspace diff");
    const save = () => {
      const button = findAll(
        root,
        (element) =>
          element.getAttribute("data-action") === "save-patch-handoff",
      )[0];
      expect(button?.disabled).toBe(false);
      button?.click();
    };
    save();
    await waitForText(root, "source checkout differs from the task baseline");
    expect(await readdir(parent)).toEqual([]);

    sourceBaseline = "unavailable";
    save();
    await waitForText(root, "source checkout could not be compared");
    expect(await readdir(parent)).toEqual([]);

    sourceBaseline = "matches";
    destinationStatus = "inside_source";
    save();
    await waitForText(root, "Choose a destination outside the source checkout");
    expect(await readdir(parent)).toEqual([]);

    destinationStatus = "outside_source";
    refuseRoundTrip = true;
    save();
    await waitForText(root, "patch cannot be reconstructed");
    expect(await readdir(parent)).toEqual([]);

    refuseRoundTrip = false;
    save();
    await waitForText(root, "No changes were applied");
    const folders = await readdir(parent);
    expect(folders).toHaveLength(1);
    const folder = join(parent, folders[0] ?? "");
    expect(
      expectedPatch.equals(await readFile(join(folder, "candidate.patch"))),
    ).toBe(true);
    const receipt = await readFile(join(folder, "check-receipt.json"), "utf8");
    expect(JSON.parse(receipt)).toMatchObject({
      patch_sha256: sha256Hex(expectedPatch),
      source_baseline: "matches",
      round_trip: "passed",
      verdict: {
        run_id: record.run_id,
        candidate: record.candidate,
        checks: [{ status: "passed", check_id: "fixture-check" }],
      },
    });
    expect(receipt).not.toContain("not markup");
    expect(root.textContent).toContain("git apply --check");

    supportsLogs = false;
    await controller.load();
    expect(root.textContent).toContain("No check log available.");
    expect(root.textContent).toContain("passed · 4 ms · exit 0");

    detail.verification.state = "stale";
    await controller.load();
    expect(root.textContent).toContain(
      "Verification is stale. Run the required checks",
    );
    const disabled = findAll(
      root,
      (element) => element.getAttribute("data-action") === "save-patch-handoff",
    )[0];
    expect(disabled?.disabled).toBe(true);
    controller.dispose();
  } finally {
    server.stop(true);
    await rm(parent, { recursive: true, force: true });
  }
});

async function waitForText(root: { textContent: string }, text: string) {
  for (
    let attempt = 0;
    attempt < 100 && !root.textContent.includes(text);
    attempt++
  )
    await Bun.sleep(10);
  expect(root.textContent).toContain(text);
}
