import type { ArtifactRef, EventEnvelope, Task } from "@mars/contracts";
import type {
  MessageView,
  ReactionEmoji,
  ReferencePreview,
  TeamResult,
} from "@mars/team-chat";
import { type ProjectionEvent, projectTranscript } from "@mars/ui-core";
import type { AssistantApi } from "../shared/assistant";
import type { BridgeError, BridgeResult, ShellBridge } from "../shared/methods";
import type { PatchHandoffApi } from "../shared/patch-handoff";
import {
  TEAM_CHAT_MAX_MESSAGE_CHARS,
  TEAM_CHAT_MAX_SEARCH_CHARS,
  type TeamChatBridgeApi,
} from "../shared/team-chat";
import type { AssistantViewState } from "./assistant-view";
import type { ShellDocument, ShellElement } from "./dom";
import type { ExtensionState, ExtensionsApi } from "./extensions-view";
import type { TeamChatViewState } from "./team-chat-view";
import { sha256Hex, verifyArtifact } from "./verify";
import {
  type ApprovalsState,
  type ArtifactView,
  type ComposerState,
  type ExportViewState,
  HEADING_FOCUS_KEY,
  type LaunchCardState,
  MAX_REQUIRED_CHECKS,
  patchExportBlocker,
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
const TASK_REFRESH_MS = 2_000;
const MAX_REFRESH_MS = 30_000;
const DEFAULT_PAID_MODEL_ID = "claude-sonnet-4-5";

type OptionalValue<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; kind?: BridgeError["kind"] };

async function teamAction<T>(
  invoke: () => Promise<TeamResult<T>>,
): Promise<TeamResult<T>> {
  try {
    return await invoke();
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

class WorkbenchFailure extends Error {
  constructor(readonly detail: BridgeError) {
    super(detail.message);
  }
}

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
    approvals: { read: true, write: false, execute: false },
    modelChoice: "default",
    paidModelId: DEFAULT_PAID_MODEL_ID,
    paidModelConsent: false,
    checkIds: [],
    steerDraft: "",
    busy: false,
  };
}

