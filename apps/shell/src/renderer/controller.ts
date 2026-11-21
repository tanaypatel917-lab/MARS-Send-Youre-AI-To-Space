import type { EventEnvelope, Task } from "@mars/contracts";
import type { ReactionEmoji, ReferencePreview } from "@mars/team-chat";
import { type ProjectionEvent, projectTranscript } from "@mars/ui-core";
import type { BridgeResult, ShellBridge } from "../shared/methods";
import type { TeamChatBridgeApi } from "../shared/team-chat";
import type { ShellDocument, ShellElement } from "./dom";
import type { TeamChatViewState } from "./team-chat-view";
import { verifyArtifact } from "./verify";
import {
  type ApprovalsState,
  type ArtifactView,
  type ComposerState,
  type ExportViewState,
  HEADING_FOCUS_KEY,
  type LaunchCardState,
  renderShell,
  type ShellState,
} from "./view";

const TEXT_MEDIA_TYPES = new Set(["application/json", "application/x-ndjson"]);
const MAX_RENDERED_ARTIFACT_BYTES = 256 * 1024;
const MAX_TASK_EVENTS = 1000;
const FOCUS_KEY = "data-focus-key";
const DEFAULT_PAID_MODEL_ID = "claude-sonnet-4-5";

type OptionalValue<T> = { ok: true; value: T } | { ok: false; error: string };

function textLike(mediaType: string): boolean {
  return mediaType.startsWith("text/") || TEXT_MEDIA_TYPES.has(mediaType);
}

