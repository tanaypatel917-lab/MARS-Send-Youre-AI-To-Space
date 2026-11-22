import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_JOURNAL_ENTRY_IDS } from "@mars/contracts";
import {
  FixtureTeamService,
  MAX_MESSAGE_CHARS,
  MAX_SEARCH_QUERY_CHARS,
} from "@mars/team-chat";
import type { TranscriptProjection } from "@mars/ui-core";
import { StartParamsSchema, serveWorkbench } from "@mars/workbench";
import {
  canonicalPatchBytes,
  createFixtureOperations,
  type FixtureData,
  patchRoundTrip,
  sha256Hex,
} from "../scripts/fixture-workbench";
import { type Bridge, createBridge } from "../src/main/bridge";
import { type IpcEventLike, registerTeamChatBridge } from "../src/main/ipc";
import {
  createTeamChatBridge,
  type TeamChatBridge,
} from "../src/main/team-chat-bridge";
import { createLoopbackTransport } from "../src/main/transport";
import {
  createController,
  JOURNAL_BATCH_SIZE,
  MAX_HYDRATED_EVENT_PAYLOADS,
} from "../src/renderer/controller";
import { renderTranscript } from "../src/renderer/transcript";
import { MAX_REQUIRED_CHECKS } from "../src/renderer/view";
import { BRIDGE_METHODS, type ShellBridge } from "../src/shared/methods";
import {
  TEAM_CHAT_CHANNEL,
  TEAM_CHAT_MAX_MESSAGE_CHARS,
  TEAM_CHAT_MAX_SEARCH_CHARS,
  TEAM_CHAT_METHODS,
  type TeamChatBridgeApi,
} from "../src/shared/team-chat";
import { ipcFixture } from "./ipc-fixture";
import { findAll, MiniDocument, type MiniElement } from "./mini-dom";
import { loadFixtureData } from "./test-utils";

const TOKEN = "fixture-token-0123456789abcdefghijklmnopqrstuvwxyz";

function toShellBridge(bridge: Bridge): ShellBridge {
  const api: Record<string, (params: unknown) => Promise<unknown>> = {};
  for (const method of BRIDGE_METHODS) {
    api[method] = (params) => bridge.call(method, params);
  }
  return api as unknown as ShellBridge;
}

function toShellTeamChat(teamBridge: TeamChatBridge): TeamChatBridgeApi {
  const api: Record<string, (params: unknown) => Promise<unknown>> = {};
  for (const method of TEAM_CHAT_METHODS) {
    api[method] = (params) => teamBridge.call(method, params);
  }
  return api as unknown as TeamChatBridgeApi;
}

async function startTestWorkbench(mutate?: (data: FixtureData) => void) {
  const data = (await loadFixtureData()) as FixtureData;
  mutate?.(data);
  const server = serveWorkbench({
    api: createFixtureOperations(data),
    token: TOKEN,
    port: 0,
  });
  const url = `http://127.0.0.1:${server.port}`;
  const rawBridge = createBridge({
    transport: createLoopbackTransport({ url, token: TOKEN }),
    connectionScope: {
      owner_id: data.describe.scope.owner_id,
      project_id: data.describe.scope.project_id,
    },
    requestId: () => "interactive-test",
  });
  return {
    data,
    bridge: toShellBridge(rawBridge),
    close: () => server.stop(true),
  };
}