function beginLaunchAction(launch: LaunchCardState) {
  launch.busy = true;
  delete launch.actionError;
  delete launch.actionNotice;
  delete launch.modelUnavailable;
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
  scheduleRefresh?: (tick: () => void, delay: number) => () => void,
  patchHandoff?: PatchHandoffApi,
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
  // Only shelved drafts live here. No draft is written to disk or sent to the model.
  const assistantDrafts = new Map<string, string>();
  let draftWorkspace: string | undefined;
  const selectChat = (id: string) => {
    if (assistantState.busy || assistantState.loading) return;
    if (assistantState.draft)
      assistantDrafts.set(assistantState.activeId, assistantState.draft);
    const draft = assistantDrafts.get(id) ?? "";
    assistantDrafts.delete(id);
    page = "chat";
    closeTeamChat();
    assistantState = {
      ...assistantState,
      activeId: id,
      draft,
      consent: false,
      validation: undefined,
      error: undefined,
    };
    render();
  };
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
  let disposed = false;
  let cancelRefresh: (() => void) | undefined;
  let refreshDelay = TASK_REFRESH_MS;
  let clientSeq = 1;
  // Per-load prefix: the host keeps sent client_message_ids across renderer
  // reloads, so a bare counter would replay or conflict with earlier sends.
  const clientIdPrefix = Array.from(
    globalThis.crypto.getRandomValues(new Uint8Array(8)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

  let composer: ComposerState = createInitialComposer();
  // Each async action retains its own task's form, even after navigation.
  const launchForms = new Map<string, LaunchCardState>();
  const taskKey = (task: Task): string => {
    const { owner_id, project_id, workspace_id } = task.scope;
    return JSON.stringify([
      owner_id,
      project_id,
      workspace_id,
      task.session_id,
      task.task_id,
    ]);
  };
  const launchFor = (task: Task): LaunchCardState => {
    const key = taskKey(task);
    const existing = launchForms.get(key);
    if (existing) return existing;
    const form = createInitialLaunch();
    launchForms.set(key, form);
    return form;
  };
  let patchExport: ExportViewState = { busy: false };
  const selectTask = (id: string | undefined) => {
    if (id !== selectedId) {
      selectedId = id;
      patchExport = { busy: false };
    }
  };

  let teamState: TeamChatViewState = {
    available: Boolean(teamChat),
    open: false,
    users: [],
    conversations: [],
    draft: "",
    searchQuery: "",
    resolvedRefs: {},
  };
  const teamDrafts = new Map<string, { text: string }>();
  const teamKey = (
    viewer = teamState.viewer,
    id = teamState.activeConversationId,
  ) => JSON.stringify([viewer, id]);

  let state: ShellState = { tasks: [], events: [], artifacts: [] };
  let teamContext = 0;
  let searchVersion = 0;
  const closeTeamChat = () => {
    teamContext++;
    teamState = { ...teamState, open: false };
    delete teamState.searchHits;
  };

  let extensionAnchorId: string | undefined;
  const libraryScroller = () =>
    root.querySelectorAll("[data-library-scroll]")[0];
  const anchorTop = () =>
    Array.from(root.querySelectorAll("[data-extension-id]"))
      .find((el) => el.getAttribute("data-extension-id") === extensionAnchorId)
      ?.getBoundingClientRect?.().top;
  let renderedTaskKey: string | undefined;
  const render = () => {
    if (disposed) return;
    const oldLibraryOffset = libraryScroller()?.scrollTop;
    const oldAnchorTop =
      oldLibraryOffset === undefined ? undefined : anchorTop();
    const launch = state.selectedTask
      ? launchFor(state.selectedTask)
      : createInitialLaunch();
    const active = doc.activeElement;
    const focusAttr = [FOCUS_KEY, "data-control", "data-action"].find(
      (attr) => active?.getAttribute(attr) != null,
    );
    const focusKey = focusAttr ? active?.getAttribute(focusAttr) : undefined;
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
        if (
          inspectorOpen &&
          globalThis.matchMedia?.("(max-width: 900px)").matches
        )
          root.querySelectorAll("[data-inspector-heading]")[0]?.focus();
      },
      onPage: (next) => {
        page = next;
        closeTeamChat();
        if (next === "extensions") void refreshExtensions();
        render();
        if (next === "extensions") libraryScroller()?.focus();
      },
      extensions: {
        ...extensionState,
        onRefresh: () => void refreshExtensions(),
        onInstall: (id) => void refreshExtensions({ action: "install", id }),
        ...(extensions?.remove
          ? {
              onRemove: (id: string) =>
                void refreshExtensions({ action: "remove", id }),
            }
          : {}),
        hasTaskDraft: Boolean(composer.request || composer.criteria),
        onDraftTask: (example) => {
          if (!composer.request && !composer.criteria)
            composer = { ...createInitialComposer(), request: example };
          page = "tasks";
          render();
          Array.from(root.querySelectorAll("[data-focus-key]"))
            .find(
              (el) => el.getAttribute("data-focus-key") === "composer-request",
            )
            ?.focus();
        },
      },
      ...(assistant
        ? {
            assistant: {
              ...assistantState,
              unsentIds: assistantWorkspace
                ? Array.from(assistantDrafts.keys()).filter(
                    (id) => !assistantState.sessions.some((s) => s.id === id),
                  )
                : [],
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
                assistantState = {
                  ...assistantState,
                  consent,
                  validation: undefined,
                };
                render();
              },
              onSend: () => void sendAssistant(),
              onSettings: () => void assistantSettings(),
              onNew: () => selectChat(globalThis.crypto.randomUUID()),
              onSelect: selectChat,
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
          closeTeamChat();
          render();
        },
        onSelectConversation: (conversationId) =>
          void openTeamConversation(conversationId),
        onDraftChange: (text) => {
          if (text) teamDrafts.set(teamKey(), { text });
          else teamDrafts.delete(teamKey());
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
        onSearchChange: (searchQuery) => {
          teamState = { ...teamState, searchQuery };
        },
        onSwitchViewer: (viewer) => void switchTeamViewer(viewer),
        onLoadOlder: () => void loadOlderTeamMessages(),
      },
      onOpenTeamChat: () => void openTeamChatPane(),
      onComposerChange: (patch) => {
        const submitButton = () =>
          Array.from(root.querySelectorAll("[data-action]")).find(
            (el) => el.getAttribute("data-action") === "create-task",
          );
        const previousSubmit =
          patch.startNow === true
            ? submitButton()?.getBoundingClientRect?.()
            : undefined;
        const keepSubmitVisible =
          previousSubmit &&
          previousSubmit.top >= 0 &&
          previousSubmit.bottom <= globalThis.innerHeight;
        composer = { ...composer, ...patch };
        if (
          "startNow" in patch ||
          "modelChoice" in patch ||
          "paidModelConsent" in patch ||
          "error" in patch ||
          "submitting" in patch
        ) {
          render();
          if (keepSubmitVisible)
            submitButton()?.scrollIntoView?.({ block: "nearest" });
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
        Object.assign(launch, {
          checkIds: toggleId(launch.checkIds, checkId, selected),
        });
        render();
      },
      onCreateTask: () => void handleCreateTask(),
      onLaunchApprovalChange: (key, val) => {
        Object.assign(launch, {
          approvals: { ...launch.approvals, [key]: val },
          ...(key === "execute" && !val ? { checkIds: [] } : {}),
        });
        render();
      },
      onLaunchChange: (patch) => {
        Object.assign(launch, patch);
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
      ...(patchHandoff ? { onSavePatch: () => void handleSavePatch() } : {}),
    };
    const scrollPanes = () =>
      Array.from(root.querySelectorAll("[data-scroll-key]"));
    const scroll = new Map(
      scrollPanes().map((el) => [
        el.getAttribute("data-scroll-key"),
        [el.scrollLeft, el.scrollTop] as const,
      ]),
    );
    const nextTaskKey = state.selectedTask && taskKey(state.selectedTask);
    const details = () =>
      Array.from(root.querySelectorAll("[data-disclosure-key]"));
    const expanded = new Set(
      nextTaskKey && nextTaskKey === renderedTaskKey
        ? details()
            .filter((el) => el.getAttribute("open") !== null)
            .map((el) => el.getAttribute("data-disclosure-key"))
        : [],
    );
    renderedTaskKey = nextTaskKey;
    root.replaceChildren(renderShell(doc, state));
    const library = libraryScroller();
    if (library && oldLibraryOffset !== undefined) {
      library.scrollTop = oldLibraryOffset;
      const top = anchorTop();
      if (oldAnchorTop !== undefined && top !== undefined)
        library.scrollTop += top - oldAnchorTop;
    }
    if (expanded.size) {
      for (const detail of details()) {
        if (expanded.has(detail.getAttribute("data-disclosure-key")))
          detail.setAttribute("open", "");
      }
    }
    for (const pane of scrollPanes()) {
      const position = scroll.get(pane.getAttribute("data-scroll-key"));
      if (position) [pane.scrollLeft, pane.scrollTop] = position;
    }
    if (!focusKey || !focusAttr) return;
    const targets = Array.from(root.querySelectorAll(`[${focusAttr}]`));
    const keyed = (key: string) =>
      targets.find((element) => element.getAttribute(focusAttr) === key);
    const matched = keyed(focusKey);
    const target =
      matched ??
      (focusKey.startsWith("remove-extension-")
        ? keyed(focusKey.slice("remove-".length))
        : undefined) ??
      (focusKey === "workbench-retry"
        ? (keyed("refresh") ?? keyed("assistant-input"))
        : undefined) ??
      (focusKey === "connect-model" ? keyed("assistant-input") : undefined) ??
      Array.from(root.querySelectorAll(`[${FOCUS_KEY}]`)).find(
        (el) => el.getAttribute(FOCUS_KEY) === HEADING_FOCUS_KEY,
      );
    target?.focus({ preventScroll: true });
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
        if (result.workspace !== draftWorkspace) assistantDrafts.clear();
        draftWorkspace = result.workspace;
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
      if (!changed && !assistantState.configured && result.configured) {
        for (const launch of launchForms.values()) {
          if (launch.modelUnavailable) {
            delete launch.modelUnavailable;
            delete launch.actionError;
          }
        }
      }
      assistantState = {
        ...assistantState,
        sessions:
          changed || version === historyVersion
            ? result.sessions
            : assistantState.sessions,
        ...(assistantState.configured !== result.configured
          ? { validation: undefined }
          : {}),
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

  let libraryChanged = false;
  const refreshExtensions = async (change?: {
    action: "install" | "remove";
    id: string;
  }) => {
    if (!extensions || extensionState.busy) return;
    const removing = change?.action === "remove";
    extensionAnchorId = change?.id;
    extensionState = {
      ...extensionState,
      busy: true,
      notice: change
        ? `Review this ${removing ? "removal" : "addition"} in the confirmation window.`
        : "Loading verified library…",
    };
    render();
    try {
      let outcome:
        | "installed"
        | "removed"
        | "cancelled"
        | "unavailable"
        | undefined;
      if (change) {
        try {
          outcome = removing
            ? ((await extensions.remove?.(change.id)) ?? "unavailable")
            : await extensions.install(change.id);
        } catch {
          outcome = "unavailable";
        }
      }
      let items: ExtensionState["items"];
      do {
        libraryChanged = false;
        items = await extensions.list();
        if (disposed) return;
      } while (libraryChanged && page === "extensions");
      const notice =
        outcome === "cancelled"
          ? "Nothing changed."
          : outcome === "unavailable"
            ? removing
              ? "Could not confirm removal; refresh the library."
              : "Could not add this extension. Review the project and retry."
            : outcome === "removed"
              ? "Removed from this project."
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
    if (
      change &&
      page === "extensions" &&
      (doc.activeElement?.getAttribute(FOCUS_KEY) ===
        `extension-${change.id}` ||
        doc.activeElement?.getAttribute(FOCUS_KEY) ===
          `remove-extension-${change.id}`)
    )
      doc.activeElement.scrollIntoView?.({ block: "nearest" });
  };

  const sendAssistant = async () => {
    if (!assistant || assistantState.busy || assistantState.loading) return;
    const text = assistantState.draft.trim();
    if (!text) return;
    if (!assistantState.configured || !assistantState.consent) {
      assistantState = {
        ...assistantState,
        error: undefined,
        validation: !assistantState.configured ? "key" : "consent",
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
      validation: undefined,
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
    patchExport = { busy: false };
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
    if (!result.ok) throw new WorkbenchFailure(result.error);
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
        ...(error instanceof WorkbenchFailure
          ? { kind: error.detail.kind }
          : {}),
        error:
          error instanceof Error ? error.message : "Workbench is unavailable.",
      };
    }
  };

  const loadTeamBootstrap = async () => {
    if (!teamChat) return;
    const context = teamContext;
    try {
      const res = await teamChat["team.state"]({});
      if (context !== teamContext) return;
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
      if (
        teamState.viewer !== res.value.viewer ||
        teamState.activeConversationId !== nextConvId
      ) {
        teamContext++;
        delete nextTeamState.activeView;
        delete nextTeamState.searchHits;
        delete nextTeamState.activeConversationId;
        nextTeamState.searchQuery = "";
        nextTeamState.draft =
          teamDrafts.get(teamKey(res.value.viewer, nextConvId))?.text ?? "";
        nextTeamState.resolvedRefs = {};
      }
      if (nextConvId) nextTeamState.activeConversationId = nextConvId;
      teamState = nextTeamState;
    } catch {
      if (context !== teamContext) return;
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
    if (switchedConversation) teamContext++;
    const context = teamContext;
    if (!preserveHistory) searchVersion++;
    const loadingState: TeamChatViewState = {
      ...teamState,
      activeConversationId: conversationId,
      loading: true,
      ...(switchedConversation
        ? {
            searchQuery: "",
            draft:
              teamDrafts.get(teamKey(teamState.viewer, conversationId))?.text ??
              "",
          }
        : {}),
    };
    if (!preserveHistory) delete loadingState.searchHits;
    if (switchedConversation) delete loadingState.activeView;
    delete loadingState.error;
    if (switchedConversation) delete loadingState.notice;
    teamState = loadingState;
    render();
    try {
      const res = await teamChat["team.open"]({
        conversation_id: conversationId,
      });
      if (context !== teamContext) return;
      if (!res.ok) {
        teamState = {
          ...teamState,
          loading: false,
          error: `Team chat error: ${res.code}`,
        };
        render();
        return;
      }
      const lastSeq = res.value.messages.at(-1)?.sequence;
      if (lastSeq !== undefined && lastSeq > 0) {
        await teamChat["team.markRead"]({
          conversation_id: conversationId,
          sequence: lastSeq,
        });
      }
      if (context !== teamContext) return;
      await loadTeamBootstrap();
      if (context !== teamContext) {
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
      if (context !== teamContext) return;
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
    const context = teamContext;
    teamState = { ...teamState, loading: true };
    render();
    try {
      const res = await teamChat["team.open"]({
        conversation_id: convId,
        before: cursor,
      });
      if (context !== teamContext) return;
      if (!res.ok) {
        teamState = {
          ...teamState,
          loading: false,
          notice: `Unable to load older messages (${res.code}).`,
        };
        render();
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
      if (context !== teamContext) return;
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
    if (!teamState.open) return;
    if (teamState.activeConversationId) {
      await openTeamConversation(teamState.activeConversationId, {
        preserveHistory: true,
      });
    } else {
      render();
    }
  };

  const sendTeamMessage = async (body: string) => {
    if (!teamChat || !teamState.activeConversationId) return;
    const convId = teamState.activeConversationId;
    const key = teamKey();
    const context = teamContext;
    const draft = teamDrafts.get(key);
    const keepDraft = (notice: string) => {
      if (context !== teamContext) return;
      teamState = {
        ...teamState,
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
      if (context !== teamContext && teamKey() === key) return;
      if (teamDrafts.get(key) === draft) teamDrafts.delete(key);
      if (context !== teamContext) return;
      const sent = { ...teamState, draft: teamDrafts.get(key)?.text ?? "" };
      delete sent.notice;
      teamState = sent;
      await openTeamConversation(convId, { preserveHistory: true });
      if (teamState.open && context === teamContext)
        Array.from(root.querySelectorAll("[data-message-id]"))
          .find(
            (el) => el.getAttribute("data-message-id") === res.value.message_id,
          )
          ?.scrollIntoView?.({ block: "nearest" });
    } catch {
      keepDraft("Unable to send message. Edit it and send again.");
    }
  };

  const toggleTeamPin = async (conversationId: string, pinned: boolean) => {
    if (!teamChat) return;
    const context = teamContext;
    const res = await teamAction(() =>
      teamChat["team.setPinned"]({
        conversation_id: conversationId,
        pinned,
      }),
    );
    if (context !== teamContext) return;
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
    const context = teamContext;
    const res = await teamAction(() =>
      teamChat["team.setReaction"]({
        message_id: messageId,
        emoji,
        on,
      }),
    );
    if (context !== teamContext) return;
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
    const context = teamContext;
    const res = await teamAction(() =>
      teamChat["team.resolveReference"]({
        message_id: messageId,
        reference_id: referenceId,
      }),
    );
    if (context !== teamContext) return;
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
    const context = teamContext;
    const version = ++searchVersion;
    teamState = { ...teamState, searchQuery: query };
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
    const res = await teamAction(() =>
      teamChat["team.search"]({ query: trimmed }),
    );
    if (context !== teamContext || version !== searchVersion) return;
    if (!res.ok) {
      teamState = {
        ...teamState,
        notice: `Team chat error: ${res.code}`,
      };
      render();
      return;
    }
    const found: TeamChatViewState = {
      ...teamState,
      searchHits: res.value.hits,
    };
    delete found.notice;
    teamState = found;
    render();
  };

  const switchTeamViewer = async (viewer: string) => {
    if (!teamChat) return;
    const context = ++teamContext;
    const res = await teamAction(() =>
      teamChat["team.switchViewer"]({ viewer }),
    );
    if (context !== teamContext) return;
    if (!res.ok) {
      teamState = { ...teamState, notice: `Team chat error: ${res.code}` };
      render();
      return;
    }
    const nextConvId = res.value.conversations[0]?.conversation_id;
    teamContext++;
    const nextTeamState: TeamChatViewState = {
      ...teamState,
      viewer: res.value.viewer,
      users: res.value.users,
      conversations: res.value.conversations,
      draft: teamDrafts.get(teamKey(res.value.viewer, nextConvId))?.text ?? "",
      searchQuery: "",
      resolvedRefs: {},
    };
    delete nextTeamState.searchHits;
    delete nextTeamState.activeView;
    delete nextTeamState.activeConversationId;
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

    selectTask(created.task_id);
    composer = createInitialComposer();
    const launch = launchFor(created);

    if (snapshot.startNow) {
      if (snapshot.modelChoice === "paid" && !snapshot.paidModelConsent) {
        Object.assign(launch, {
          approvals: { ...snapshot.approvals },
          checkIds: [...snapshot.checkIds],
          modelChoice: "paid",
          paidModelId: snapshot.paidModelId || DEFAULT_PAID_MODEL_ID,
          paidModelConsent: false,
          actionError: "Paid-model consent is required before starting.",
        });
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
        Object.assign(launch, {
          approvals: { ...snapshot.approvals },
          checkIds: [...snapshot.checkIds],
          modelChoice: snapshot.modelChoice,
          paidModelId: snapshot.paidModelId || DEFAULT_PAID_MODEL_ID,
          paidModelConsent: snapshot.paidModelConsent,
          modelUnavailable:
            error instanceof WorkbenchFailure &&
            error.detail.kind === "model_unavailable",
          actionError:
            error instanceof Error
              ? `Task created, but failed to start: ${error.message}`
              : "Task created, but failed to start.",
        });
      }
    }
    await load();
  };

  const handleStartTask = async () => {
    const task = state.selectedTask;
    if (!task) return;
    const launch = launchFor(task);
    const paidModelId = launch.paidModelId.trim();
    if (launch.modelChoice === "paid") {
      if (!paidModelId) {
        Object.assign(launch, {
          actionError: "Enter a paid model ID before starting.",
        });
        render();
        return;
      }
      if (!launch.paidModelConsent) {
        Object.assign(launch, {
          actionError: "Paid-model consent is required before starting.",
        });
        render();
        return;
      }
    }
    beginLaunchAction(launch);
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
      Object.assign(launch, {
        busy: false,
        actionNotice: "Task started.",
      });
      await load();
    } catch (error) {
      Object.assign(launch, {
        busy: false,
        actionError:
          error instanceof Error ? error.message : "Failed to start task.",
        modelUnavailable:
          error instanceof WorkbenchFailure &&
          error.detail.kind === "model_unavailable",
      });
      render();
    }
  };

  const handleResumeTask = async () => {
    const task = state.selectedTask;
    if (!task) return;
    const launch = launchFor(task);
    beginLaunchAction(launch);
    render();
    try {
      await value(
        bridge["tasks.resume"]({
          task_id: task.task_id,
          expected_revision: task.revision,
        }),
      );
      Object.assign(launch, { busy: false, actionNotice: "Task resumed." });
      await load();
    } catch (error) {
      Object.assign(launch, {
        busy: false,
        actionError:
          error instanceof Error ? error.message : "Failed to resume task.",
      });
      render();
    }
  };

  const handleSteerTask = async (instruction: string) => {
    const task = state.selectedTask;
    if (!task) return;
    const launch = launchFor(task);
    beginLaunchAction(launch);
    render();
    try {
      await value(
        bridge["tasks.steer"]({
          task_id: task.task_id,
          instruction,
        }),
      );
      Object.assign(launch, {
        busy: false,
        steerDraft: "",
        actionNotice: "Steering instruction sent.",
      });
      await load();
    } catch (error) {
      Object.assign(launch, {
        busy: false,
        actionError:
          error instanceof Error ? error.message : "Failed to steer task.",
      });
      render();
    }
  };

  const handleCancelTask = async () => {
    const task = state.selectedTask;
    if (!task) return;
    const launch = launchFor(task);
    beginLaunchAction(launch);
    render();
    try {
      await value(bridge["tasks.cancel"]({ task_id: task.task_id }));
      Object.assign(launch, { busy: false, actionNotice: "Task cancelled." });
      await load();
    } catch (error) {
      Object.assign(launch, {
        busy: false,
        actionError:
          error instanceof Error ? error.message : "Failed to cancel task.",
      });
      render();
    }
  };

  const handleExportPatch = async () => {
    const task = state.selectedTask;
    const verification = state.verification;
    const diff = state.diff;
    if (
      !task ||
      selectedId !== task.task_id ||
      !verification ||
      !diff ||
      patchExport.busy
    )
      return;
    const expectedPatchSha = verification.patch_sha256 ?? null;
    const blocker = patchExportBlocker(state);
    if (blocker || !verification.candidate?.revision || !expectedPatchSha) {
      patchExport = {
        busy: false,
        error: blocker ?? "Verification does not identify the current patch.",
      };
      render();
      return;
    }
    const pending = { busy: true };
    patchExport = pending;
    render();
    try {
      const exported = await value(
        bridge["tasks.export"]({
          task_id: task.task_id,
          expected_revision: verification.candidate.revision,
          expected_patch_sha256: expectedPatchSha,
        }),
      );
      if (patchExport !== pending) return;
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
      if (patchExport !== pending) return;
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
      if (patchExport !== pending) return;
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
      if (patchExport !== pending) return;
      patchExport = {
        busy: false,
        error: error instanceof Error ? error.message : "Patch export failed.",
      };
      render();
    }
  };

  const handleSavePatch = async () => {
    const task = state.selectedTask;
    const verification = state.verification;
    const diff = state.diff;
    const revision = verification?.candidate?.revision;
    const digest = verification?.patch_sha256;
    if (
      !patchHandoff ||
      !task ||
      selectedId !== task.task_id ||
      !diff ||
      !revision ||
      !digest ||
      patchExport.busy ||
      patchExportBlocker(state) ||
      verification.record?.patch_sha256 !== digest
    )
      return;
    const pending: ExportViewState = { ...patchExport, busy: true };
    delete pending.handoff;
    patchExport = pending;
    render();
    try {
      const bytes = new TextEncoder().encode(
        diff.files.map((file) => file.patch).join(""),
      );
      const reviewedSha = await sha256Hex(bytes, globalThis.crypto.subtle);
      if (patchExport !== pending) return;
      const handoff =
        reviewedSha === digest
          ? await patchHandoff.save({
              task_id: task.task_id,
              expected_revision: revision,
              expected_patch_sha256: digest,
            })
          : {
              status: "blocked" as const,
              reason:
                "The diff does not match the verified patch. Refresh the review and rerun the checks if the mismatch remains.",
            };
      if (patchExport !== pending) return;
      patchExport = { ...pending, busy: false, handoff };
    } catch {
      if (patchExport !== pending) return;
      patchExport = {
        ...pending,
        busy: false,
        handoff: {
          status: "blocked",
          reason: "Patch handoff is unavailable. Try again.",
        },
      };
    }
    render();
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

  const loadOnce = async (background: boolean) => {
    try {
      const described = await value(bridge["workbench.describe"]({}));
      const tasks = await value(bridge["tasks.list"]({}));
      if (!background) await loadTeamBootstrap();
      if (disposed || loadRequested) return;
      const selected =
        tasks.find((task) => task.task_id === selectedId) ?? tasks[0];
      selectTask(selected?.task_id);
      if (
        selected &&
        state.selectedTask &&
        taskKey(selected) !== taskKey(state.selectedTask)
      )
        patchExport = { busy: false };
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
      if (disposed || loadRequested) return;
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
          selectTask(taskId);
          closeTeamChat();
          void load();
        },
        onRefresh: () => void load(),
      };
      if (verification.ok) nextState.verification = verification.value;
      else nextState.verificationError = verification.error;
      const mayHaveNoOutput =
        inspected.status === "pending" || inspected.status === "cancelled";
      if (diff.ok) nextState.diff = diff.value;
      else if (!mayHaveNoOutput || diff.kind !== "not_found")
        nextState.diffError = diff.error;
      if (evidence.ok) nextState.evidence = evidence.value;
      else if (!mayHaveNoOutput || evidence.kind !== "not_found")
        nextState.evidenceError = evidence.error;
      if (!events.ok) nextState.eventsError = events.error;
      if (disposed || loadRequested || selectedId !== selected.task_id) return;
      state = nextState;
      refreshDelay = TASK_REFRESH_MS;
      if (!background || (page === "tasks" && !teamState.open)) render();
    } catch (error) {
      if (disposed || loadRequested) return;
      if (background) {
        // Keep the last task and editable controls usable during a transient outage.
        refreshDelay = Math.min(MAX_REFRESH_MS, refreshDelay * 2);
        return;
      }
      displayError(
        error instanceof Error ? error.message : "Workbench is unavailable.",
      );
    }
  };

  const load = (background = false) => {
    if (disposed) return Promise.resolve();
    cancelRefresh?.();
    cancelRefresh = undefined;
    if (!background) loadRequested = true;
    if (!loadPromise) {
      loadPromise = (async () => {
        if (background) await loadOnce(true);
        while (loadRequested) {
          loadRequested = false;
          await Promise.all([loadAssistant(), loadOnce(false)]);
        }
      })().finally(() => {
        loadPromise = undefined;
        if (disposed) return;
        if (loadRequested) void load();
        else if (state.selectedTask?.status === "running")
          cancelRefresh = scheduleRefresh?.(
            () => void load(true),
            refreshDelay,
          );
      });
    }
    return loadPromise;
  };

  const settled = async () => {
    while (loadPromise) await loadPromise;
  };

  const unsubscribeLibrary = extensions?.onChanged?.(() => {
    if (disposed || page !== "extensions" || teamState.open) return;
    if (extensionState.busy) libraryChanged = true;
    else void refreshExtensions();
  });
  const dispose = () => {
    unsubscribeLibrary?.();
    disposed = true;
    loadRequested = false;
    cancelRefresh?.();
    cancelRefresh = undefined;
  };

  return { load, settled, dispose };
}