function decodeBase64Utf8(dataBase64: string): string {
  const bytes = Uint8Array.from(atob(dataBase64), (character) =>
    character.charCodeAt(0),
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function createInitialComposer(): ComposerState {
  return {
    request: "",
    criteria: "",
    startNow: false,
    approvals: { read: true, write: false, execute: false },
    modelChoice: "default",
    paidModelId: DEFAULT_PAID_MODEL_ID,
    paidModelConsent: false,
    submitting: false,
  };
}

function createInitialLaunch(): LaunchCardState {
  return {
    approvals: { read: true, write: true, execute: false },
    modelChoice: "default",
    paidModelId: DEFAULT_PAID_MODEL_ID,
    paidModelConsent: false,
    steerDraft: "",
    busy: false,
  };
}

export function createController(
  bridge: ShellBridge,
  doc: ShellDocument,
  root: ShellElement,
  teamChat?: TeamChatBridgeApi,
) {
  let selectedId: string | undefined;
  let loadRequested = false;
  let loadPromise: Promise<void> | undefined;
  let clientSeq = 1;

  let composer: ComposerState = createInitialComposer();
  let launch: LaunchCardState = createInitialLaunch();
  let patchExport: ExportViewState = { busy: false };

  let teamState: TeamChatViewState = {
    available: Boolean(teamChat),
    open: false,
    users: [],
    conversations: [],
    draft: "",
    searchQuery: "",
    resolvedRefs: {},
  };

  let state: ShellState = { tasks: [], events: [], artifacts: [] };

  const render = () => {
    const active = doc.activeElement;
    const focusKey = active?.getAttribute(FOCUS_KEY) ?? null;
    const selectionStart =
      typeof active?.selectionStart === "number" ? active.selectionStart : null;
    const selectionEnd =
      typeof active?.selectionEnd === "number" ? active.selectionEnd : null;
    const selectionDirection = active?.selectionDirection ?? undefined;
    state = {
      ...state,
      composer,
      launch,
      patchExport,
      teamChat: {
        ...teamState,
        onClose: () => {
          teamState = { ...teamState, open: false };
          render();
        },
        onSelectConversation: (conversationId) =>
          void openTeamConversation(conversationId),
        onDraftChange: (text) => {
          teamState = { ...teamState, draft: text };
        },
        onSend: (text) => void sendTeamMessage(text),
        onTogglePin: (conversationId, pinned) =>
          void toggleTeamPin(conversationId, pinned),
        onToggleReaction: (messageId, emoji, on) =>
          void toggleTeamReaction(messageId, emoji, on),
        onResolveReference: (messageId, referenceId) =>
          void resolveTeamReference(messageId, referenceId),
        onSearch: (query) => void searchTeamMessages(query),
        onSwitchViewer: (viewer) => void switchTeamViewer(viewer),
        onLoadOlder: () => void loadOlderTeamMessages(),
      },
      onOpenTeamChat: () => void openTeamChatPane(),
      onComposerChange: (patch) => {
        composer = { ...composer, ...patch };
        if (
          "startNow" in patch ||
          "modelChoice" in patch ||
          "paidModelConsent" in patch ||
          "error" in patch ||
          "submitting" in patch
        ) {
          render();
        }
      },
      onComposerApprovalChange: (key, val) => {
        composer = {
          ...composer,
          approvals: { ...composer.approvals, [key]: val },
        };
        render();
      },
      onCreateTask: () => void handleCreateTask(),
      onLaunchApprovalChange: (key, val) => {
        launch = {
          ...launch,
          approvals: { ...launch.approvals, [key]: val },
        };
        render();
      },
      onLaunchChange: (patch) => {
        launch = { ...launch, ...patch };
        if (
          "modelChoice" in patch ||
          "paidModelConsent" in patch ||
          "busy" in patch ||
          "actionNotice" in patch ||
          "actionError" in patch
        ) {
          render();
        }
      },
      onStartTask: () => void handleStartTask(),
      onResumeTask: () => void handleResumeTask(),
      onSteerTask: (instruction) => void handleSteerTask(instruction),
      onCancelTask: () => void handleCancelTask(),
      onExportPatch: () => void handleExportPatch(),
    };
    root.replaceChildren(renderShell(doc, state));
    if (focusKey === null) return;
    const targets = Array.from(root.querySelectorAll(`[${FOCUS_KEY}]`));
    const keyed = (key: string) =>
      targets.find((element) => element.getAttribute(FOCUS_KEY) === key);
    const matched = keyed(focusKey);
    const target = matched ?? keyed(HEADING_FOCUS_KEY);
    target?.focus();
    if (
      matched &&
      selectionStart !== null &&
      selectionEnd !== null &&
      typeof matched.setSelectionRange === "function"
    ) {
      try {
        matched.setSelectionRange(
          selectionStart,
          selectionEnd,
          selectionDirection ?? undefined,
        );
      } catch {
        // Ignore input types that do not support selection ranges.
      }
    }
  };

  const displayError = (message: string) => {
    state = {
      tasks: [],
      events: [],
      artifacts: [],
      error: message,
      onRefresh: () => void load(),
    };
    render();
  };

  const value = async <T>(pending: Promise<BridgeResult<T>>): Promise<T> => {
    const result = await pending;
    if (!result.ok) throw new Error(result.error.message);
    return result.result;
  };

  const optionalValue = async <T>(
    operation: () => Promise<T>,
  ): Promise<OptionalValue<T>> => {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "Workbench is unavailable.",
      };
    }
  };

  const loadTeamBootstrap = async () => {
    if (!teamChat) return;
    try {
      const res = await teamChat["team.state"]({});
      if (!res.ok) {
        teamState = {
          ...teamState,
          available: false,
          error: `Team chat error: ${res.code}`,
        };
        return;
      }
      const nextConvId =
        teamState.activeConversationId &&
        res.value.conversations.some(
          (c) => c.conversation_id === teamState.activeConversationId,
        )
          ? teamState.activeConversationId
          : res.value.conversations[0]?.conversation_id;
      const nextTeamState: TeamChatViewState = {
        ...teamState,
        available: true,
        label: res.value.label,
        capabilities: res.value.capabilities,
        viewer: res.value.viewer,
        users: res.value.users,
        conversations: res.value.conversations,
      };
      delete nextTeamState.error;
      if (nextConvId) nextTeamState.activeConversationId = nextConvId;
      teamState = nextTeamState;
    } catch {
      teamState = {
        ...teamState,
        available: false,
        error: "Team chat is unavailable.",
      };
    }
  };

  const openTeamConversation = async (
    conversationId: string,
    options?: { preserveHistory?: boolean },
  ) => {
    if (!teamChat) return;
    const preserveHistory = options?.preserveHistory === true;
    const switchedConversation =
      teamState.activeConversationId !== conversationId;
    const loadingState: TeamChatViewState = {
      ...teamState,
      activeConversationId: conversationId,
      loading: true,
      ...(switchedConversation ? { draft: "" } : {}),
    };
    delete loadingState.searchHits;
    delete loadingState.error;
    teamState = loadingState;
    render();
    try {
      const res = await teamChat["team.open"]({
        conversation_id: conversationId,
      });
      if (!res.ok) {
        teamState = {
          ...teamState,
          loading: false,
          error: `Team chat error: ${res.code}`,
        };
        render();
        return;
      }
      if (teamState.activeConversationId !== conversationId) {
        return;
      }
      const lastSeq = res.value.messages.at(-1)?.sequence;
      if (lastSeq !== undefined && lastSeq > 0) {
        await teamChat["team.markRead"]({
          conversation_id: conversationId,
          sequence: lastSeq,
        });
      }
      await loadTeamBootstrap();
      if (teamState.activeConversationId !== conversationId) {
        return;
      }
      const previousView =
        preserveHistory &&
        teamState.activeView?.conversation.conversation_id === conversationId
          ? teamState.activeView
          : undefined;
      let nextView = res.value;
      if (previousView) {
        const freshIds = new Set(res.value.messages.map((m) => m.message_id));
        const keptOlder = previousView.messages.filter(
          (m) => !freshIds.has(m.message_id),
        );
        if (keptOlder.length > 0) {
          nextView = {
            ...res.value,
            messages: [...keptOlder, ...res.value.messages].sort(
              (a, b) => a.sequence - b.sequence,
            ),
            older_cursor: previousView.older_cursor,
          };
        }
      }
      teamState = {
        ...teamState,
        loading: false,
        activeConversationId: conversationId,
        activeView: nextView,
      };
      render();
    } catch {
      teamState = {
        ...teamState,
        loading: false,
        error: "Unable to open conversation.",
      };
      render();
    }
  };

  const loadOlderTeamMessages = async () => {
    const convId = teamState.activeConversationId;
    const currentView = teamState.activeView;
    const cursor = currentView?.older_cursor;
    if (!teamChat || !convId || !currentView || !cursor || teamState.loading) {
      return;
    }
    teamState = { ...teamState, loading: true };
    render();
    try {
      const res = await teamChat["team.open"]({
        conversation_id: convId,
        before: cursor,
      });
      if (!res.ok) {
        teamState = {
          ...teamState,
          loading: false,
          error: `Team chat error: ${res.code}`,
        };
        render();
        return;
      }
      if (teamState.activeConversationId !== convId) {
        return;
      }
      const existingIds = new Set(
        currentView.messages.map((m) => m.message_id),
      );
      const olderUnique = res.value.messages.filter(
        (m) => !existingIds.has(m.message_id),
      );
      teamState = {
        ...teamState,
        loading: false,
        activeView: {
          ...currentView,
          messages: [...olderUnique, ...currentView.messages],
          older_cursor: res.value.older_cursor,
        },
      };
      render();
    } catch {
      teamState = {
        ...teamState,
        loading: false,
        error: "Unable to load older messages.",
      };
      render();
    }
  };

  const openTeamChatPane = async () => {
    if (!teamChat) return;
    teamState = { ...teamState, open: true };
    render();
    await loadTeamBootstrap();
    if (teamState.activeConversationId) {
      await openTeamConversation(teamState.activeConversationId);
    } else {
      render();
    }
  };

  const sendTeamMessage = async (body: string) => {
    if (!teamChat || !teamState.activeConversationId) return;
    const convId = teamState.activeConversationId;
    try {
      const res = await teamChat["team.send"]({
        input: {
          conversation_id: convId,
          body,
          client_message_id: `shell-msg-${clientSeq++}`,
          reply_to: null,
          references: [],
        },
      });
      if (!res.ok) {
        teamState = { ...teamState, error: `Team chat error: ${res.code}` };
        render();
        return;
      }
      teamState = { ...teamState, draft: "" };
      await openTeamConversation(convId, { preserveHistory: true });
    } catch {
      teamState = { ...teamState, error: "Unable to send message." };
      render();
    }
  };

  const toggleTeamPin = async (conversationId: string, pinned: boolean) => {
    if (!teamChat) return;
    const res = await teamChat["team.setPinned"]({
      conversation_id: conversationId,
      pinned,
    });
    if (!res.ok) {
      teamState = { ...teamState, error: `Team chat error: ${res.code}` };
      render();
      return;
    }
    await loadTeamBootstrap();
    render();
  };

  const toggleTeamReaction = async (
    messageId: string,
    emoji: ReactionEmoji,
    on: boolean,
  ) => {
    const convId = teamState.activeConversationId;
    if (!teamChat || !convId) return;
    const res = await teamChat["team.setReaction"]({
      message_id: messageId,
      emoji,
      on,
    });
    if (!res.ok) {
      teamState = { ...teamState, error: `Team chat error: ${res.code}` };
      render();
      return;
    }
    const currentView = teamState.activeView;
    if (currentView && currentView.conversation.conversation_id === convId) {
      teamState = {
        ...teamState,
        activeView: {
          ...currentView,
          messages: currentView.messages.map((msg) =>
            msg.message_id === messageId
              ? { ...msg, reactions: res.value.reactions }
              : msg,
          ),
        },
      };
      render();
      return;
    }
    await openTeamConversation(convId, { preserveHistory: true });
  };

  const resolveTeamReference = async (
    messageId: string,
    referenceId: string,
  ) => {
    if (!teamChat) return;
    const res = await teamChat["team.resolveReference"]({
      message_id: messageId,
      reference_id: referenceId,
    });
    if (!res.ok) {
      teamState = { ...teamState, error: `Team chat error: ${res.code}` };
      render();
      return;
    }
    const key = `${messageId}:${referenceId}`;
    const resolved: Record<string, ReferencePreview> = {
      ...teamState.resolvedRefs,
      [key]: res.value,
    };
    teamState = { ...teamState, resolvedRefs: resolved };
    render();
  };

  const searchTeamMessages = async (query: string) => {
    if (!teamChat) return;
    const trimmed = query.trim();
    if (!trimmed) {
      const next = { ...teamState, searchQuery: "" };
      delete next.searchHits;
      teamState = next;
      render();
      return;
    }
    const res = await teamChat["team.search"]({ query: trimmed });
    if (!res.ok) {
      teamState = {
        ...teamState,
        searchQuery: trimmed,
        error: `Team chat error: ${res.code}`,
      };
      render();
      return;
    }
    teamState = {
      ...teamState,
      searchQuery: trimmed,
      searchHits: res.value.hits,
    };
    render();
  };

  const switchTeamViewer = async (viewer: string) => {
    if (!teamChat) return;
    const res = await teamChat["team.switchViewer"]({ viewer });
    if (!res.ok) {
      teamState = { ...teamState, error: `Team chat error: ${res.code}` };
      render();
      return;
    }
    const nextConvId = res.value.conversations[0]?.conversation_id;
    const nextTeamState: TeamChatViewState = {
      ...teamState,
      viewer: res.value.viewer,
      users: res.value.users,
      conversations: res.value.conversations,
      draft: "",
      resolvedRefs: {},
    };
    delete nextTeamState.searchHits;
    delete nextTeamState.activeView;
    if (nextConvId) nextTeamState.activeConversationId = nextConvId;
    teamState = nextTeamState;
    if (nextConvId) {
      await openTeamConversation(nextConvId);
    } else {
      render();
    }
  };

  const handleCreateTask = async () => {
    const requestText = composer.request.trim();
    if (!requestText) {
      composer = { ...composer, error: "Enter a task prompt first." };
      render();
      return;
    }
    const described = state.describe;
    if (!described) {
      composer = { ...composer, error: "Workbench is not connected." };
      render();
      return;
    }
    if (composer.startNow && composer.modelChoice === "paid") {
      if (!composer.paidModelId.trim()) {
        composer = {
          ...composer,
          error: "Enter a paid model ID before launching.",
        };
        render();
        return;
      }
      if (!composer.paidModelConsent) {
        composer = {
          ...composer,
          error: "Paid-model consent is required before launching.",
        };
        render();
        return;
      }
    }
    if (composer.submitting) return;
    const snapshot = {
      startNow: composer.startNow,
      modelChoice: composer.modelChoice,
      paidModelConsent: composer.paidModelConsent,
      paidModelId: composer.paidModelId.trim(),
      approvals: { ...composer.approvals },
      criteria: composer.criteria,
    };
    const nextComposer: ComposerState = { ...composer, submitting: true };
    delete nextComposer.error;
    composer = nextComposer;
    render();

    const parsedCriteria = snapshot.criteria
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const criteria = parsedCriteria.length > 0 ? parsedCriteria : [requestText];
    const taskId = `shell-task-${Date.now()}-${clientSeq++}`;
    const newTask: Task = {
      schema_version: 1,
      task_id: taskId,
      session_id: `shell-session-${taskId}`,
      scope: described.scope,
      request: requestText,
      acceptance_criteria: criteria,
      budget: {
        max_tokens: 120000,
        max_usd: 5,
        max_duration_ms: 600000,
        max_depth: 3,
        max_concurrency: 2,
      },
      status: "pending",
      revision: 0,
      specialist_revision: null,
      artifacts: [],
    };

    let created: Task;
    try {
      created = await value(
        bridge["tasks.create"]({
          task: newTask,
          launch_key: `shell-launch-${taskId}`,
        }),
      );
    } catch (error) {
      composer = {
        ...composer,
        submitting: false,
        error:
          error instanceof Error ? error.message : "Failed to create task.",
      };
      render();
      return;
    }

    selectedId = created.task_id;
    composer = createInitialComposer();
    patchExport = { busy: false };
    launch = createInitialLaunch();

    if (snapshot.startNow) {
      if (snapshot.modelChoice === "paid" && !snapshot.paidModelConsent) {
        launch = {
          ...launch,
          approvals: { ...snapshot.approvals },
          modelChoice: "paid",
          paidModelId: snapshot.paidModelId || DEFAULT_PAID_MODEL_ID,
          paidModelConsent: false,
          actionError: "Paid-model consent is required before starting.",
        };
        await load();
        return;
      }
      const approvals: ApprovalsState = {
        read: snapshot.approvals.read,
        write: snapshot.approvals.write,
        execute: described.capabilities.execute && snapshot.approvals.execute,
      };
      const startParams: Parameters<ShellBridge["tasks.start"]>[0] = {
        task_id: created.task_id,
        expected_revision: created.revision,
        approvals,
      };
      if (snapshot.modelChoice === "paid") {
        startParams.model_id = snapshot.paidModelId;
      }
      try {
        await value(bridge["tasks.start"](startParams));
      } catch (error) {
        launch = {
          ...launch,
          approvals: { ...snapshot.approvals },
          modelChoice: snapshot.modelChoice,
          paidModelId: snapshot.paidModelId || DEFAULT_PAID_MODEL_ID,
          paidModelConsent: snapshot.paidModelConsent,
          actionError:
            error instanceof Error
              ? `Task created, but failed to start: ${error.message}`
              : "Task created, but failed to start.",
        };
      }
    }
    await load();
  };

  const handleStartTask = async () => {
    const task = state.selectedTask;
    if (!task) return;
    const paidModelId = launch.paidModelId.trim();
    if (launch.modelChoice === "paid") {
      if (!paidModelId) {
        launch = {
          ...launch,
          actionError: "Enter a paid model ID before starting.",
        };
        render();
        return;
      }
      if (!launch.paidModelConsent) {
        launch = {
          ...launch,
          actionError: "Paid-model consent is required before starting.",
        };
        render();
        return;
      }
    }
    const nextLaunch: LaunchCardState = { ...launch, busy: true };
    delete nextLaunch.actionError;
    delete nextLaunch.actionNotice;
    launch = nextLaunch;
    render();
    try {
      const startParams: Parameters<ShellBridge["tasks.start"]>[0] = {
        task_id: task.task_id,
        expected_revision: task.revision,
        approvals: {
          read: launch.approvals.read,
          write: launch.approvals.write,
          execute:
            Boolean(state.describe?.capabilities.execute) &&
            launch.approvals.execute,
        },
      };
      if (launch.modelChoice === "paid") {
        startParams.model_id = paidModelId;
      }
      await value(bridge["tasks.start"](startParams));
      launch = {
        ...launch,
        busy: false,
        actionNotice: "Task started.",
      };
      await load();
    } catch (error) {
      launch = {
        ...launch,
        busy: false,
        actionError:
          error instanceof Error ? error.message : "Failed to start task.",
      };
      render();
    }
  };

  const handleResumeTask = async () => {
    const task = state.selectedTask;
    if (!task) return;
    const nextLaunch: LaunchCardState = { ...launch, busy: true };
    delete nextLaunch.actionError;
    delete nextLaunch.actionNotice;
    launch = nextLaunch;
    render();
    try {
      await value(
        bridge["tasks.resume"]({
          task_id: task.task_id,
          expected_revision: task.revision,
        }),
      );
      launch = { ...launch, busy: false, actionNotice: "Task resumed." };
      await load();
    } catch (error) {
      launch = {
        ...launch,
        busy: false,
        actionError:
          error instanceof Error ? error.message : "Failed to resume task.",
      };
      render();
    }
  };

  const handleSteerTask = async (instruction: string) => {
    const task = state.selectedTask;
    if (!task) return;
    const nextLaunch: LaunchCardState = { ...launch, busy: true };
    delete nextLaunch.actionError;
    delete nextLaunch.actionNotice;
    launch = nextLaunch;
    render();
    try {
      await value(
        bridge["tasks.steer"]({
          task_id: task.task_id,
          instruction,
        }),
      );
      launch = {
        ...launch,
        busy: false,
        steerDraft: "",
        actionNotice: "Steering instruction sent.",
      };
      await load();
    } catch (error) {
      launch = {
        ...launch,
        busy: false,
        actionError:
          error instanceof Error ? error.message : "Failed to steer task.",
      };
      render();
    }
  };

  const handleCancelTask = async () => {
    const task = state.selectedTask;
    if (!task) return;
    const nextLaunch: LaunchCardState = { ...launch, busy: true };
    delete nextLaunch.actionError;
    delete nextLaunch.actionNotice;
    launch = nextLaunch;
    render();
    try {
      await value(bridge["tasks.cancel"]({ task_id: task.task_id }));
      launch = { ...launch, busy: false, actionNotice: "Task cancelled." };
      await load();
    } catch (error) {
      launch = {
        ...launch,
        busy: false,
        actionError:
          error instanceof Error ? error.message : "Failed to cancel task.",
      };
      render();
    }
  };

  const handleExportPatch = async () => {
    const task = state.selectedTask;
    const verification = state.verification;
    const diff = state.diff;
    if (!task || !verification || !diff) return;
    const expectedPatchSha = verification.patch_sha256 ?? null;
    if (
      verification.state !== "verified" ||
      !verification.candidate?.revision ||
      !expectedPatchSha
    ) {
      patchExport = {
        busy: false,
        error: "Host verification must be Verified before exporting.",
      };
      render();
      return;
    }
    patchExport = { busy: true };
    render();
    try {
      const exported = await value(
        bridge["tasks.export"]({
          task_id: task.task_id,
          expected_revision: verification.candidate.revision,
          expected_patch_sha256: expectedPatchSha,
        }),
      );
      if (!exported.verified) {
        patchExport = {
          busy: false,
          error: "Exported patch was not confirmed as host-verified.",
        };
        render();
        return;
      }
      if (
        exported.patch_sha256 !== expectedPatchSha ||
        exported.artifact.sha256 !== expectedPatchSha
      ) {
        patchExport = {
          busy: false,
          error: "Exported patch SHA-256 did not match expected digest.",
        };
        render();
        return;
      }
      const fetched = await bridge["tasks.artifact"]({
        task_id: task.task_id,
        artifact: exported.artifact,
      });
      if (!fetched.ok) {
        patchExport = {
          busy: false,
          error:
            "Failed to fetch exported patch artifact for SHA-256 verification.",
        };
        render();
        return;
      }
      const verifiedSha256 = await verifyArtifact(
        exported.artifact,
        fetched.result,
        globalThis.crypto.subtle,
      );
      if (!verifiedSha256) {
        patchExport = {
          busy: false,
          error: "Exported patch artifact failed SHA-256 verification.",
        };
        render();
        return;
      }
      const patchText = decodeBase64Utf8(fetched.result.data_base64);
      const nextExport: ExportViewState = {
        busy: false,
        result: exported,
        verifiedSha256,
        patchText,
      };
      patchExport = nextExport;
      render();
    } catch (error) {
      patchExport = {
        busy: false,
        error: error instanceof Error ? error.message : "Patch export failed.",
      };
      render();
    }
  };

  const loadEvents = async (
    taskId: string,
  ): Promise<{ events: EventEnvelope[]; capped: boolean }> => {
    const events: EventEnvelope[] = [];
    const seenEventIds = new Set<string>();
    let afterEventId: string | undefined;
    let capped = false;
    while (events.length < MAX_TASK_EVENTS) {
      const params = afterEventId
        ? { task_id: taskId, after_event_id: afterEventId }
        : { task_id: taskId };
      const page = await value(bridge["tasks.events"](params));
      if (page.length === 0) break;
      const nextCursor = page.at(-1)?.event_id;
      const advances =
        nextCursor !== undefined &&
        nextCursor !== afterEventId &&
        !seenEventIds.has(nextCursor);
      for (const event of page) {
        if (events.length >= MAX_TASK_EVENTS) {
          capped = true;
          break;
        }
        if (seenEventIds.has(event.event_id)) continue;
        seenEventIds.add(event.event_id);
        events.push(event);
      }
      if (!advances) break;
      if (events.length >= MAX_TASK_EVENTS) {
        capped = true;
        break;
      }
      afterEventId = nextCursor;
    }
    return { events, capped };
  };

  const loadEventPayloads = async (
    taskId: string,
    events: EventEnvelope[],
  ): Promise<Map<string, unknown>> => {
    const payloads = new Map<string, unknown>();
    for (const event of events) {
      const ref = event.payload;
      if (
        !ref ||
        !textLike(ref.media_type) ||
        ref.byte_length > MAX_RENDERED_ARTIFACT_BYTES
      ) {
        continue;
      }
      try {
        const fetched = await bridge["tasks.artifact"]({
          task_id: taskId,
          artifact: ref,
        });
        if (!fetched.ok) continue;
        const ok = await verifyArtifact(
          ref,
          fetched.result,
          globalThis.crypto.subtle,
        );
        if (!ok) continue;
        const text = decodeBase64Utf8(fetched.result.data_base64);
        payloads.set(event.event_id, JSON.parse(text) as unknown);
      } catch {
        // Skip unreadable or non-JSON payloads; projection degrades gracefully.
      }
    }
    return payloads;
  };

  const loadOnce = async () => {
    try {
      const described = await value(bridge["workbench.describe"]({}));
      const tasks = await value(bridge["tasks.list"]({}));
      await loadTeamBootstrap();
      const selected =
        tasks.find((task) => task.task_id === selectedId) ?? tasks[0];
      selectedId = selected?.task_id;
      if (!selected) {
        state = {
          describe: described,
          tasks,
          events: [],
          artifacts: [],
          onRefresh: () => void load(),
        };
        render();
        return;
      }
      const inspected = await value(
        bridge["tasks.inspect"]({ task_id: selected.task_id }),
      );
      const [verification, diff, evidence, events] = await Promise.all([
        optionalValue(() =>
          value(bridge["tasks.verification"]({ task_id: selected.task_id })),
        ),
        optionalValue(() =>
          value(bridge["tasks.diff"]({ task_id: selected.task_id })),
        ),
        optionalValue(() =>
          value(bridge["tasks.evidence"]({ task_id: selected.task_id })),
        ),
        optionalValue(() => loadEvents(selected.task_id)),
      ]);
      const artifacts: ArtifactView[] = [];
      for (const ref of inspected.artifacts) {
        if (
          !textLike(ref.media_type) ||
          ref.byte_length > MAX_RENDERED_ARTIFACT_BYTES
        ) {
          artifacts.push({ ref, status: "not rendered" });
          continue;
        }
        let fetched: Awaited<ReturnType<ShellBridge["tasks.artifact"]>>;
        try {
          fetched = await bridge["tasks.artifact"]({
            task_id: inspected.task_id,
            artifact: ref,
          });
        } catch {
          artifacts.push({ ref, status: "not rendered" });
          continue;
        }
        if (!fetched.ok) {
          artifacts.push({
            ref,
            status:
              fetched.error.kind === "hash_mismatch"
                ? "rejected"
                : "not rendered",
          });
          continue;
        }
        if (
          !(await verifyArtifact(ref, fetched.result, globalThis.crypto.subtle))
        ) {
          artifacts.push({ ref, status: "rejected" });
          continue;
        }
        try {
          artifacts.push({
            ref,
            status: "verified",
            content: decodeBase64Utf8(fetched.result.data_base64),
          });
        } catch {
          artifacts.push({
            ref,
            status: "not rendered",
            message: "not valid UTF-8 · not rendered",
          });
        }
      }

      const eventList = events.ok ? events.value.events : [];
      const eventsCapped = events.ok ? events.value.capped : false;
      const eventPayloads = events.ok
        ? await loadEventPayloads(inspected.task_id, eventList)
        : new Map<string, unknown>();

      const entryIds = new Set<string>();
      const addEntryIds = (raw: unknown) => {
        if (!Array.isArray(raw)) return;
        for (const id of raw) {
          if (typeof id === "string" && id.length > 0) entryIds.add(id);
        }
      };
      for (const payload of eventPayloads.values()) {
        if (payload && typeof payload === "object") {
          const obj = payload as {
            entry_ids?: unknown;
            upstream?: { entry_ids?: unknown };
          };
          addEntryIds(obj.entry_ids);
          if (obj.upstream && typeof obj.upstream === "object") {
            addEntryIds(obj.upstream.entry_ids);
          }
        }
      }
      const journal =
        entryIds.size > 0
          ? await optionalValue(() =>
              value(
                bridge["tasks.journal"]({
                  task_id: selected.task_id,
                  entry_ids: [...entryIds],
                }),
              ),
            )
          : { ok: false as const, error: "" };

      const projectionEvents: ProjectionEvent[] = eventList.map((event) => ({
        event,
        payload: eventPayloads.get(event.event_id),
      }));
      const projectionInput: Parameters<typeof projectTranscript>[0] = {
        task: inspected,
        events: projectionEvents,
      };
      if (journal.ok) {
        projectionInput.journal = {
          status: "available",
          entries: new Map(
            journal.value.map((entry) => [entry.entry_id, entry]),
          ),
        };
      }
      if (diff.ok) projectionInput.diff = diff.value;
      if (verification.ok) projectionInput.verification = verification.value;
      const transcript = projectTranscript(projectionInput);

      const nextState: ShellState = {
        describe: described,
        tasks,
        selectedTask: inspected,
        events: eventList,
        eventsCapped,
        transcript,
        artifacts,
        onSelect: (taskId) => {
          selectedId = taskId;
          patchExport = { busy: false };
          launch = createInitialLaunch();
          teamState = { ...teamState, open: false };
          void load();
        },
        onRefresh: () => void load(),
      };
      if (verification.ok) nextState.verification = verification.value;
      else nextState.verificationError = verification.error;
      if (diff.ok) nextState.diff = diff.value;
      else nextState.diffError = diff.error;
      if (evidence.ok) nextState.evidence = evidence.value;
      else nextState.evidenceError = evidence.error;
      if (!events.ok) nextState.eventsError = events.error;
      state = nextState;
      render();
    } catch (error) {
      displayError(
        error instanceof Error ? error.message : "Workbench is unavailable.",
      );
    }
  };

  const load = () => {
    loadRequested = true;
    if (!loadPromise) {
      loadPromise = (async () => {
        while (loadRequested) {
          loadRequested = false;
          await loadOnce();
        }
      })().finally(() => {
        loadPromise = undefined;
        if (loadRequested) void load();
      });
    }
    return loadPromise;
  };

  const settled = async () => {
    while (loadPromise) await loadPromise;
  };

  return { load, settled };
}