/** Appends synthetic events (with JSON payload artifacts) to a task's first event page. */
function withSyntheticEvents(
  bridge: ShellBridge,
  taskId: string,
  payloads: unknown[],
  hooks: { onArtifact?: (artifactId: string) => Promise<void> | void } = {},
): ShellBridge {
  const encoded = payloads.map((payload, index) => {
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    return {
      artifact_id: `art-synthetic-${index}`,
      event_id: `evt-synthetic-${index}`,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const lastId = encoded.at(-1)?.event_id;
  return {
    ...bridge,
    "tasks.events": async (params) => {
      if (params.task_id !== taskId) return bridge["tasks.events"](params);
      if (lastId && params.after_event_id === lastId)
        return { ok: true, result: [] };
      const res = await bridge["tasks.events"](params);
      if (!res.ok || params.after_event_id || res.result.length === 0)
        return res;
      const base = res.result[0];
      if (!base) return res;
      return {
        ok: true,
        result: [
          ...res.result,
          ...encoded.map((item, index) => ({
            ...base,
            event_id: item.event_id,
            sequence: 1000 + index,
            event_type: "execution.observed" as const,
            payload: {
              artifact_id: item.artifact_id,
              media_type: "application/json",
              byte_length: item.bytes.byteLength,
              sha256: item.sha256,
            },
          })),
        ],
      };
    },
    "tasks.artifact": async (params) => {
      const item = encoded.find(
        (entry) => entry.artifact_id === params.artifact.artifact_id,
      );
      if (!item) return bridge["tasks.artifact"](params);
      await hooks.onArtifact?.(item.artifact_id);
      return {
        ok: true,
        result: {
          artifact_id: item.artifact_id,
          media_type: "application/json",
          data_base64: item.bytes.toString("base64"),
        },
      };
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function findByAttr(
  root: MiniElement,
  attr: string,
  value: string,
): MiniElement | undefined {
  return findAll(root, (el) => el.getAttribute(attr) === value)[0];
}

describe("interactive workbench bridge and fixture lifecycle", () => {
  test("creates, starts, steers, cancels, and exports verified patches with SHA-256 verification", async () => {
    const { bridge, close } = await startTestWorkbench();
    try {
      const described = await bridge["workbench.describe"]({});
      expect(described.ok).toBe(true);
      if (!described.ok) return;

      const created = await bridge["tasks.create"]({
        task: {
          schema_version: 1,
          task_id: "fixture-interactive-1",
          session_id: "shell-session-interactive-1",
          scope: described.result.scope,
          request: "Audit interactive bridge <script>alert(1)</script>",
          acceptance_criteria: ["All approvals explicit"],
          budget: {
            max_tokens: 100000,
            max_usd: 2,
            max_duration_ms: 300000,
            max_depth: 2,
            max_concurrency: 1,
          },
          status: "pending",
          revision: 0,
          specialist_revision: null,
          artifacts: [],
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.result.task_id).toBe("fixture-interactive-1");
      expect(created.result.status).toBe("pending");

      const staleStart = await bridge["tasks.start"]({
        task_id: "fixture-interactive-1",
        expected_revision: 99,
        approvals: { read: true, write: false, execute: false },
      });
      expect(staleStart.ok).toBe(false);

      const started = await bridge["tasks.start"]({
        task_id: "fixture-interactive-1",
        expected_revision: 0,
        approvals: { read: true, write: true, execute: false },
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(started.result.status).toBe("running");
      expect(started.result.revision).toBe(1);

      const steered = await bridge["tasks.steer"]({
        task_id: "fixture-interactive-1",
        instruction: "Focus on CSP and preload tests",
      });
      expect(steered.ok).toBe(true);

      const cancelled = await bridge["tasks.cancel"]({
        task_id: "fixture-interactive-1",
      });
      expect(cancelled.ok).toBe(true);

      const afterCancel = await bridge["tasks.inspect"]({
        task_id: "fixture-interactive-1",
      });
      expect(afterCancel.ok).toBe(true);
      if (afterCancel.ok) {
        expect(afterCancel.result.status).toBe("cancelled");
      }

      // Unverified task: the current candidate revision and actual patch
      // SHA-256 are accepted, but the bridge reports the unverified verdict.
      const unverifiedVerification = await bridge["tasks.verification"]({
        task_id: "fixture-completed-unverified",
      });
      expect(unverifiedVerification.ok).toBe(true);
      if (!unverifiedVerification.ok) return;
      const unverifiedRevision =
        unverifiedVerification.result.candidate?.revision;
      expect(unverifiedRevision).toBeDefined();
      if (!unverifiedRevision) return;
      const unverifiedDiff = await bridge["tasks.diff"]({
        task_id: "fixture-completed-unverified",
      });
      expect(unverifiedDiff.ok).toBe(true);
      if (!unverifiedDiff.ok) return;
      const unverifiedPatchSha = sha256Hex(
        canonicalPatchBytes(unverifiedDiff.result),
      );
      const unverifiedExport = await bridge["tasks.export"]({
        task_id: "fixture-completed-unverified",
        expected_revision: unverifiedRevision,
        expected_patch_sha256: unverifiedPatchSha,
      });
      expect(unverifiedExport.ok).toBe(true);
      if (!unverifiedExport.ok) return;
      expect(unverifiedExport.result.verified).toBe(false);
      expect(unverifiedExport.result.verification).toBe("unverified");
      expect(unverifiedExport.result.verdict_run_id).toBeNull();
      expect(unverifiedExport.result.candidate.revision).toBe(
        unverifiedRevision,
      );
      expect(unverifiedExport.result.patch_sha256).toBe(unverifiedPatchSha);

      // A stale revision is still a conflict, not an unverified export.
      const staleExport = await bridge["tasks.export"]({
        task_id: "fixture-completed-unverified",
        expected_revision: "fixture-r1",
        expected_patch_sha256: unverifiedPatchSha,
      });
      expect(staleExport.ok).toBe(false);

      // Verified task rejects wrong patch digest
      const badHashExport = await bridge["tasks.export"]({
        task_id: "fixture-completed-verified",
        expected_revision: "fixture-r5",
        expected_patch_sha256: "0".repeat(64),
      });
      expect(badHashExport.ok).toBe(false);

      // Verified task succeeds with exact digest
      const diffRes = await bridge["tasks.diff"]({
        task_id: "fixture-completed-verified",
      });
      expect(diffRes.ok).toBe(true);
      if (!diffRes.ok) return;
      const expectedDigest = diffRes.result.digest;
      expect(expectedDigest).toBeDefined();
      if (!expectedDigest) return;

      const exported = await bridge["tasks.export"]({
        task_id: "fixture-completed-verified",
        expected_revision: "fixture-r5",
        expected_patch_sha256: expectedDigest,
      });
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      expect(exported.result.patch_sha256).toBe(expectedDigest);
      expect(exported.result.artifact.sha256).toBe(expectedDigest);

      const artifactRes = await bridge["tasks.artifact"]({
        task_id: "fixture-completed-verified",
        artifact: exported.result.artifact,
      });
      expect(artifactRes.ok).toBe(true);
      if (!artifactRes.ok) return;
      const digest = createHash("sha256")
        .update(Buffer.from(artifactRes.result.data_base64, "base64"))
        .digest("hex");
      expect(digest).toBe(expectedDigest);
    } finally {
      close();
    }
  });
});

describe("Team Chat IPC bridge security and operations", () => {
  test("enforces sender origin, allowlist, messaging, reactions, pins, and search", async () => {
    const teamBridge = createTeamChatBridge();
    const { options, owner, otherWindow, childFrame } = ipcFixture();
    const handlers = new Map<
      string,
      (event: IpcEventLike, payload: unknown) => unknown
    >();
    registerTeamChatBridge(
      {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
      },
      teamBridge,
      options,
    );
    const handler = handlers.get(TEAM_CHAT_CHANNEL);
    expect(handler).toBeDefined();
    if (!handler) return;

    owner.senderFrame.url = "https://evil.example/app";
    for (const event of [owner, otherWindow, childFrame]) {
      expect(
        await handler(event, { method: "team.state", params: {} }),
      ).toEqual({
        ok: false,
        code: "forbidden",
      });
    }
    owner.senderFrame.url = "mars-shell://app/index.html";

    const unknownMethod = await handler(owner, {
      method: "team.deleteEverything",
      params: {},
    });
    expect(unknownMethod).toEqual({
      ok: false,
      code: "forbidden",
    });

    const stateRes = (await handler(owner, {
      method: "team.state",
      params: {},
    })) as {
      ok: boolean;
      value?: {
        conversations: { conversation_id: string }[];
        users: { user_id: string }[];
      };
    };
    expect(stateRes.ok).toBe(true);
    if (!stateRes.ok || !stateRes.value) return;
    const convId = stateRes.value.conversations[0]?.conversation_id;
    expect(convId).toBeTruthy();
    if (!convId) return;

    const opened = (await handler(owner, {
      method: "team.open",
      params: { conversation_id: convId },
    })) as { ok: boolean; value?: { messages: { message_id: string }[] } };
    expect(opened.ok).toBe(true);

    const sent = (await handler(owner, {
      method: "team.send",
      params: {
        input: {
          conversation_id: convId,
          body: "Hello from shell test <img src=x onerror=alert(1)>",
          client_message_id: "test-msg-1",
          reply_to: null,
          references: [],
        },
      },
    })) as {
      ok: boolean;
      value?: { message_id: string; sequence: number; duplicate: boolean };
    };
    expect(sent.ok).toBe(true);
    if (!sent.ok || !sent.value) return;
    expect(sent.value.message_id).toBeTruthy();
    expect(sent.value.duplicate).toBe(false);

    const reacted = (await handler(owner, {
      method: "team.setReaction",
      params: {
        message_id: sent.value.message_id,
        emoji: "👍",
        on: true,
      },
    })) as { ok: boolean };
    expect(reacted.ok).toBe(true);

    const pinned = (await handler(owner, {
      method: "team.setPinned",
      params: {
        conversation_id: convId,
        pinned: true,
      },
    })) as { ok: boolean };
    expect(pinned.ok).toBe(true);

    const searched = (await handler(owner, {
      method: "team.search",
      params: { query: "Hello from shell test" },
    })) as { ok: boolean; value?: { hits: unknown[] } };
    expect(searched.ok).toBe(true);
    expect((searched.value?.hits.length ?? 0) > 0).toBe(true);
  });
});

describe("interactive renderer controller flows", () => {
  test("composer, approvals, paid-model consent, steer, cancel, verified patch export, and Team Chat pane", async () => {
    const { bridge, close } = await startTestWorkbench();
    try {
      const teamChat = toShellTeamChat(createTeamChatBridge());
      const doc = new MiniDocument();
      const controller = createController(bridge, doc, doc.root, teamChat);
      await controller.load();

      // 1. Select verified task: enabled export button exports and verifies SHA-256
      const verifiedBtn = findByAttr(
        doc.root,
        "data-task-id",
        "fixture-completed-verified",
      );
      verifiedBtn?.click();
      await waitFor(
        () => findByAttr(doc.root, "data-action", "export-patch") !== undefined,
      );
      const exportBtn = findByAttr(doc.root, "data-action", "export-patch");
      expect(exportBtn).toBeDefined();
      expect(exportBtn?.attributes.has("disabled")).toBe(false);
      exportBtn?.click();
      await waitFor(
        () =>
          findByAttr(doc.root, "data-export-verified", "true") !== undefined,
      );
      const exportResult = findByAttr(doc.root, "data-export-verified", "true");
      expect(exportResult?.textContent).toContain("sha256 verified");

      // 2. Unverified task does not allow patch export
      const unverifiedBtn = findByAttr(
        doc.root,
        "data-task-id",
        "fixture-completed-unverified",
      );
      unverifiedBtn?.click();
      await waitFor(
        () => findByAttr(doc.root, "data-action", "export-patch") === undefined,
      );
      expect(
        findByAttr(doc.root, "data-action", "export-patch"),
      ).toBeUndefined();

      // 3. Pending task: paid-model consent blocks launch until consented, and independent approvals work
      const pendingBtn = findByAttr(
        doc.root,
        "data-task-id",
        "fixture-pending",
      );
      pendingBtn?.click();
      await waitFor(
        () => findByAttr(doc.root, "data-card", "approval-card") !== undefined,
      );

      const modelSelect = findByAttr(doc.root, "data-control", "launch-model");
      expect(modelSelect).toBeDefined();
      if (modelSelect) {
        modelSelect.value = "paid";
        modelSelect.dispatch("change");
      }
      await waitFor(
        () =>
          findByAttr(doc.root, "data-card", "paid-model-consent") !== undefined,
      );
      const startBlocked = findByAttr(doc.root, "data-action", "start-task");
      expect(startBlocked?.attributes.has("disabled")).toBe(true);

      const paidCheckbox = findByAttr(
        doc.root,
        "data-control",
        "launch-paid-consent",
      );
      if (paidCheckbox) {
        paidCheckbox.checked = true;
        paidCheckbox.dispatch("change");
      }
      const readCheckbox = findByAttr(doc.root, "data-control", "launch-read");
      if (readCheckbox) {
        readCheckbox.checked = true;
        readCheckbox.dispatch("change");
      }
      const startReady = findByAttr(doc.root, "data-action", "start-task");
      expect(startReady?.attributes.has("disabled")).toBe(false);
      startReady?.click();
      await waitFor(
        () => findByAttr(doc.root, "data-action", "steer-task") !== undefined,
      );

      // 4. Steer and cancel the running task
      const steerInput = findByAttr(doc.root, "data-control", "steer-input");
      if (steerInput) {
        steerInput.value = "Check CSP headers";
        steerInput.dispatch("input");
      }
      findByAttr(doc.root, "data-action", "steer-task")?.click();
      await waitFor(() =>
        doc.root.textContent.includes("Steering instruction sent."),
      );

      findByAttr(doc.root, "data-action", "cancel-task")?.click();
      await waitFor(() => doc.root.textContent.includes("cancelled"));

      // 5. Prompt composer creates a new task
      const reqInput = findByAttr(doc.root, "data-control", "composer-request");
      if (reqInput) {
        reqInput.value = "Build interactive workbench <svg onload=alert(1)>";
        reqInput.dispatch("input");
      }
      const createBtn = findByAttr(doc.root, "data-action", "create-task");
      createBtn?.click();
      await waitFor(() =>
        doc.root.textContent.includes(
          "Build interactive workbench <svg onload=alert(1)>",
        ),
      );
      const svgs = findAll(doc.root, (el) => el.tagName === "SVG");
      expect(svgs.length).toBe(0);

      // 6. Embedded Team Chat pane opens, sends message, and keeps untrusted HTML inert
      const teamToggle = findByAttr(
        doc.root,
        "data-action",
        "toggle-team-chat",
      );
      expect(teamToggle).toBeDefined();
      expect(teamToggle?.attributes.has("disabled")).toBe(false);
      teamToggle?.click();
      await waitFor(
        () => findByAttr(doc.root, "data-panel", "team-chat") !== undefined,
      );

      const teamComposer = findByAttr(
        doc.root,
        "data-focus-key",
        "team-composer",
      );
      expect(teamComposer).toBeDefined();
      if (teamComposer) {
        teamComposer.value = "Shipping shell update <script>xss()</script>";
        teamComposer.dispatch("input");
      }
      const sendBtn = findAll(
        doc.root,
        (el) => el.tagName === "BUTTON" && el.textContent === "Send message",
      )[0];
      sendBtn?.click();
      await waitFor(() =>
        doc.root.textContent.includes(
          "Shipping shell update <script>xss()</script>",
        ),
      );
      const scripts = findAll(doc.root, (el) => el.tagName === "SCRIPT");
      expect(scripts.length).toBe(0);
    } finally {
      close();
    }
  });

  test("tampered patch export artifact is rejected by renderer SHA-256 verification", async () => {
    const fixture = (await loadFixtureData()) as FixtureData;
    const detail = fixture.details["fixture-completed-verified"];
    const diff = detail?.diff;
    const expectedPatchSha = detail?.verification?.patch_sha256;
    expect(diff).toBeDefined();
    expect(expectedPatchSha).toBeDefined();
    if (!diff || !expectedPatchSha) return;

    const tamperedBridge: ShellBridge = {
      "workbench.describe": async () => ({
        ok: true,
        result: fixture.describe,
      }),
      "tasks.list": async () => ({ ok: true, result: fixture.tasks }),
      "tasks.inspect": async ({ task_id }) => {
        const task = fixture.tasks.find((t) => t.task_id === task_id);
        return task
          ? { ok: true, result: task }
          : { ok: false, error: { kind: "not_found", message: "Not found" } };
      },
      "tasks.events": async ({ task_id }) => ({
        ok: true,
        result: fixture.details[task_id]?.events ?? [],
      }),
      "tasks.artifact": async () => ({
        ok: true,
        result: {
          artifact_id: "art-tampered",
          media_type: "text/x-diff",
          data_base64: Buffer.from("tampered diff bytes", "utf8").toString(
            "base64",
          ),
        },
      }),
      "tasks.diff": async ({ task_id }) => {
        const d = fixture.details[task_id]?.diff;
        return d
          ? { ok: true, result: d }
          : { ok: false, error: { kind: "not_found", message: "Not found" } };
      },
      "tasks.verification": async ({ task_id }) => {
        const v = fixture.details[task_id]?.verification;
        return v
          ? { ok: true, result: v }
          : { ok: false, error: { kind: "not_found", message: "Not found" } };
      },
      "tasks.evidence": async ({ task_id }) => {
        const e = fixture.details[task_id]?.evidence;
        return e
          ? { ok: true, result: e }
          : { ok: false, error: { kind: "not_found", message: "Not found" } };
      },
      "tasks.journal": async () => ({ ok: true, result: [] }),
      "tasks.create": async () => ({
        ok: false,
        error: { kind: "refused", message: "refused" },
      }),
      "tasks.start": async () => ({
        ok: false,
        error: { kind: "refused", message: "refused" },
      }),
      "tasks.resume": async () => ({
        ok: false,
        error: { kind: "refused", message: "refused" },
      }),
      "tasks.steer": async () => ({
        ok: false,
        error: { kind: "refused", message: "refused" },
      }),
      "tasks.cancel": async () => ({
        ok: false,
        error: { kind: "refused", message: "refused" },
      }),
      "tasks.export": async () => ({
        ok: true,
        result: {
          candidate: {
            workspace_id: "ws-fixture",
            provider: "local",
            revision: "fixture-r5",
          },
          patch_sha256: expectedPatchSha,
          artifact: {
            artifact_id: "art-tampered",
            media_type: "text/x-diff",
            byte_length: 19,
            sha256: expectedPatchSha,
          },
          files: diff.files.length,
          verification: "verified",
          verified: true,
          verdict_run_id: "ver-fixture-5",
          round_trip: { status: "passed", reason: null },
          unsupported: [],
        },
      }),
    };

    const doc = new MiniDocument();
    const controller = createController(tamperedBridge, doc, doc.root);
    await controller.load();

    findByAttr(doc.root, "data-task-id", "fixture-completed-verified")?.click();
    await waitFor(
      () => findByAttr(doc.root, "data-action", "export-patch") !== undefined,
    );
    const exportBtn = findByAttr(doc.root, "data-action", "export-patch");
    exportBtn?.click();
    await waitFor(() =>
      doc.root.textContent.includes("failed SHA-256 verification"),
    );
    expect(
      findByAttr(doc.root, "data-export-verified", "true"),
    ).toBeUndefined();
    expect(doc.root.textContent).not.toContain("tampered diff bytes");
  });

  test("regression: export rejects exported.verified=false and failed artifact fetches", async () => {
    const fixture = (await loadFixtureData()) as FixtureData;
    const detail = fixture.details["fixture-completed-verified"];
    const diff = detail?.diff;
    const expectedPatchSha = detail?.verification?.patch_sha256;
    if (!diff || !expectedPatchSha) throw new Error("missing fixture diff");

    let failArtifact = false;
    let verifiedFlag = false;
    let receivedExpectedSha: string | undefined;

    const mockBridge: ShellBridge = {
      "workbench.describe": async () => ({
        ok: true,
        result: fixture.describe,
      }),
      "tasks.list": async () => ({ ok: true, result: fixture.tasks }),
      "tasks.inspect": async ({ task_id }) => {
        const task = fixture.tasks.find((t) => t.task_id === task_id);
        return task
          ? { ok: true, result: task }
          : { ok: false, error: { kind: "not_found", message: "Not found" } };
      },
      "tasks.events": async ({ task_id }) => ({
        ok: true,
        result: fixture.details[task_id]?.events ?? [],
      }),
      "tasks.artifact": async () =>
        failArtifact
          ? {
              ok: false,
              error: { kind: "not_found", message: "Artifact expired" },
            }
          : {
              ok: true,
              result: {
                artifact_id: "art-ok",
                media_type: "text/x-diff",
                data_base64: Buffer.from("patch", "utf8").toString("base64"),
              },
            },
      "tasks.diff": async ({ task_id }) => {
        const d = fixture.details[task_id]?.diff;
        return d
          ? { ok: true, result: { ...d, digest: "a".repeat(64) } }
          : { ok: false, error: { kind: "not_found", message: "Not found" } };
      },
      "tasks.verification": async ({ task_id }) => {
        const v = fixture.details[task_id]?.verification;
        return v
          ? { ok: true, result: v }
          : { ok: false, error: { kind: "not_found", message: "Not found" } };
      },
      "tasks.evidence": async ({ task_id }) => {
        const e = fixture.details[task_id]?.evidence;
        return e
          ? { ok: true, result: e }
          : { ok: false, error: { kind: "not_found", message: "Not found" } };
      },
      "tasks.journal": async () => ({ ok: true, result: [] }),
      "tasks.create": async () => ({
        ok: false,
        error: { kind: "refused", message: "refused" },
      }),
      "tasks.start": async () => ({
        ok: false,
        error: { kind: "refused", message: "refused" },
      }),
      "tasks.resume": async () => ({
        ok: false,
        error: { kind: "refused", message: "refused" },
      }),
      "tasks.steer": async () => ({
        ok: false,
        error: { kind: "refused", message: "refused" },
      }),
      "tasks.cancel": async () => ({
        ok: false,
        error: { kind: "refused", message: "refused" },
      }),
      "tasks.export": async (params) => {
        receivedExpectedSha = params.expected_patch_sha256;
        return {
          ok: true,
          result: {
            candidate: {
              workspace_id: "ws-fixture",
              provider: "local",
              revision: "fixture-r5",
            },
            patch_sha256: expectedPatchSha,
            artifact: {
              artifact_id: "art-ok",
              media_type: "text/x-diff",
              byte_length: 5,
              sha256: expectedPatchSha,
            },
            files: diff.files.length,
            verification: "verified",
            verified: verifiedFlag,
            verdict_run_id: "ver-fixture-5",
            round_trip: { status: "passed", reason: null },
            unsupported: [],
          },
        };
      },
    };

    const doc = new MiniDocument();
    const controller = createController(mockBridge, doc, doc.root);
    await controller.load();
    findByAttr(doc.root, "data-task-id", "fixture-completed-verified")?.click();
    await waitFor(
      () => findByAttr(doc.root, "data-action", "export-patch") !== undefined,
    );

    // 1. exported.verified === false must fail and pass verification.patch_sha256 (not diff.digest)
    findByAttr(doc.root, "data-action", "export-patch")?.click();
    await waitFor(() =>
      doc.root.textContent.includes(
        "Exported patch was not confirmed as host-verified.",
      ),
    );
    expect(receivedExpectedSha).toBe(expectedPatchSha);
    expect(receivedExpectedSha).not.toBe("a".repeat(64));
    expect(
      findByAttr(doc.root, "data-export-verified", "true"),
    ).toBeUndefined();

    // 2. Artifact fetch failure must fail instead of displaying verified success
    verifiedFlag = true;
    failArtifact = true;
    findByAttr(doc.root, "data-action", "export-patch")?.click();
    await waitFor(() =>
      doc.root.textContent.includes(
        "Failed to fetch exported patch artifact for SHA-256 verification.",
      ),
    );
    expect(
      findByAttr(doc.root, "data-export-verified", "true"),
    ).toBeUndefined();
  });

  test("regression: nested payload.upstream.entry_ids loads journal entries, custom paid model resets consent, and start failure preserves created task", async () => {
    const { bridge, close } = await startTestWorkbench();
    try {
      const requestedJournalIds: string[] = [];
      let startCalls = 0;
      let lastStartModelId: string | undefined;
      const nestedPayloadJson = JSON.stringify({
        upstream: { entry_ids: ["journal-nested-1"] },
      });
      const nestedPayloadBytes = Buffer.from(nestedPayloadJson, "utf8");
      const nestedPayloadSha = createHash("sha256")
        .update(nestedPayloadBytes)
        .digest("hex");
      const wrappedBridge: ShellBridge = {
        ...bridge,
        "tasks.events": async (params) => {
          if (params.after_event_id === "evt-nested-journal") {
            return { ok: true, result: [] };
          }
          const res = await bridge["tasks.events"](params);
          if (!res.ok || params.after_event_id || res.result.length === 0)
            return res;
          const baseEvent = res.result[0];
          if (!baseEvent) return res;
          return {
            ok: true,
            result: [
              ...res.result,
              {
                ...baseEvent,
                event_id: "evt-nested-journal",
                sequence: 999,
                event_type: "execution.observed",
                payload: {
                  artifact_id: "art-nested-journal",
                  media_type: "application/json",
                  byte_length: nestedPayloadBytes.byteLength,
                  sha256: nestedPayloadSha,
                },
              },
            ],
          };
        },
        "tasks.artifact": async (params) => {
          if (params.artifact.artifact_id === "art-nested-journal") {
            return {
              ok: true,
              result: {
                artifact_id: "art-nested-journal",
                media_type: "application/json",
                byte_length: nestedPayloadBytes.byteLength,
                sha256: nestedPayloadSha,
                data_base64: nestedPayloadBytes.toString("base64"),
              },
            };
          }
          return bridge["tasks.artifact"](params);
        },
        "tasks.journal": async (params) => {
          requestedJournalIds.push(...params.entry_ids);
          return bridge["tasks.journal"](params);
        },
        "tasks.start": async (params) => {
          startCalls += 1;
          lastStartModelId = params.model_id;
          if (startCalls === 1) {
            return {
              ok: false,
              error: { kind: "conflict", message: "Start failed once" },
            };
          }
          return bridge["tasks.start"](params);
        },
      };

      const doc = new MiniDocument();
      const controller = createController(wrappedBridge, doc, doc.root);
      await controller.load();
      findByAttr(
        doc.root,
        "data-task-id",
        "fixture-completed-verified",
      )?.click();
      await waitFor(() => requestedJournalIds.includes("journal-nested-1"));

      // Nested upstream.entry_ids must be requested from tasks.journal
      expect(requestedJournalIds).toContain("journal-nested-1");

      // Create & start with custom paid model ID: first start fails, task is preserved and composer resets
      const reqInput = findByAttr(doc.root, "data-control", "composer-request");
      if (reqInput) {
        reqInput.value = "Verify start failure recovery";
        reqInput.dispatch("input");
      }
      const startNow = findByAttr(
        doc.root,
        "data-control",
        "composer-start-now",
      );
      if (startNow) {
        startNow.checked = true;
        startNow.dispatch("change");
      }
      const composerModel = findByAttr(
        doc.root,
        "data-control",
        "composer-model",
      );
      if (composerModel) {
        composerModel.value = "paid";
        composerModel.dispatch("change");
      }
      await waitFor(
        () =>
          findByAttr(doc.root, "data-control", "composer-paid-model-id") !==
          undefined,
      );
      const paidModelInput = findByAttr(
        doc.root,
        "data-control",
        "composer-paid-model-id",
      );
      if (paidModelInput) {
        paidModelInput.value = "openai/gpt-5.4-pro";
        paidModelInput.dispatch("input");
      }
      const consent = findByAttr(
        doc.root,
        "data-control",
        "composer-paid-consent",
      );
      if (consent) {
        consent.checked = true;
        consent.dispatch("change");
      }
      // Editing paid model ID clears consent again and preserves caret position
      const paidModelInputAgain = findByAttr(
        doc.root,
        "data-control",
        "composer-paid-model-id",
      );
      if (paidModelInputAgain) {
        paidModelInputAgain.focus();
        paidModelInputAgain.value = "anthropic/claude-opus-4-5";
        paidModelInputAgain.setSelectionRange(10, 10, "forward");
        paidModelInputAgain.dispatch("input");
      }
      const paidModelInputAfter = findByAttr(
        doc.root,
        "data-control",
        "composer-paid-model-id",
      );
      expect(doc.activeElement).toBe(paidModelInputAfter ?? null);
      expect(paidModelInputAfter?.selectionStart).toBe(10);
      expect(paidModelInputAfter?.selectionEnd).toBe(10);
      expect(
        findByAttr(doc.root, "data-action", "create-task")?.attributes.has(
          "disabled",
        ),
      ).toBe(true);
      const consentAgain = findByAttr(
        doc.root,
        "data-control",
        "composer-paid-consent",
      );
      if (consentAgain) {
        consentAgain.checked = true;
        consentAgain.dispatch("change");
      }
      findByAttr(doc.root, "data-action", "create-task")?.click();
      await waitFor(() =>
        doc.root.textContent.includes(
          "Task created, but failed to start: Start failed once",
        ),
      );
      expect(lastStartModelId).toBe("anthropic/claude-opus-4-5");
      // Composer was cleared so user does not accidentally create duplicates
      const clearedReq = findByAttr(
        doc.root,
        "data-control",
        "composer-request",
      );
      expect(clearedReq?.value ?? "").toBe("");
    } finally {
      close();
    }
  });

  test("regression: Team Chat paginates through real bridge cursors and keeps the cursor across a send", async () => {
    const { bridge, close } = await startTestWorkbench();
    try {
      const service = new FixtureTeamService();
      const teamBridge = createTeamChatBridge({ service });
      const baseTeam = toShellTeamChat(teamBridge);
      const initial = await baseTeam["team.state"]({});
      expect(initial.ok).toBe(true);
      if (!initial.ok) return;
      const convId = initial.value.conversations[0]?.conversation_id;
      if (!convId) throw new Error("fixture has no conversation");
      // 45 seeded + fixture history = at least three 20-message pages.
      for (let i = 1; i <= 45; i++) {
        const sent = await baseTeam["team.send"]({
          input: {
            conversation_id: convId,
            body: `History message ${String(i).padStart(2, "0")}`,
            client_message_id: `seed-${i}`,
            reply_to: null,
            references: [],
          },
        });
        expect(sent.ok).toBe(true);
      }
      const seeded = await baseTeam["team.state"]({});
      expect(seeded.ok && seeded.value.conversations[0]?.conversation_id).toBe(
        convId,
      );

      const openCalls: Array<{ before: string | null; older: string | null }> =
        [];
      const spyTeam: TeamChatBridgeApi = {
        ...baseTeam,
        "team.open": async (params) => {
          const res = await baseTeam["team.open"](params);
          openCalls.push({
            before: params.before ?? null,
            older: res.ok ? res.value.older_cursor : null,
          });
          return res;
        },
      };

      const renderedIds = (doc: MiniDocument) =>
        findAll(doc.root, (el) => el.getAttribute("data-message-id") !== null)
          .map((el) => el.getAttribute("data-message-id"))
          .filter((id): id is string => typeof id === "string");
      const pageIds = async (before: string | null) => {
        const page = await baseTeam["team.open"]({
          conversation_id: convId,
          ...(before ? { before } : {}),
        });
        if (!page.ok) throw new Error(`team.open failed: ${page.code}`);
        return {
          ids: page.value.messages.map((m) => m.message_id),
          older: page.value.older_cursor,
        };
      };

      const doc = new MiniDocument();
      const controller = createController(bridge, doc, doc.root, spyTeam);
      await controller.load();
      findByAttr(doc.root, "data-action", "toggle-team-chat")?.click();
      await waitFor(
        () =>
          findByAttr(doc.root, "data-action", "team-load-older") !== undefined,
      );

      // Page 1 (newest) is rendered; older history is not.
      const page1 = await pageIds(null);
      expect(page1.older).not.toBeNull();
      expect(renderedIds(doc)).toEqual(page1.ids);
      expect(doc.root.textContent).toContain("History message 45");
      expect(doc.root.textContent).not.toContain("History message 25");

      // Load page 2 through the real cursor.
      findByAttr(doc.root, "data-action", "team-load-older")?.click();
      await waitFor(() => doc.root.textContent.includes("History message 25"));
      const page2 = await pageIds(page1.older);
      expect(page2.older).not.toBeNull();
      expect(openCalls.at(-1)?.before).toBe(page1.older);
      expect(renderedIds(doc)).toEqual([...page2.ids, ...page1.ids]);
      expect(
        findByAttr(doc.root, "data-action", "team-load-older"),
      ).toBeDefined();

      // Send while older history remains: loaded history and the page-2 cursor survive.
      const composer = findByAttr(doc.root, "data-focus-key", "team-composer");
      if (!composer) throw new Error("composer missing");
      composer.value = "Fresh message while history remains";
      composer.dispatch("input");
      findAll(
        doc.root,
        (el) => el.tagName === "BUTTON" && el.textContent === "Send message",
      )[0]?.click();
      await waitFor(() =>
        doc.root.textContent.includes("Fresh message while history remains"),
      );
      expect(doc.root.textContent).toContain("History message 06");
      expect(
        findByAttr(doc.root, "data-action", "team-load-older"),
      ).toBeDefined();
      const afterSend = renderedIds(doc);
      expect(afterSend.slice(0, page2.ids.length + page1.ids.length)).toEqual([
        ...page2.ids,
        ...page1.ids,
      ]);
      expect(afterSend.length).toBe(page2.ids.length + page1.ids.length + 1);

      // The preserved cursor fetches page 3, the next older page.
      findByAttr(doc.root, "data-action", "team-load-older")?.click();
      const page3 = await pageIds(page2.older);
      expect(page3.ids.length).toBeGreaterThan(0);
      await waitFor(() => renderedIds(doc).includes(page3.ids[0] ?? ""));
      expect(openCalls.at(-1)?.before).toBe(page2.older);
      expect(doc.root.textContent).toContain("History message 05");
      const all = renderedIds(doc);
      expect(all.slice(0, page3.ids.length)).toEqual(page3.ids);
      expect(new Set(all).size).toBe(all.length);

      // Reacting to an older message keeps loaded history in place.
      const olderReactionBtn = findAll(
        doc.root,
        (el) =>
          el.tagName === "BUTTON" &&
          el.attributes.get("data-reaction") === "👍",
      )[0];
      olderReactionBtn?.click();
      await waitFor(
        () =>
          findAll(
            doc.root,
            (el) =>
              el.tagName === "BUTTON" &&
              el.attributes.get("data-reaction") === "👍",
          )[0]?.attributes.get("aria-pressed") === "true",
      );
      expect(renderedIds(doc)).toEqual(all);

      // Never show one conversation's draft in another; restore it on return.
      const draftBox = findByAttr(doc.root, "data-focus-key", "team-composer");
      if (draftBox) {
        draftBox.value = "Sensitive draft for thread A";
        draftBox.dispatch("input");
      }
      const convButtons = findAll(
        doc.root,
        (el) =>
          el.tagName === "BUTTON" &&
          el.attributes.get("data-conversation-id") !== undefined &&
          el.attributes.get("aria-pressed") !== "true",
      );
      expect(convButtons.length).toBeGreaterThan(0);
      convButtons[0]?.click();
      await waitFor(
        () =>
          (findByAttr(doc.root, "data-focus-key", "team-composer")?.value ??
            "") === "",
      );
      findByAttr(doc.root, "data-conversation-id", convId)?.click();
      await waitFor(
        () =>
          findByAttr(doc.root, "data-focus-key", "team-composer")?.value ===
          "Sensitive draft for thread A",
      );
    } finally {
      close();
    }
  });

  test("regression: an oversized Team Chat message keeps the composer and draft for edit and retry", async () => {
    expect(TEAM_CHAT_MAX_MESSAGE_CHARS).toBe(MAX_MESSAGE_CHARS);
    const { bridge, close } = await startTestWorkbench();
    try {
      const teamBridge = createTeamChatBridge({
        service: new FixtureTeamService(),
      });
      const baseTeam = toShellTeamChat(teamBridge);
      const sends: string[] = [];
      const spyTeam: TeamChatBridgeApi = {
        ...baseTeam,
        "team.send": async (params) => {
          sends.push(params.input.body);
          return baseTeam["team.send"](params);
        },
      };
      const doc = new MiniDocument();
      const controller = createController(bridge, doc, doc.root, spyTeam);
      await controller.load();
      findByAttr(doc.root, "data-action", "toggle-team-chat")?.click();
      await waitFor(
        () =>
          findByAttr(doc.root, "data-focus-key", "team-composer") !== undefined,
      );
      const sendBtn = () =>
        findAll(
          doc.root,
          (el) => el.tagName === "BUTTON" && el.textContent === "Send message",
        )[0];
      const composer = () =>
        findByAttr(doc.root, "data-focus-key", "team-composer");
      const messageCount = () =>
        findAll(doc.root, (el) => el.getAttribute("data-message-id") !== null)
          .length;
      const before = messageCount();

      const oversized = "x".repeat(MAX_MESSAGE_CHARS + 1);
      const box = composer();
      if (!box) throw new Error("composer missing");
      box.value = oversized;
      box.dispatch("input");
      sendBtn()?.click();
      await waitFor(
        () => findByAttr(doc.root, "data-team-notice", "true") !== undefined,
      );
      expect(
        findByAttr(doc.root, "data-team-notice", "true")?.textContent,
      ).toContain("too long");
      expect(composer()?.value).toBe(oversized);
      expect(sendBtn()).toBeDefined();
      expect(messageCount()).toBe(before);
      expect(sends).toEqual([]);

      // The bridge rejects the same body if it ever reaches the host.
      const direct = await baseTeam["team.send"]({
        input: {
          conversation_id:
            findAll(
              doc.root,
              (el) =>
                el.getAttribute("aria-pressed") === "true" &&
                el.getAttribute("data-conversation-id") !== null,
            )[0]?.getAttribute("data-conversation-id") ?? "",
          body: oversized,
          client_message_id: "direct-oversized",
          reply_to: null,
          references: [],
        },
      });
      expect(direct.ok).toBe(false);

      // Edit and retry succeeds, clearing the notice and the draft.
      const edited = composer();
      if (!edited) throw new Error("composer missing after rejection");
      edited.value = "Shortened message after edit";
      edited.dispatch("input");
      sendBtn()?.click();
      await waitFor(() =>
        doc.root.textContent.includes("Shortened message after edit"),
      );
      expect(findByAttr(doc.root, "data-team-notice", "true")).toBeUndefined();
      expect(composer()?.value ?? "").toBe("");
      expect(sends).toEqual(["Shortened message after edit"]);
    } finally {
      close();
    }
  });

  test("regression: a bridge-rejected Team Chat send keeps the composer and draft", async () => {
    const { bridge, close } = await startTestWorkbench();
    try {
      const baseTeam = toShellTeamChat(
        createTeamChatBridge({ service: new FixtureTeamService() }),
      );
      const rejectingTeam: TeamChatBridgeApi = {
        ...baseTeam,
        "team.send": async () => ({ ok: false, code: "invalid" }),
      };
      const doc = new MiniDocument();
      const controller = createController(bridge, doc, doc.root, rejectingTeam);
      await controller.load();
      findByAttr(doc.root, "data-action", "toggle-team-chat")?.click();
      await waitFor(
        () =>
          findByAttr(doc.root, "data-focus-key", "team-composer") !== undefined,
      );
      const box = findByAttr(doc.root, "data-focus-key", "team-composer");
      if (!box) throw new Error("composer missing");
      box.value = "Draft the host refuses";
      box.dispatch("input");
      findAll(
        doc.root,
        (el) => el.tagName === "BUTTON" && el.textContent === "Send message",
      )[0]?.click();
      await waitFor(
        () => findByAttr(doc.root, "data-team-notice", "true") !== undefined,
      );
      expect(
        findByAttr(doc.root, "data-team-notice", "true")?.textContent,
      ).toContain("invalid");
      expect(
        findByAttr(doc.root, "data-focus-key", "team-composer")?.value,
      ).toBe("Draft the host refuses");
    } finally {
      close();
    }
  });

  test("regression: Team Chat sends after a renderer reload use fresh client_message_ids", async () => {
    const { bridge, close } = await startTestWorkbench();
    try {
      // One host service outlives both renderer loads, as in the desktop app.
      const baseTeam = toShellTeamChat(
        createTeamChatBridge({ service: new FixtureTeamService() }),
      );
      const sentIds: string[] = [];
      const spyTeam: TeamChatBridgeApi = {
        ...baseTeam,
        "team.send": async (params) => {
          sentIds.push(params.input.client_message_id);
          return baseTeam["team.send"](params);
        },
      };
      const sendFromFreshRenderer = async (bodies: string[]) => {
        const doc = new MiniDocument();
        const controller = createController(bridge, doc, doc.root, spyTeam);
        await controller.load();
        findByAttr(doc.root, "data-action", "toggle-team-chat")?.click();
        await waitFor(
          () =>
            findByAttr(doc.root, "data-focus-key", "team-composer") !==
            undefined,
        );
        for (const body of bodies) {
          const before = findAll(
            doc.root,
            (el) => el.getAttribute("data-message-id") !== null,
          ).length;
          const box = findByAttr(doc.root, "data-focus-key", "team-composer");
          if (!box) throw new Error("composer missing");
          box.value = body;
          box.dispatch("input");
          findAll(
            doc.root,
            (el) =>
              el.tagName === "BUTTON" && el.textContent === "Send message",
          )[0]?.click();
          await waitFor(
            () =>
              findAll(
                doc.root,
                (el) => el.getAttribute("data-message-id") !== null,
              ).length > before ||
              findByAttr(doc.root, "data-team-notice", "true") !== undefined,
          );
          expect(
            findByAttr(doc.root, "data-team-notice", "true"),
          ).toBeUndefined();
          expect(
            findByAttr(doc.root, "data-focus-key", "team-composer")?.value ??
              "",
          ).toBe("");
        }
      };

      await sendFromFreshRenderer(["Before reload", "Same text"]);
      // Reload: a new renderer with a new controller, same host service.
      await sendFromFreshRenderer(["Different text after reload", "Same text"]);

      expect(sentIds).toHaveLength(4);
      expect(new Set(sentIds).size).toBe(4);
      const state = await baseTeam["team.state"]({});
      if (!state.ok) throw new Error(`team.state failed: ${state.code}`);
      const convId = state.value.conversations[0]?.conversation_id ?? "";
      const page = await baseTeam["team.open"]({
        conversation_id: convId,
        limit: 4,
      });
      if (!page.ok) throw new Error(`team.open failed: ${page.code}`);
      expect(page.value.messages.map((m) => m.body)).toEqual([
        "Before reload",
        "Same text",
        "Different text after reload",
        "Same text",
      ]);
    } finally {
      close();
    }
  });

  test("regression: renderer refuses to present an unverified bridge export as verified", async () => {
    let actualSha = "";
    const { data, bridge, close } = await startTestWorkbench((fixture) => {
      const verifiedDiff = fixture.details["fixture-completed-verified"]?.diff;
      const target = fixture.details["fixture-completed-unverified"];
      if (!verifiedDiff || !target) throw new Error("missing fixture detail");
      target.diff = structuredClone(verifiedDiff);
      actualSha = sha256Hex(canonicalPatchBytes(target.diff));
    });
    try {
      const revision =
        data.details["fixture-completed-unverified"]?.verification.candidate
          ?.revision;
      if (!revision) throw new Error("missing candidate revision");
      const exportCalls: Array<{
        expected_revision: string;
        expected_patch_sha256: string;
        verified: boolean | undefined;
      }> = [];

      // Honest host state: the export action stays disabled.
      const honestDoc = new MiniDocument();
      await createController(bridge, honestDoc, honestDoc.root).load();
      findByAttr(
        honestDoc.root,
        "data-task-id",
        "fixture-completed-unverified",
      )?.click();
      await waitFor(
        () =>
          findByAttr(honestDoc.root, "data-action", "export-patch") !==
          undefined,
      );
      expect(
        findByAttr(honestDoc.root, "data-action", "export-patch")?.getAttribute(
          "disabled",
        ),
      ).not.toBeNull();

      // A stale or spoofed "verified" view must still be refused once the
      // bridge returns the real unverified verdict.
      const spoofed: ShellBridge = {
        ...bridge,
        "tasks.verification": async (params) => {
          const res = await bridge["tasks.verification"](params);
          if (!res.ok || params.task_id !== "fixture-completed-unverified")
            return res;
          return {
            ok: true,
            result: {
              ...res.result,
              state: "verified",
              patch_sha256: actualSha,
            },
          };
        },
        "tasks.export": async (params) => {
          const res = await bridge["tasks.export"](params);
          exportCalls.push({
            expected_revision: params.expected_revision,
            expected_patch_sha256: params.expected_patch_sha256,
            verified: res.ok ? res.result.verified : undefined,
          });
          return res;
        },
      };
      const doc = new MiniDocument();
      await createController(spoofed, doc, doc.root).load();
      findByAttr(
        doc.root,
        "data-task-id",
        "fixture-completed-unverified",
      )?.click();
      await waitFor(() => {
        const btn = findByAttr(doc.root, "data-action", "export-patch");
        return btn !== undefined && btn.getAttribute("disabled") === null;
      });
      findByAttr(doc.root, "data-action", "export-patch")?.click();
      await waitFor(() =>
        doc.root.textContent.includes(
          "Exported patch was not confirmed as host-verified.",
        ),
      );
      expect(exportCalls).toEqual([
        {
          expected_revision: revision,
          expected_patch_sha256: actualSha,
          verified: false,
        },
      ]);
      expect(
        findByAttr(doc.root, "data-export-verified", "true"),
      ).toBeUndefined();
    } finally {
      close();
    }
  });

  test("transcript renders transcript-wide token totals and cost when available", () => {
    const doc = new MiniDocument();
    const base: TranscriptProjection = {
      entries: [
        {
          kind: "user",
          id: "request:t1",
          text: "Do the thing",
          source: "request",
          provenance: { source: "tasks.inspect.request", event_id: null },
        },
      ],
      trimmed: 0,
      totals: { input_tokens: 1200, output_tokens: 345, cost_usd: 0.0123 },
      children: 0,
      verify: { pass: 0, fail: 0 },
      journal: null,
    } as unknown as TranscriptProjection;
    const totalsText = (projection: TranscriptProjection) => {
      const root = doc.createElement("div");
      for (const node of renderTranscript(doc, projection, 3))
        root.append(node);
      return findByAttr(
        root as unknown as MiniElement,
        "data-transcript-totals",
        "true",
      )?.textContent;
    };
    expect(totalsText(base)).toBe(
      "Transcript usage · 1200 in / 345 out tokens · $0.0123",
    );
    expect(
      totalsText({
        ...base,
        totals: { input_tokens: 10, output_tokens: 5, cost_usd: null },
      }),
    ).toBe("Transcript usage · 10 in / 5 out tokens");
    expect(
      totalsText({
        ...base,
        totals: { input_tokens: 0, output_tokens: 0, cost_usd: null },
      }),
    ).toBeUndefined();
  });
  test("regression: more than 100 journal IDs are fetched in schema-sized batches", async () => {
    expect(JOURNAL_BATCH_SIZE).toBe(MAX_JOURNAL_ENTRY_IDS);
    const { bridge, close } = await startTestWorkbench();
    try {
      const ids = Array.from({ length: 150 }, (_, i) => `journal-${i}`);
      const batches: Array<{ size: number; ok: boolean }> = [];
      const base = withSyntheticEvents(bridge, "fixture-completed-verified", [
        { upstream: { entry_ids: ids } },
      ]);
      const wrapped: ShellBridge = {
        ...base,
        "tasks.journal": async (params) => {
          const res = await bridge["tasks.journal"](params);
          batches.push({ size: params.entry_ids.length, ok: res.ok });
          if (!res.ok) return res;
          return {
            ok: true,
            result: res.result.map((entry) => ({
              entry_id: entry.entry_id,
              kind: "assistant",
              text: `Journal text for ${entry.entry_id}.`,
            })),
          };
        },
      };
      // The real bridge schema still rejects an oversized batch.
      const oversized = await bridge["tasks.journal"]({
        task_id: "fixture-completed-verified",
        entry_ids: ids,
      });
      expect(oversized.ok).toBe(false);

      const doc = new MiniDocument();
      const controller = createController(wrapped, doc, doc.root);
      await controller.load();
      findByAttr(
        doc.root,
        "data-task-id",
        "fixture-completed-verified",
      )?.click();
      await waitFor(() => batches.length >= 2);
      await controller.settled();
      expect(batches).toEqual([
        { size: 100, ok: true },
        { size: 50, ok: true },
      ]);
      expect(doc.root.textContent).toContain("Journal text for journal-0.");
      expect(doc.root.textContent).toContain("Journal text for journal-149.");
    } finally {
      close();
    }
  });

  test("regression: event payload hydration is bounded, concurrent, and cached across refreshes", async () => {
    const { bridge, close } = await startTestWorkbench();
    try {
      const fetched: string[] = [];
      let inFlight = 0;
      let peak = 0;
      const wrapped = withSyntheticEvents(
        bridge,
        "fixture-completed-verified",
        Array.from({ length: 400 }, (_, i) => ({ index: i })),
        {
          onArtifact: async (artifactId) => {
            fetched.push(artifactId);
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 1));
            inFlight--;
          },
        },
      );
      const doc = new MiniDocument();
      const controller = createController(wrapped, doc, doc.root);
      await controller.load();
      findByAttr(
        doc.root,
        "data-task-id",
        "fixture-completed-verified",
      )?.click();
      await waitFor(() => fetched.length >= MAX_HYDRATED_EVENT_PAYLOADS, 5000);
      await controller.settled();
      expect(fetched.length).toBe(MAX_HYDRATED_EVENT_PAYLOADS);
      expect(fetched).not.toContain("art-synthetic-0");
      expect(fetched).toContain("art-synthetic-399");
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(6);

      await controller.load();
      await controller.settled();
      expect(fetched.length).toBe(MAX_HYDRATED_EVENT_PAYLOADS);
    } finally {
      close();
    }
  });

  test("regression: a completed task's verified final text/plain artifact appears in the transcript", async () => {
    const finalBody = "Final answer from the verified artifact.";
    const finalBytes = Buffer.from(finalBody, "utf8");
    const finalRef = {
      artifact_id: "artifact-final-answer",
      media_type: "text/plain; charset=utf-8",
      byte_length: finalBytes.byteLength,
      sha256: createHash("sha256").update(finalBytes).digest("hex"),
    };
    const addFinal = (tamper: boolean) => (fixture: FixtureData) => {
      const task = fixture.tasks.find(
        (t) => t.task_id === "fixture-completed-verified",
      );
      if (!task) throw new Error("missing fixture task");
      task.artifacts = [...task.artifacts, finalRef];
      fixture.artifact_data[finalRef.artifact_id] = {
        media_type: finalRef.media_type,
        data_base64: (tamper
          ? Buffer.from("Tampered final answer.", "utf8")
          : finalBytes
        ).toString("base64"),
      };
    };
    for (const tamper of [false, true]) {
      const { bridge, close } = await startTestWorkbench(addFinal(tamper));
      try {
        const doc = new MiniDocument();
        const controller = createController(bridge, doc, doc.root);
        await controller.load();
        findByAttr(
          doc.root,
          "data-task-id",
          "fixture-completed-verified",
        )?.click();
        await waitFor(() =>
          doc.root.textContent.includes("Task fixture-completed-verified"),
        );
        await controller.settled();
        const transcript = findAll(
          doc.root,
          (el) => el.getAttribute("class") === "transcript",
        )[0];
        if (!transcript) throw new Error("transcript missing");
        if (tamper) {
          expect(transcript.textContent).not.toContain(
            "Tampered final answer.",
          );
          expect(transcript.textContent).not.toContain(finalBody);
        } else {
          expect(transcript.textContent).toContain(finalBody);
        }
      } finally {
        close();
      }
    }
  });

  test.each(["ready", "unavailable"] as const)(
    "composer shows verification readiness before starting: %s",
    async (status) => {
      const { bridge, close } = await startTestWorkbench((fixture) => {
        fixture.describe = {
          ...fixture.describe,
          checks: [{ id: "amount-totals", label: "Amount totals" }],
          verification_readiness: {
            status,
            reason:
              status === "ready"
                ? "Protected checks run in a network-disabled sandbox"
                : "Sandbox image not downloaded",
            setup: "Use Project → Set Up Verification Sandbox…",
          },
        };
      });
      try {
        const doc = new MiniDocument();
        const controller = createController(bridge, doc, doc.root);
        await controller.load();
        expect(doc.root.textContent).toContain(
          status === "ready"
            ? "Protected checks run in a network-disabled sandbox"
            : "Sandbox image not downloaded. Use Project → Set Up Verification Sandbox…",
        );
        controller.dispose();
      } finally {
        await close();
      }
    },
  );

  test("regression: desktop launches pass selected host checks as required_checks", async () => {
    const { bridge, close } = await startTestWorkbench((fixture) => {
      fixture.describe = {
        ...fixture.describe,
        capabilities: { ...fixture.describe.capabilities, execute: true },
        checks: [{ id: "unit-tests", label: "Unit tests" }],
      };
    });
    try {
      const starts: Array<Parameters<ShellBridge["tasks.start"]>[0]> = [];
      const wrapped: ShellBridge = {
        ...bridge,
        "tasks.start": async (params) => {
          starts.push(params);
          return bridge["tasks.start"](params);
        },
      };
      const doc = new MiniDocument();
      const controller = createController(wrapped, doc, doc.root);
      await controller.load();
      findByAttr(doc.root, "data-task-id", "fixture-pending")?.click();
      await waitFor(
        () =>
          findByAttr(doc.root, "data-control", "launch-check-unit-tests") !==
          undefined,
      );
      // Checks stay disabled until Execute is approved.
      expect(
        findByAttr(
          doc.root,
          "data-control",
          "launch-check-unit-tests",
        )?.getAttribute("disabled"),
      ).not.toBeNull();
      const toggle = (key: string) => {
        const box = findByAttr(doc.root, "data-control", key);
        if (!box) throw new Error(`missing ${key}`);
        box.checked = !box.checked;
        box.dispatch("change");
      };
      toggle("approval-execute");
      toggle("launch-check-unit-tests");
      expect(doc.root.textContent).toContain(
        "The host verifies the result against: Unit tests.",
      );
      findByAttr(doc.root, "data-action", "start-task")?.click();
      await waitFor(() => starts.length === 1);
      await controller.settled();
      expect(starts[0]?.required_checks).toEqual([
        { kind: "host_test", check_id: "unit-tests" },
      ]);
      expect(starts[0]?.approvals.execute).toBe(true);
      expect(doc.root.textContent).not.toContain("failed to start");

      // Composer path: create + start immediately with the same check.
      const request = findByAttr(doc.root, "data-control", "composer-request");
      if (!request) throw new Error("composer missing");
      request.value = "Run with host checks";
      request.dispatch("input");
      toggle("composer-start-now");
      toggle("composer-execute");
      toggle("composer-check-unit-tests");
      // Withdrawing Execute clears the selection, re-approving restores the control.
      toggle("composer-execute");
      expect(
        findByAttr(doc.root, "data-control", "composer-check-unit-tests")
          ?.checked,
      ).toBe(false);
      toggle("composer-execute");
      toggle("composer-check-unit-tests");
      findByAttr(doc.root, "data-action", "create-task")?.click();
      await waitFor(() => starts.length === 2);
      await controller.settled();
      expect(starts[1]?.required_checks).toEqual([
        { kind: "host_test", check_id: "unit-tests" },
      ]);
    } finally {
      close();
    }
  });

  test("regression: Team Chat search-hit reactions toggle in place and long queries keep controls", async () => {
    expect(TEAM_CHAT_MAX_SEARCH_CHARS).toBe(MAX_SEARCH_QUERY_CHARS);
    const { bridge, close } = await startTestWorkbench();
    try {
      const baseTeam = toShellTeamChat(
        createTeamChatBridge({ service: new FixtureTeamService() }),
      );
      const reactions: boolean[] = [];
      const searches: string[] = [];
      const spyTeam: TeamChatBridgeApi = {
        ...baseTeam,
        "team.setReaction": async (params) => {
          reactions.push(params.on);
          return baseTeam["team.setReaction"](params);
        },
        "team.search": async (params) => {
          searches.push(params.query);
          return baseTeam["team.search"](params);
        },
      };
      const doc = new MiniDocument();
      const controller = createController(bridge, doc, doc.root, spyTeam);
      await controller.load();
      findByAttr(doc.root, "data-action", "toggle-team-chat")?.click();
      await waitFor(
        () =>
          findByAttr(doc.root, "data-focus-key", "team-composer") !== undefined,
      );
      const searchInput = () =>
        findAll(
          doc.root,
          (el) => el.getAttribute("class") === "team-search-input",
        )[0];
      const searchBtn = () =>
        findAll(
          doc.root,
          (el) => el.getAttribute("class") === "team-search-btn",
        )[0];

      // Over-long query: inline notice, input and composer stay mounted, no host call.
      const longQuery = "q".repeat(MAX_SEARCH_QUERY_CHARS + 1);
      const input = searchInput();
      if (!input) throw new Error("search input missing");
      input.value = longQuery;
      searchBtn()?.click();
      await waitFor(
        () => findByAttr(doc.root, "data-team-notice", "true") !== undefined,
      );
      expect(
        findByAttr(doc.root, "data-team-notice", "true")?.textContent,
      ).toContain("Search is too long");
      expect(searchInput()?.value).toBe(longQuery);
      expect(
        findByAttr(doc.root, "data-focus-key", "team-composer"),
      ).toBeDefined();
      expect(searches).toEqual([]);

      // Search across conversations, then react twice on a hit.
      const retry = searchInput();
      if (!retry) throw new Error("search input missing");
      retry.value = "badge";
      searchBtn()?.click();
      await waitFor(() => doc.root.textContent.includes("Search results ("));
      expect(findByAttr(doc.root, "data-team-notice", "true")).toBeUndefined();
      const hitButton = () =>
        findAll(
          doc.root,
          (el) =>
            el.tagName === "BUTTON" &&
            el.attributes.get("data-reaction") === "🎉",
        )[0];
      expect(hitButton()?.attributes.get("aria-pressed")).not.toBe("true");
      hitButton()?.click();
      await waitFor(
        () => hitButton()?.attributes.get("aria-pressed") === "true",
      );
      hitButton()?.click();
      await waitFor(
        () => hitButton()?.attributes.get("aria-pressed") !== "true",
      );
      expect(reactions).toEqual([true, false]);
      expect(doc.root.textContent).toContain("Search results (");
    } finally {
      close();
    }
  });

  test("regression: the verified fixture patch applies with git and a hunkless patch fails the round trip", async () => {
    const { bridge, close } = await startTestWorkbench();
    const repo = await mkdtemp(join(tmpdir(), "mars-shell-apply-"));
    try {
      const diff = await bridge["tasks.diff"]({
        task_id: "fixture-completed-verified",
      });
      if (!diff.ok || !diff.result.digest) throw new Error("missing diff");
      const exported = await bridge["tasks.export"]({
        task_id: "fixture-completed-verified",
        expected_revision: "fixture-r5",
        expected_patch_sha256: diff.result.digest,
      });
      if (!exported.ok) throw new Error("export failed");
      expect(exported.result.round_trip).toEqual({
        status: "passed",
        reason: null,
      });
      const artifact = await bridge["tasks.artifact"]({
        task_id: "fixture-completed-verified",
        artifact: exported.result.artifact,
      });
      if (!artifact.ok) throw new Error("artifact failed");
      const patchPath = join(repo, "export.patch");
      await writeFile(
        patchPath,
        Buffer.from(artifact.result.data_base64, "base64"),
      );
      await writeFile(join(repo, "README.md"), "old sample\n");
      const init = spawnSync("git", ["init", "-q"], { cwd: repo });
      expect(init.status).toBe(0);
      const check = spawnSync("git", ["apply", "--check", patchPath], {
        cwd: repo,
        encoding: "utf8",
      });
      expect(check.stderr).toBe("");
      expect(check.status).toBe(0);

      const readme = (patch: string) =>
        ({
          files: [{ path: "README.md", status: "modified", patch }],
        }) as unknown as Parameters<typeof patchRoundTrip>[0];
      const baseline = { "README.md": "old sample\n" };
      expect(
        await patchRoundTrip(
          readme("--- a/README.md\n+++ b/README.md\n-old sample\n+new sample"),
          baseline,
        ),
      ).toMatchObject({ status: "failed" });
      // A well-formed hunk whose context does not match the baseline is rejected too.
      expect(
        await patchRoundTrip(
          readme(
            "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-different line\n+new sample",
          ),
          baseline,
        ),
      ).toMatchObject({ status: "failed" });
      expect(
        await patchRoundTrip(
          readme(
            "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old sample\n+new sample",
          ),
          baseline,
        ),
      ).toEqual({ status: "passed", reason: null });
      expect(
        await patchRoundTrip(
          readme(
            "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old sample\n+new sample",
          ),
          undefined,
        ),
      ).toMatchObject({ status: "unavailable" });
    } finally {
      close();
      await rm(repo, { recursive: true, force: true });
    }
  });
  test("regression: a rejected immediate launch keeps selected checks for the retry", async () => {
    const { bridge, close } = await startTestWorkbench((fixture) => {
      fixture.describe = {
        ...fixture.describe,
        capabilities: { ...fixture.describe.capabilities, execute: true },
        checks: [{ id: "unit-tests", label: "Unit tests" }],
      };
    });
    try {
      const starts: Array<Parameters<ShellBridge["tasks.start"]>[0]> = [];
      const wrapped: ShellBridge = {
        ...bridge,
        "tasks.start": async (params) => {
          starts.push(params);
          if (starts.length === 1)
            return {
              ok: false,
              error: { kind: "refused", message: "model unavailable" },
            };
          return bridge["tasks.start"](params);
        },
      };
      const doc = new MiniDocument();
      const controller = createController(wrapped, doc, doc.root);
      await controller.load();
      const toggle = (key: string) => {
        const box = findByAttr(doc.root, "data-control", key);
        if (!box) throw new Error(`missing ${key}`);
        box.checked = !box.checked;
        box.dispatch("change");
      };
      const request = findByAttr(doc.root, "data-control", "composer-request");
      if (!request) throw new Error("composer missing");
      request.value = "Launch that the host rejects first";
      request.dispatch("input");
      toggle("composer-start-now");
      toggle("composer-execute");
      toggle("composer-check-unit-tests");
      findByAttr(doc.root, "data-action", "create-task")?.click();
      await waitFor(() => doc.root.textContent.includes("failed to start"));
      await controller.settled();
      expect(
        findByAttr(doc.root, "data-control", "launch-check-unit-tests")
          ?.checked,
      ).toBe(true);
      findByAttr(doc.root, "data-action", "start-task")?.click();
      await waitFor(() => starts.length === 2);
      await controller.settled();
      expect(starts.map((params) => params.required_checks)).toEqual([
        [{ kind: "host_test", check_id: "unit-tests" }],
        [{ kind: "host_test", check_id: "unit-tests" }],
      ]);
    } finally {
      close();
    }
  });

  test("regression: launch forms cap host checks at the start schema limit", async () => {
    const tooMany = Array.from({ length: MAX_REQUIRED_CHECKS + 1 }, (_, i) => ({
      kind: "host_test" as const,
      check_id: `check-${i}`,
    }));
    const params = {
      task_id: "fixture-pending",
      expected_revision: 0,
      approvals: { read: true, write: true, execute: true },
    };
    expect(
      StartParamsSchema.safeParse({ ...params, required_checks: tooMany })
        .success,
    ).toBe(false);
    expect(
      StartParamsSchema.safeParse({
        ...params,
        required_checks: tooMany.slice(0, MAX_REQUIRED_CHECKS),
      }).success,
    ).toBe(true);

    const ids = Array.from(
      { length: MAX_REQUIRED_CHECKS + 2 },
      (_, i) => `check-${i}`,
    );
    const { bridge, close } = await startTestWorkbench((fixture) => {
      fixture.describe = {
        ...fixture.describe,
        capabilities: { ...fixture.describe.capabilities, execute: true },
        checks: ids.map((id) => ({ id, label: `Check ${id}` })),
      };
    });
    try {
      const starts: Array<Parameters<ShellBridge["tasks.start"]>[0]> = [];
      const wrapped: ShellBridge = {
        ...bridge,
        "tasks.start": async (p) => {
          starts.push(p);
          return bridge["tasks.start"](p);
        },
      };
      const doc = new MiniDocument();
      const controller = createController(wrapped, doc, doc.root);
      await controller.load();
      findByAttr(doc.root, "data-task-id", "fixture-pending")?.click();
      await waitFor(
        () =>
          findByAttr(doc.root, "data-control", "launch-check-check-0") !==
          undefined,
      );
      const box = (key: string) => findByAttr(doc.root, "data-control", key);
      const toggle = (key: string) => {
        const el = box(key);
        if (!el) throw new Error(`missing ${key}`);
        el.checked = !el.checked;
        el.dispatch("change");
      };
      toggle("approval-execute");
      for (const id of ids.slice(0, MAX_REQUIRED_CHECKS))
        toggle(`launch-check-${id}`);
      const extra = `launch-check-${ids[MAX_REQUIRED_CHECKS]}`;
      expect(box(extra)?.getAttribute("disabled")).not.toBeNull();
      expect(doc.root.textContent).toContain(
        `At most ${MAX_REQUIRED_CHECKS} checks per launch; clear one to choose another.`,
      );
      // Clearing one re-enables the rest.
      toggle("launch-check-check-0");
      expect(box(extra)?.getAttribute("disabled")).toBeNull();
      toggle(extra);
      findByAttr(doc.root, "data-action", "start-task")?.click();
      await waitFor(() => starts.length === 1);
      await controller.settled();
      expect(starts[0]?.required_checks?.length).toBe(MAX_REQUIRED_CHECKS);
      expect(doc.root.textContent).not.toContain("failed to start");
    } finally {
      close();
    }
  });
});

test("SHELL.md documents the real Team Chat channel and preload allowlist", async () => {
  const doc = await readFile(
    new URL("../../../documentation/SHELL.md", import.meta.url),
    "utf8",
  );
  expect(doc).toContain(`\`${TEAM_CHAT_CHANNEL}\``);
  expect(doc).not.toContain("`mars:team-chat`");
  const line = doc
    .split("\n")
    .find((l) => l.startsWith("Team Chat bridge methods"));
  if (!line) throw new Error("Team Chat method list missing");
  const documented = [...line.matchAll(/`(team\.[A-Za-z]+)`/g)].map(
    (m) => m[1],
  );
  expect(documented).toEqual([...TEAM_CHAT_METHODS]);
});
