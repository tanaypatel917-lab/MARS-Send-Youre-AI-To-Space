import type { ArtifactRef, EventEnvelope, Task } from "@mars/contracts";
import type {
  MessageView,
  ReactionEmoji,
  ReferencePreview,
} from "@mars/team-chat";
import { type ProjectionEvent, projectTranscript } from "@mars/ui-core";
import type { AssistantApi } from "../shared/assistant";
import type { BridgeResult, ShellBridge } from "../shared/methods";
import {
  TEAM_CHAT_MAX_MESSAGE_CHARS,
  TEAM_CHAT_MAX_SEARCH_CHARS,
  type TeamChatBridgeApi,
} from "../shared/team-chat";
import type { AssistantViewState } from "./assistant-view";
import type { ShellDocument, ShellElement } from "./dom";
import type { ExtensionState, ExtensionsApi } from "./extensions-view";
import type { TeamChatViewState } from "./team-chat-view";
import { verifyArtifact } from "./verify";
import {
  type ApprovalsState,
  type ArtifactView,
  type ComposerState,
  type ExportViewState,
  HEADING_FOCUS_KEY,
  type LaunchCardState,
  MAX_REQUIRED_CHECKS,
  renderShell,
  type ShellState,
  type WorkspacePage,
} from "./view";

const TEXT_MEDIA_TYPES = new Set(["application/json", "application/x-ndjson"]);
const MAX_RENDERED_ARTIFACT_BYTES = 256 * 1024;
const MAX_TASK_EVENTS = 1000;
/** Mirrors `MAX_JOURNAL_ENTRY_IDS` from `@mars/contracts` (asserted in tests). */
export const JOURNAL_BATCH_SIZE = 100;
/** Newest event payloads hydrated per load; older events render as markers. */
export const MAX_HYDRATED_EVENT_PAYLOADS = 300;
const PAYLOAD_FETCH_CONCURRENCY = 6;
const MAX_PAYLOAD_CACHE_ENTRIES = 5000;
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
    checkIds: [],
    submitting: false,
  };
}

function createInitialLaunch(): LaunchCardState {
  return {
    approvals: { read: true, write: true, execute: false },
    modelChoice: "default",
    paidModelId: DEFAULT_PAID_MODEL_ID,
    paidModelConsent: false,
    checkIds: [],
    steerDraft: "",
    busy: false,
  };
}

function toggleId(ids: readonly string[], id: string, on: boolean): string[] {
  const rest = ids.filter((existing) => existing !== id);
  if (!on) return rest;
  return rest.length >= MAX_REQUIRED_CHECKS ? [...ids] : [...rest, id];
}

type StartParams = Parameters<ShellBridge["tasks.start"]>[0];
type JournalEntry = Extract<
  Awaited<ReturnType<ShellBridge["tasks.journal"]>>,
  { ok: true }
>["result"][number];

/** Host-defined checks the user selected, by id only; none without execute approval. */
function requiredChecksFor(
  checkIds: readonly string[],
  available: readonly { id: string }[] | undefined,
  executeApproved: boolean,
): NonNullable<StartParams["required_checks"]> {
  if (!executeApproved) return [];
  const known = new Set((available ?? []).map((check) => check.id));
  return checkIds
    .filter((id) => known.has(id))
    .map((id) => ({ kind: "host_test" as const, check_id: id }));
}

