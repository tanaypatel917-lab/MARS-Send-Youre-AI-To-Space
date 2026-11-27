import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PatchExport,
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
import {
  type IpcEventLike,
  registerBridge,
  registerPatchHandoff,
} from "../src/main/ipc";
import { createPatchHandoff } from "../src/main/patch-handoff";
import { createManagedWorkbenchBridge } from "../src/main/session";
import { createSetupJournal } from "../src/main/setup-journal";
import { createLoopbackTransport } from "../src/main/transport";
import { createController } from "../src/renderer/controller";
import {
  type ArtifactData,
  BRIDGE_CHANNEL,
  bridgeFailure,
} from "../src/shared/methods";
import {
  PATCH_HANDOFF_CHANNEL,
  type PatchHandoffResult,
} from "../src/shared/patch-handoff";
import { ipcFixture } from "./ipc-fixture";
import { findAll, MiniDocument, serialize } from "./mini-dom";
import { fakeBridge, loadFixtureData } from "./test-utils";

test("renderer export cannot forward a destination to the workbench", async () => {
  const fixture = ipcFixture();
  let ipc: ((event: IpcEventLike, payload: unknown) => unknown) | undefined;
  const params = {
    task_id: "task",
    expected_revision: "revision",
    expected_patch_sha256: "a".repeat(64),
  };
  const calls: unknown[] = [];
  const response = bridgeFailure("not_connected");
  registerBridge(
    {
      handle(channel, handler) {
        expect(channel).toBe(BRIDGE_CHANNEL);
        ipc = handler;
      },
    },
    {
      async call(method, params) {
        calls.push({ method, params });
        return response;
      },
    },
    fixture.options,
  );
  if (!ipc) throw new Error("Missing IPC handler");
  const request = { method: "tasks.export", params };
  expect(
    await ipc(fixture.owner, {
      ...request,
      params: {
        ...params,
        review_handoff: true,
        review_destination: "/somewhere",
      },
    }),
  ).toEqual(bridgeFailure("protocol"));
  expect(calls).toEqual([]);
  expect(await ipc(fixture.owner, request)).toEqual(response);
  expect(calls).toEqual([request]);
});