export function createController(
  bridge: ShellBridge,
  doc: ShellDocument,
  root: ShellElement,
  teamChat?: TeamChatBridgeApi,
  assistant?: AssistantApi,
  extensions?: ExtensionsApi,
) {
  let extensionState: ExtensionState = {
    items: [],
    busy: false,
    notice: extensions
      ? ""
      : "The verified installer is not available in this build.",
    available: Boolean(extensions),
  };
  let page: WorkspacePage = assistant ? "chat" : "tasks";
  let settingsError: string | undefined;
  let inspectorOpen = false;
  const emptyAssistant = (): AssistantViewState => ({
    sessions: [],
    activeId: globalThis.crypto.randomUUID(),
    draft: "",
    configured: false,
    consent: false,
    busy: false,
    loading: Boolean(assistant),
  });
  let assistantState = emptyAssistant();
  let assistantWorkspace: string | undefined;
  let suspendedDraft:
    | { workspace: string; activeId: string; draft: string }
    | undefined;
  let scopeGeneration = 0;
  let historyVersion = 0;
  let assistantLoaded = false;
  let selectedId: string | undefined;
  let loadRequested = false;
  let loadPromise: Promise<void> | undefined;
  let clientSeq = 1;
  // Per-load prefix: the host keeps sent client_message_ids across renderer
  // reloads, so a bare counter would replay or conflict with earlier sends.
  const clientIdPrefix = Array.from(
    globalThis.crypto.getRandomValues(new Uint8Array(8)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

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
      page,
      settingsError,
      inspectorOpen,
      onToggleInspector: () => {
        inspectorOpen = !inspectorOpen;
        render();
      },
      onPage: (next) => {
        page = next;
        teamState = { ...teamState, open: false };
        if (next === "extensions") void refreshExtensions();
        render();
      },
      extensions: {
        ...extensionState,
        onRefresh: () => void refreshExtensions(),
        onInstall: (id) => void refreshExtensions(id),
      },
      ...(assistant
        ? {
            assistant: {
              ...assistantState,
              ...(!assistantLoaded && !assistantState.loading && !state.error
                ? { onRetryLoad: () => void load() }
                : {}),
              onDraft: (draft) => {
                assistantState = { ...assistantState, draft };
                if (
                  doc.activeElement?.getAttribute(FOCUS_KEY) !==
                  "assistant-input"
                )
                  render();
              },
              onConsent: (consent) => {
                assistantState = { ...assistantState, consent };
                render();
              },
              onSend: () => void sendAssistant(),
              onSettings: () => void assistantSettings(),
              onNew: () => {
                page = "chat";
                teamState = { ...teamState, open: false };
                assistantState = {
                  ...assistantState,
                  activeId: globalThis.crypto.randomUUID(),
                  draft: "",
                  error: undefined,
                };
                render();
              },
              onSelect: (activeId) => {
                page = "chat";
                teamState = { ...teamState, open: false };
                assistantState = {
                  ...assistantState,
                  activeId,
                  draft: "",
                  error: undefined,
                };
                render();
              },
              onTask: (text) => {
                composer = { ...composer, request: text };
                page = "tasks";
                render();
              },
            },
          }
        : {}),
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
          ...(key === "execute" && !val ? { checkIds: [] } : {}),
        };
        render();
      },
      onComposerCheckChange: (checkId, selected) => {
        composer = {
          ...composer,
          checkIds: toggleId(composer.checkIds, checkId, selected),
        };
        render();
      },
      onLaunchCheckChange: (checkId, selected) => {
        launch = {
          ...launch,
          checkIds: toggleId(launch.checkIds, checkId, selected),
        };
        render();
      },
      onCreateTask: () => void handleCreateTask(),
      onLaunchApprovalChange: (key, val) => {
        launch = {
          ...launch,
          approvals: { ...launch.approvals, [key]: val },
          ...(key === "execute" && !val ? { checkIds: [] } : {}),
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
    const target =
      matched ??
      (focusKey === "workbench-retry"
        ? (keyed("refresh") ?? keyed("assistant-input"))
        : undefined) ??
      keyed(HEADING_FOCUS_KEY);
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

  const loadAssistant = async () => {
    if (!assistant) return;
    const version = historyVersion;
    assistantState = { ...assistantState, loading: true };
    try {
      const result = await assistant.request({ action: "load" });
      assistantLoaded = result.ok;
      if (!result.ok) throw new Error(result.error);
      const changed = assistantWorkspace !== result.workspace;
      if (changed) {
        scopeGeneration++;
        assistantState = emptyAssistant();
        if (suspendedDraft?.workspace === result.workspace)
          assistantState = {
            ...assistantState,
            draft: suspendedDraft.draft,
            activeId: suspendedDraft.activeId,
          };
        assistantWorkspace = result.workspace;
        settingsError = undefined;
      }
      assistantState = {
        ...assistantState,
        sessions:
          changed || version === historyVersion
            ? result.sessions
            : assistantState.sessions,
        configured: result.configured,
        canConfigure: result.canConfigure,
        loading: false,
        ...(changed
          ? {
              activeId:
                suspendedDraft?.workspace === result.workspace
                  ? suspendedDraft.activeId
                  : (result.sessions[0]?.id ?? assistantState.activeId),
              error: undefined,
            }
          : {}),
      };
      suspendedDraft = undefined;
    } catch (error) {
      if (assistantWorkspace && assistantState.draft)
        suspendedDraft = {
          workspace: assistantWorkspace,
          activeId: assistantState.activeId,
          draft: assistantState.draft,
        };
      assistantWorkspace = undefined;
      assistantLoaded = false;
      scopeGeneration++;
      assistantState = {
        ...emptyAssistant(),
        loading: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not load your conversations.",
      };
    }
    render();
  };

  const assistantSettings = async () => {
    if (!assistant) return;
    settingsError = undefined;
    try {
      const result = await assistant.request({ action: "settings" });
      if (!result.ok) settingsError = result.error;
    } catch {
      settingsError = "Could not open model settings.";
    }
    if (page === "chat" && settingsError)
      assistantState = { ...assistantState, error: settingsError };
    render();
  };

  const refreshExtensions = async (installId?: string) => {
    if (!extensions || extensionState.busy) return;
    extensionState = {
      ...extensionState,
      busy: true,
      notice: installId
        ? "Review this addition in the confirmation window."
        : "Loading verified library…",
    };
    render();
    try {
      const outcome = installId
        ? await extensions.install(installId)
        : undefined;
      const items = await extensions.list();
      const notice =
        outcome === "cancelled"
          ? "Nothing changed."
          : outcome === "unavailable"
            ? "Could not add this extension. Review the project and retry."
            : outcome === "installed"
              ? "Added to this project."
              : items.length
                ? "Review the permissions, then choose Add to project."
                : "No verified extensions are available for this project.";
      extensionState = { items, notice, busy: false, available: true };
    } catch {
      extensionState = {
        ...extensionState,
        items: [],
        busy: false,
        notice:
          "The verified library is unavailable. Open a local project and try again.",
      };
    }
    render();
  };

  const sendAssistant = async () => {
    if (!assistant || assistantState.busy || assistantState.loading) return;
    const text = assistantState.draft.trim();
    if (!text) return;
    if (!assistantState.configured || !assistantState.consent) {
      assistantState = {
        ...assistantState,
        error: !assistantState.configured
          ? assistantState.canConfigure === false
            ? "Set OPENROUTER_API_KEY and restart the attached app to start chatting."
            : "Connect a model to start chatting."
          : "Allow this conversation to be sent to OpenRouter below, then send your message.",
      };
      render();
      return;
    }
    const activeId = assistantState.activeId;
    if (!assistantWorkspace) return;
    const generation = scopeGeneration;
    assistantState = {
      ...assistantState,
      busy: true,
      pending: { id: activeId, text },
      error: undefined,
    };
    render();
    try {
      const result = await assistant.request({
        action: "send",
        workspace: assistantWorkspace,
        seenMessages:
          assistantState.sessions.find((s) => s.id === activeId)?.messages
            .length ?? 0,
        id: activeId,
        text,
        consent: true,
      });
      if (scopeGeneration !== generation) return;
      if (!result.ok && result.reloadHistory) {
        await load();
        if (generation === scopeGeneration) {
          assistantState = {
            ...assistantState,
            busy: false,
            pending: undefined,
            error: result.error,
          };
          render();
        }
        return;
      }
      if (result.ok) historyVersion++;
      assistantState = result.ok
        ? {
            ...assistantState,
            sessions: result.sessions,
            configured: result.configured,
            draft:
              assistantState.activeId === activeId ? "" : assistantState.draft,
            busy: false,
          }
        : { ...assistantState, busy: false, error: result.error };
    } catch {
      if (scopeGeneration !== generation) return;
      assistantState = {
        ...assistantState,
        busy: false,
        error: "Could not send your message. Your draft is kept.",
      };
    }
    assistantState = { ...assistantState, pending: undefined };
    render();
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
    if (switchedConversation) delete loadingState.notice;
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
          notice: `Unable to load older messages (${res.code}).`,
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
        notice: "Unable to load older messages.",
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
    const keepDraft = (notice: string) => {
      teamState = {
        ...teamState,
        draft: teamState.draft.trim() === body ? teamState.draft : body,
        notice,
      };
      render();
    };
    if (body.length > TEAM_CHAT_MAX_MESSAGE_CHARS) {
      keepDraft(
        `Message is too long (${body.length}/${TEAM_CHAT_MAX_MESSAGE_CHARS} characters). Shorten it and send again.`,
      );
      return;
    }
    try {
      const res = await teamChat["team.send"]({
        input: {
          conversation_id: convId,
          body,
          client_message_id: `shell-msg-${clientIdPrefix}-${clientSeq++}`,
          reply_to: null,
          references: [],
        },
      });
      if (!res.ok) {
        keepDraft(
          `Message was not sent (${res.code}). Edit it and send again.`,
        );
        return;
      }
      const sent: TeamChatViewState = { ...teamState, draft: "" };
      delete sent.notice;
      teamState = sent;
      await openTeamConversation(convId, { preserveHistory: true });
    } catch {
      keepDraft("Unable to send message. Edit it and send again.");
    }
  };

  const toggleTeamPin = async (conversationId: string, pinned: boolean) => {
    if (!teamChat) return;
    const res = await teamChat["team.setPinned"]({
      conversation_id: conversationId,
      pinned,
    });
    if (!res.ok) {
      teamState = { ...teamState, notice: `Team chat error: ${res.code}` };
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
      teamState = { ...teamState, notice: `Team chat error: ${res.code}` };
      render();
      return;
    }
    const applyReactions = (messages: readonly MessageView[]) =>
      messages.map((msg) =>
        msg.message_id === messageId
          ? { ...msg, reactions: res.value.reactions }
          : msg,
      );
    const currentView = teamState.activeView;
    const hits = teamState.searchHits;
    const inView = Boolean(
      currentView?.messages.some((msg) => msg.message_id === messageId),
    );
    const inHits = Boolean(hits?.some((msg) => msg.message_id === messageId));
    if (!inView && !inHits) {
      await openTeamConversation(convId, { preserveHistory: true });
      return;
    }
    const next: TeamChatViewState = { ...teamState };
    if (currentView && inView)
      next.activeView = {
        ...currentView,
        messages: applyReactions(currentView.messages),
      };
    if (hits && inHits) next.searchHits = applyReactions(hits);
    teamState = next;
    render();
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
      teamState = { ...teamState, notice: `Team chat error: ${res.code}` };
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
    if (trimmed.length > TEAM_CHAT_MAX_SEARCH_CHARS) {
      teamState = {
        ...teamState,
        searchQuery: query,
        notice: `Search is too long (${trimmed.length}/${TEAM_CHAT_MAX_SEARCH_CHARS} characters). Shorten it and search again.`,
      };
      render();
      return;
    }
    const res = await teamChat["team.search"]({ query: trimmed });
    if (!res.ok) {
      teamState = {
        ...teamState,
        searchQuery: trimmed,
        notice: `Team chat error: ${res.code}`,
      };
      render();
      return;
    }
    const found: TeamChatViewState = {
      ...teamState,
      searchQuery: trimmed,
      searchHits: res.value.hits,
    };
    delete found.notice;
    teamState = found;
    render();
  };

  const switchTeamViewer = async (viewer: string) => {
    if (!teamChat) return;
    const res = await teamChat["team.switchViewer"]({ viewer });
    if (!res.ok) {
      teamState = { ...teamState, notice: `Team chat error: ${res.code}` };
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
      checkIds: [...composer.checkIds],
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
          checkIds: [...snapshot.checkIds],
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
      const startParams: StartParams = {
        task_id: created.task_id,
        expected_revision: created.revision,
        approvals,
      };
      const composerChecks = requiredChecksFor(
        snapshot.checkIds,
        described.checks,
        approvals.execute,
      );
      if (composerChecks.length > 0)
        startParams.required_checks = composerChecks;
      if (snapshot.modelChoice === "paid") {
        startParams.model_id = snapshot.paidModelId;
      }
      try {
        await value(bridge["tasks.start"](startParams));
      } catch (error) {
        launch = {
          ...launch,
          approvals: { ...snapshot.approvals },
          checkIds: [...snapshot.checkIds],
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
      const startParams: StartParams = {
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
      const launchChecks = requiredChecksFor(
        launch.checkIds,
        state.describe?.checks,
        startParams.approvals.execute,
      );
      if (launchChecks.length > 0) startParams.required_checks = launchChecks;
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

  // Verified payloads are immutable (content-addressed), so a refresh only
  // fetches payloads it has not already verified for that task.
  const payloadCache = new Map<string, unknown>();
  const loadEventPayloads = async (
    taskId: string,
    events: EventEnvelope[],
  ): Promise<Map<string, unknown>> => {
    const payloads = new Map<string, unknown>();
    const pending: { eventId: string; key: string; ref: ArtifactRef }[] = [];
    const hydratable = events
      .filter(
        (event) =>
          event.payload &&
          textLike(event.payload.media_type) &&
          event.payload.byte_length <= MAX_RENDERED_ARTIFACT_BYTES,
      )
      .slice(-MAX_HYDRATED_EVENT_PAYLOADS);
    for (const event of hydratable) {
      const ref = event.payload;
      if (!ref) continue;
      const key = `${taskId}\u0000${ref.sha256}\u0000${ref.byte_length}\u0000${ref.media_type}`;
      if (payloadCache.has(key))
        payloads.set(event.event_id, payloadCache.get(key));
      else pending.push({ eventId: event.event_id, key, ref });
    }
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < pending.length) {
        const item = pending[nextIndex++];
        if (!item) return;
        try {
          const fetched = await bridge["tasks.artifact"]({
            task_id: taskId,
            artifact: item.ref,
          });
          if (!fetched.ok) continue;
          const ok = await verifyArtifact(
            item.ref,
            fetched.result,
            globalThis.crypto.subtle,
          );
          if (!ok) continue;
          const parsed = JSON.parse(
            decodeBase64Utf8(fetched.result.data_base64),
          ) as unknown;
          if (payloadCache.size >= MAX_PAYLOAD_CACHE_ENTRIES)
            payloadCache.clear();
          payloadCache.set(item.key, parsed);
          payloads.set(item.eventId, parsed);
        } catch {
          // Skip unreadable or non-JSON payloads; projection degrades gracefully.
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(PAYLOAD_FETCH_CONCURRENCY, pending.length) },
        worker,
      ),
    );
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
      const journalEntries = new Map<string, JournalEntry>();
      let journalAvailable = false;
      const pendingIds = [...entryIds];
      for (
        let index = 0;
        index < pendingIds.length;
        index += JOURNAL_BATCH_SIZE
      ) {
        const batch = await optionalValue(() =>
          value(
            bridge["tasks.journal"]({
              task_id: selected.task_id,
              entry_ids: pendingIds.slice(index, index + JOURNAL_BATCH_SIZE),
            }),
          ),
        );
        if (!batch.ok) continue;
        journalAvailable = true;
        for (const entry of batch.value)
          journalEntries.set(entry.entry_id, entry);
      }

      let finalText: string | null = null;
      if (inspected.status === "completed") {
        const finalRef = inspected.artifacts.findLast((ref) =>
          ref.media_type.startsWith("text/plain"),
        );
        const finalView = finalRef
          ? artifacts.find(
              (view) => view.ref.artifact_id === finalRef.artifact_id,
            )
          : undefined;
        if (finalView?.status === "verified" && finalView.content !== undefined)
          finalText = finalView.content;
      }

      const projectionEvents: ProjectionEvent[] = eventList.map((event) => ({
        event,
        payload: eventPayloads.get(event.event_id),
      }));
      const projectionInput: Parameters<typeof projectTranscript>[0] = {
        task: inspected,
        events: projectionEvents,
      };
      if (journalAvailable) {
        projectionInput.journal = {
          status: "available",
          entries: journalEntries,
        };
      }
      if (finalText !== null) projectionInput.finalText = finalText;
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
          page = "tasks";
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
          await Promise.all([loadAssistant(), loadOnce()]);
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