test.each(["project", "sandbox"] as const)(
  "a %s change while choosing a destination cancels the patch handoff",
  async (kind) => {
    const calls: unknown[] = [];
    const bridge = createManagedWorkbenchBridge({
      connect: () => ({
        async call(method) {
          calls.push(method);
          return bridgeFailure("not_connected");
        },
      }),
      isChanging: () => false,
      webContents: { reload() {}, send() {} },
    });
    const parent = await mkdtemp(join(tmpdir(), "mars-handoff-reconnect-"));
    try {
      const selected = Promise.withResolvers<string>();
      const handoff = createPatchHandoff(
        bridge.currentBridge,
        () => selected.promise,
      );
      const saving = handoff({
        task_id: "task",
        expected_revision: "revision",
        expected_patch_sha256: "a".repeat(64),
      });
      bridge.reconnect(kind);
      selected.resolve(parent);
      expect(await saving).toMatchObject({
        status: "blocked",
        reason: expect.stringContaining("The source project changed"),
      });
      expect(calls).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.each(["project", "sandbox"] as const)(
  "a %s change during patch retrieval blocks saving a verified handoff",
  async (kind) => {
    const data = await loadFixtureData();
    const taskId = "fixture-completed-verified";
    const detail = data.details[taskId];
    const record = detail?.verification.record;
    if (!detail?.diff || !record?.candidate)
      throw new Error("Missing fixture review");
    const patch = canonicalPatchBytes(detail.diff);
    const patchSha = sha256Hex(patch);
    const exported: PatchExport = {
      candidate: record.candidate,
      patch_sha256: patchSha,
      artifact: {
        artifact_id: "verified-patch",
        media_type: "text/x-diff",
        byte_length: patch.byteLength,
        sha256: patchSha,
      },
      files: detail.diff.files.length,
      verification: "verified",
      verified: true,
      verdict_run_id: record.run_id,
      handoff: {
        source_baseline: "matches",
        destination: "outside_source",
        verdict: { ...record, patch_sha256: patchSha },
      },
      round_trip: { status: "passed", reason: null },
      unsupported: [],
    };
    const artifactData: ArtifactData = {
      media_type: exported.artifact.media_type,
      data_base64: patch.toString("base64"),
    };
    const artifactRequested = Promise.withResolvers<unknown>();
    const artifact = Promise.withResolvers<ArtifactData>();
    const bridge = createManagedWorkbenchBridge({
      connect: () => ({
        async call(method, params) {
          if (method === "tasks.export") return { ok: true, result: exported };
          if (method === "tasks.artifact") {
            artifactRequested.resolve(params);
            return { ok: true, result: await artifact.promise };
          }
          return bridgeFailure("not_connected");
        },
      }),
      isChanging: () => false,
      webContents: { reload() {}, send() {} },
    });
    const parent = await mkdtemp(join(tmpdir(), "mars-handoff-reconnect-"));
    const handoff = createPatchHandoff(
      bridge.currentBridge,
      async () => parent,
    );
    const saving = handoff({
      task_id: taskId,
      expected_revision: exported.candidate.revision,
      expected_patch_sha256: patchSha,
    });
    try {
      const requested = await Promise.race([
        artifactRequested.promise,
        saving.then((result) => {
          throw new Error(
            `Handoff finished before fetching the patch: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      expect(requested).toEqual({
        task_id: taskId,
        artifact: exported.artifact,
      });
      bridge.reconnect(kind);
      artifact.resolve(artifactData);
      expect(await saving).toMatchObject({
        status: "blocked",
        reason: expect.stringContaining("The source project changed"),
      });
      expect(await readdir(parent)).toEqual([]);
    } finally {
      artifact.resolve(artifactData);
      await saving;
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test("desktop reviewer sees check logs and saves the same reviewed patch with its check receipt only on a matching source", async () => {
  const data = await loadFixtureData();
  const taskId = "fixture-completed-verified";
  const detail = data.details[taskId];
  const record = detail?.verification.record;
  if (!detail?.diff || !record?.candidate || !record.checks[0])
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
                    capture_truncated: true,
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
  const milestoneAt = "2026-11-26T00:00:00.000Z";
  const journalPath = join(parent, "user-data", "setup-journal.json");
  const journal = createSetupJournal(journalPath, () => new Date(milestoneAt));
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
    const choosing = Promise.withResolvers<void>();
    const selection = Promise.withResolvers<string>();
    let pauseSelection = false;
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
          if (pauseSelection) {
            choosing.resolve();
            return selection.promise;
          }
          return parent;
        },
        journal,
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
    expect(
      await ipc(fixture.owner, {
        task_id: taskId,
        expected_revision: record.candidate.revision,
        expected_patch_sha256: record.patch_sha256,
        review_destination: parent,
      }),
    ).toMatchObject({ status: "blocked" });
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
      {
        request: async () => ({
          ok: true,
          workspace: "scope",
          sessions: [],
          configured: false,
          canConfigure: true,
        }),
        setup: journal.snapshot,
      },
      undefined,
      undefined,
      {
        save: async (params) =>
          (await ipc?.(fixture.owner, params)) as PatchHandoffResult,
      },
    );
    await controller.load();
    const root = document.root;
    const navigate = (page: string) => {
      const button = findAll(
        root,
        (element) => element.getAttribute("data-page") === page,
      )[0];
      if (!button) throw new Error(`Missing ${page} page button`);
      button.click();
    };
    navigate("tasks");
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
    expect(html).toContain("excerpt; later output was discarded");
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
    expect((await journal.snapshot()).milestones).toEqual({});

    refuseRoundTrip = false;
    pauseSelection = true;
    save();
    await choosing.promise;
    navigate("settings");
    expect(root.textContent).toContain("First verified patch exportedNot yet");
    selection.resolve(parent);
    await waitForText(root, "First verified patch exported2026-11-26");
    expect(
      (await createSetupJournal(journalPath).snapshot()).milestones,
    ).toEqual({ first_verified_export: milestoneAt });
    navigate("tasks");
    await waitForText(root, "No changes were applied");
    const folders = (await readdir(parent)).filter((entry) =>
      entry.startsWith("mars-review-"),
    );
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
    expect(root.textContent).toContain("first run git init");
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
