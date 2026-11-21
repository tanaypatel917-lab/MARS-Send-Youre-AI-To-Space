/// <reference lib="dom" />
import {
  buildSend,
  type ComposerEnvironment,
  type ComposerState,
  chipLabel,
  composerProblem,
  EMPTY_COMPOSER,
  keyIntent,
  MAX_MESSAGE_CHARS,
  MAX_REFERENCES_PER_MESSAGE,
  type MentionRepo,
  type MessageView,
  mentionOptionId,
  nextPickerStatus,
  pickerAnnouncement,
  ReactionEmojiSchema,
  type ReferenceView,
  reduceComposer,
} from "@mars/team-chat";
import type {
  PendingSend,
  SelectedConversation,
  TeamChatHostMessage,
  TeamChatViewState,
  TeamChatWebviewMessage,
} from "../../teamChat/messages";
import { button, h } from "../dom";

interface VsCodeApi {
  postMessage(message: TeamChatWebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const app = document.getElementById("app") as HTMLElement;
const REACTIONS = ReactionEmojiSchema.options;

let state: TeamChatViewState | null = null;
let composer: ComposerState = EMPTY_COMPOSER;
let composerConversation: string | null = null;
/** Saved conversation id to re-select on first render; cleared once applied. */
let pendingRestore: string | null | undefined;
let composerError: string | null = null;
/** Focus key of the chip that opened the code panel; focus returns there on close. */
let panelOrigin: string | null = null;
let returnFocusTo: string | null = null;
/** Below this width the code panel is a modal drawer over the inbox and thread. */
const narrowLayout = window.matchMedia("(max-width: 899px)");
/** Panel the drawer showed on the last render; a change means it just opened. */
let drawerPanel: string | null = null;
/** Scroll bookkeeping for the message list across re-renders. */
let anchorOlder: { height: number; top: number } | null = null;
let stickToBottom = true;

// ---------------------------------------------------------------- persistent elements

const scroller = h("div", { class: "messages-scroller" });
scroller.addEventListener("scroll", () => {
  stickToBottom =
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
  jumpButton.hidden = stickToBottom;
  reportViewport();
});
const jumpButton = button("Jump to latest", "jump-latest", () => {
  scroller.scrollTop = scroller.scrollHeight;
  stickToBottom = true;
  jumpButton.hidden = true;
  reportViewport();
});
jumpButton.className = "jump";
jumpButton.hidden = true;

/** `aria-live` region used only for new-message announcements; mounted once outside the re-rendered `#app`. */
const announcer = h("div", { class: "announcer", role: "status" });
announcer.setAttribute("aria-live", "polite");
announcer.setAttribute("aria-atomic", "true");
document.body.append(announcer);
let announcedSeq = 0;

let lastViewport: { focused: boolean; atBottom: boolean } | null = null;
/**
 * Tells the host where the viewport is; it advances the read cursor only when focused and at the bottom.
 * The narrow drawer covers the newest messages, so the bottom never counts as seen while it is open.
 */
function reportViewport(): void {
  const next = {
    focused: document.hasFocus(),
    atBottom: stickToBottom && drawerPanel === null,
  };
  if (
    lastViewport &&
    lastViewport.focused === next.focused &&
    lastViewport.atBottom === next.atBottom
  )
    return;
  lastViewport = next;
  post({ type: "viewport", ...next });
}
window.addEventListener("focus", reportViewport);
window.addEventListener("blur", reportViewport);

const textarea = h("textarea", { label: "Message", role: "combobox" });
textarea.setAttribute("aria-haspopup", "listbox");
textarea.setAttribute("aria-autocomplete", "list");
textarea.rows = 3;
textarea.placeholder =
  "Message… type @ to reference a file, symbol or line range";
textarea.dataset.focusKey = "composer";
textarea.addEventListener("input", () => {
  composerError = null;
  updateComposer({
    type: "input",
    text: textarea.value,
    caret: textarea.selectionStart ?? textarea.value.length,
  });
});
textarea.addEventListener("keydown", (event) => {
  const intent = keyIntent(composer, {
    key: event.key,
    shiftKey: event.shiftKey,
    isComposing: event.isComposing,
  });
  switch (intent) {
    case "none":
    case "newline":
      return;
    case "send":
      event.preventDefault();
      send();
      return;
    case "pickerDown":
      event.preventDefault();
      updateComposer({ type: "pickerMove", delta: 1 });
      return;
    case "pickerUp":
      event.preventDefault();
      updateComposer({ type: "pickerMove", delta: -1 });
      return;
    case "pickerSelect":
      event.preventDefault();
      updateComposer({ type: "pickerSelect" });
      textarea.value = composer.text;
      textarea.setSelectionRange(composer.caret, composer.caret);
      return;
    case "pickerClose":
      event.preventDefault();
      updateComposer({ type: "pickerClose" });
      return;
  }
});

let lastPathSearchKey: string | null = null;
let lastPathSearchDigest = "";

function currentPathSearchKey(
  repos: readonly MentionRepo[],
  pathQuery: string,
): string {
  return `${repos.map((r) => `${r.repo_id}@${r.commit_sha}`).join(",")}:${pathQuery}`;
}

function env(): ComposerEnvironment {
  const base = state?.mention_index ?? { repos: [] };
  const pathQuery = composer.picker?.query.trim().split(":")[0] ?? "";
  const matches =
    pathQuery &&
    lastPathSearchKey === currentPathSearchKey(base.repos, pathQuery)
      ? (state?.path_search ?? [])
      : [];
  const repos =
    matches.length === 0
      ? base.repos
      : base.repos.map((repo) => {
          const byRepo = matches.filter((m) => m.repo_id === repo.repo_id);
          if (byRepo.length === 0) return repo;
          const exact = byRepo.filter((m) => m.commit_sha === repo.commit_sha);
          const matching = exact.length > 0 ? exact : byRepo;
          const commitSha = matching[0]?.commit_sha ?? repo.commit_sha;
          const forCommit = matching.filter((m) => m.commit_sha === commitSha);
          const baseFiles = commitSha === repo.commit_sha ? repo.files : [];
          const seen = new Set(baseFiles.map((f) => f.path));
          const extra = forCommit
            .filter((m) => !seen.has(m.path))
            .map((m) => ({
              path: m.path,
              line_count: 0,
              symbols: [] as { name: string; line: number }[],
            }));
          if (extra.length === 0 && commitSha === repo.commit_sha) return repo;
          return {
            ...repo,
            commit_sha: commitSha,
            files: [...baseFiles, ...extra],
          };
        });
  return {
    index: { ...base, repos },
    activeRepoId: repos[0]?.repo_id ?? null,
    maxChips: MAX_REFERENCES_PER_MESSAGE,
  };
}

function maybeRequestPathSearch(): void {
  const pickerState = composer.picker;
  if (!pickerState) {
    lastPathSearchKey = null;
    lastPathSearchDigest = "";
    return;
  }
  if (!state?.capabilities.references) return;
  const repos = state.mention_index.repos;
  if (repos.length === 0) return;
  const pathQuery = pickerState.query.trim().split(":")[0] ?? "";
  if (!pathQuery) return;
  const key = currentPathSearchKey(repos, pathQuery);
  if (key === lastPathSearchKey) return;
  lastPathSearchKey = key;
  lastPathSearchDigest = "";
  for (const repo of repos) {
    post({
      type: "searchPaths",
      repoId: repo.repo_id,
      commitSha: repo.commit_sha,
      query: pathQuery,
      limit: 20,
    });
  }
}

function updateComposer(action: Parameters<typeof reduceComposer>[1]): void {
  const next = reduceComposer(composer, action, env());
  if (next === composer) return;
  composer = next;
  maybeRequestPathSearch();
  renderComposerParts();
}

const AGENT_MENTION = /(?:^|\s)@MARS(?:\s|$)/;

const clientIdPrefix = (() => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
})();
let clientIdCounter = 0;
function newClientMessageId(): string {
  clientIdCounter += 1;
  return `cm_${clientIdPrefix}_${clientIdCounter}`;
}

function send(): void {
  const selected = state?.selected;
  if (!selected) return;
  const problem = composerProblem(composer);
  if (problem === "too_long") {
    composerError = `Message is ${composer.text.trim().length} characters; the limit is ${MAX_MESSAGE_CHARS}. Shorten it or split it.`;
    renderComposerParts();
    return;
  }
  const input = buildSend(
    composer,
    selected.conversation.conversation_id,
    newClientMessageId(),
  );
  if (!input) return;
  if (state?.capabilities.agent && AGENT_MENTION.test(input.body)) {
    const contextMessages = composer.reply_to
      ? selected.messages.filter(
          (m) => m.message_id === composer.reply_to?.message_id,
        )
      : selected.messages.slice(-10);
    const messageIds =
      contextMessages.length > 0
        ? contextMessages.map((m) => m.message_id)
        : composer.reply_to
          ? [composer.reply_to.message_id]
          : [];
    const hasQuestionOrRefs =
      input.body.replace(/@MARS/g, "").trim().length > 0 ||
      input.references.length > 0;
    if (!hasQuestionOrRefs && messageIds.length === 0) {
      composerError =
        "Send a message in this conversation before asking @MARS.";
      renderComposerParts();
      return;
    }
    const referenceIds = Array.from(
      new Set(
        contextMessages.flatMap((m) =>
          m.references.map((ref) => ref.reference_id),
        ),
      ),
    ).slice(-MAX_REFERENCES_PER_MESSAGE);
    composerError = null;
    post({
      type: "agentPreview",
      conversationId: selected.conversation.conversation_id,
      messageIds,
      referenceIds,
      ...(hasQuestionOrRefs
        ? {
            draft: {
              clientMessageId: input.client_message_id,
              body: input.body,
              replyTo: input.reply_to,
              references: input.references,
            },
          }
        : {}),
    });
    if (hasQuestionOrRefs) {
      composer = EMPTY_COMPOSER;
      textarea.value = "";
      stickToBottom = true;
    }
    renderComposerParts();
    return;
  }
  vscode.postMessage({
    type: "send",
    conversationId: input.conversation_id,
    clientMessageId: input.client_message_id,
    body: input.body,
    replyTo: input.reply_to,
    references: input.references,
  });
  composer = EMPTY_COMPOSER;
  composerError = null;
  textarea.value = "";
  stickToBottom = true;
  renderComposerParts();
}

// ---------------------------------------------------------------- helpers

function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function chipText(reference: ReferenceView): string {
  if (reference.state === "restricted") return "Restricted reference";
  return chipLabel(
    {
      kind: reference.kind,
      repo_id: reference.repo_id,
      commit_sha: reference.commit_sha,
      path: reference.path,
      line_start: reference.line_start,
      line_end: reference.line_end,
      symbol: reference.symbol,
    },
    reference.repo_name,
  );
}

function post(message: TeamChatWebviewMessage): void {
  vscode.postMessage(message);
}

// ---------------------------------------------------------------- inbox pane

const CONNECTION_TEXT: Record<TeamChatViewState["connection"], string> = {
  offline: "Offline",
  connecting: "Connecting…",
  live: "Live",
  polling: "Polling",
  retrying: "Reconnecting…",
  unauthenticated: "No token",
  disabled: "Disabled by host",
};

let searchDraft = "";
/** Search hit already scrolled into view; re-renders keep the outline but do not move the thread again. */
let scrolledToHit: string | null = null;

function renderSearch(s: TeamChatViewState): HTMLElement {
  const input = h("input", { label: "Search messages" });
  input.type = "search";
  input.placeholder = "Search messages…";
  input.value = searchDraft;
  input.dataset.focusKey = "search";
  input.addEventListener("input", () => {
    searchDraft = input.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const query = input.value.trim();
      if (query) post({ type: "search", query });
      else post({ type: "clearSearch" });
    } else if (event.key === "Escape") {
      event.preventDefault();
      searchDraft = "";
      input.value = "";
      post({ type: "clearSearch" });
    }
  });
  const results = h("ul", { class: "search-results", label: "Search results" });
  if (s.search) {
    const title = h(
      "li",
      { class: "muted small row" },
      h(
        "span",
        { class: "grow" },
        s.search.hits.length === 0
          ? "No matches."
          : `${s.search.hits.length} match(es)`,
      ),
      button(
        "Clear",
        "clear-search",
        () => {
          searchDraft = "";
          returnFocusTo = "search";
          post({ type: "clearSearch" });
        },
        { secondary: true },
      ),
    );
    results.append(title);
    for (const hit of s.search.hits) {
      const where = s.conversations.find(
        (c) => c.conversation_id === hit.conversation_id,
      );
      const open = button(
        "",
        `hit-${hit.message_id}`,
        () => {
          stickToBottom = false;
          scrolledToHit = null;
          post({
            type: "openSearchHit",
            conversationId: hit.conversation_id,
            messageId: hit.message_id,
            sequence: hit.sequence,
          });
        },
        { secondary: true },
      );
      open.className = "search-hit";
      open.append(
        h(
          "span",
          { class: "small muted" },
          `${hit.author_name} · ${where?.title ?? "Conversation"} · #${hit.sequence}`,
        ),
        h("span", { class: "body" }, hit.body),
      );
      results.append(h("li", {}, open));
    }
  }
  return h("div", { class: "search-row" }, input, results);
}

function renderInbox(s: TeamChatViewState): HTMLElement {
  const viewerSelect = h("select", { key: "viewer" });
  viewerSelect.id = "viewer-select";
  for (const user of s.viewers) {
    const option = h("option", {}, `${user.display_name} (@${user.handle})`);
    option.value = user.user_id;
    option.selected = user.user_id === s.viewer.user_id;
    viewerSelect.append(option);
  }
  viewerSelect.addEventListener("change", () => {
    composer = EMPTY_COMPOSER;
    textarea.value = "";
    post({ type: "fixtureSwitchViewer", userId: viewerSelect.value });
  });
  const viewerLabel = h("label", { class: "small muted" }, "Viewing as");
  viewerLabel.htmlFor = viewerSelect.id;
  const list = h("ul", { class: "conversations", label: "Conversations" });
  for (const conversation of s.conversations) {
    const active =
      s.selected?.conversation.conversation_id === conversation.conversation_id;
    const open = button(
      "",
      `conv-${conversation.conversation_id}`,
      () => {
        stickToBottom = true;
        post({
          type: "selectConversation",
          conversationId: conversation.conversation_id,
        });
      },
      { secondary: !active },
    );
    open.className = `conversation ${active ? "active" : ""} ${conversation.unread_count > 0 ? "unread" : ""}`;
    open.setAttribute("aria-pressed", String(active));
    open.append(
      h(
        "span",
        { class: "conversation-title" },
        h(
          "span",
          { class: "kind" },
          conversation.kind === "dm" ? "DM" : "Group",
        ),
        h("span", { class: "grow" }, conversation.title),
        conversation.unread_count > 0
          ? h(
              "span",
              {
                class: "unread-badge",
                label: `${conversation.unread_count} unread`,
              },
              String(conversation.unread_count),
            )
          : null,
      ),
      h(
        "span",
        { class: "conversation-excerpt muted small" },
        conversation.last_message
          ? `${conversation.last_message.author_id === s.viewer.user_id ? "You" : conversation.title.split(" ")[0]}: ${conversation.last_message.excerpt}`
          : "No messages yet.",
      ),
    );
    const pin = button(
      conversation.pinned ? "Unpin" : "Pin",
      `pin-${conversation.conversation_id}`,
      () =>
        post({
          type: "togglePin",
          conversationId: conversation.conversation_id,
        }),
      { secondary: true, title: "Pinning changes only your inbox" },
    );
    pin.className = `pin-toggle ${conversation.pinned ? "pinned" : ""}`;
    pin.setAttribute("aria-pressed", String(conversation.pinned));
    list.append(h("li", { class: "conversation-row" }, open, pin));
  }
  if (s.conversations.length === 0)
    list.append(h("li", { class: "muted" }, "No conversations."));
  return h(
    "section",
    { class: "pane inbox", label: "Inbox" },
    h(
      "header",
      { class: "pane-header" },
      h("h2", {}, "Team Chat"),
      h(
        "span",
        {
          class: "fixture-badge",
          title:
            s.label === "FIXTURE"
              ? "Deterministic local fixture data"
              : "Connected to the team service",
        },
        s.label,
      ),
      s.label === "SERVICE"
        ? h(
            "span",
            { class: `connection ${s.connection}`, role: "status" },
            CONNECTION_TEXT[s.connection],
          )
        : null,
    ),
    s.viewers.length > 0
      ? h("div", { class: "viewer-row" }, viewerLabel, viewerSelect)
      : h(
          "div",
          { class: "viewer-row small muted" },
          `Signed in as ${s.viewer.display_name}`,
        ),
    renderSearch(s),
    list,
  );
}

// ---------------------------------------------------------------- thread pane

function renderReactions(
  s: TeamChatViewState,
  message: MessageView,
): HTMLElement | null {
  if (!s.capabilities.reactions) return null;
  const row = h("div", { class: "reactions", label: "Reactions" });
  for (const emoji of REACTIONS) {
    const existing = message.reactions.find((r) => r.emoji === emoji);
    const toggle = button(
      existing ? `${emoji} ${existing.count}` : emoji,
      `react-${message.message_id}-${emoji}`,
      () =>
        post({ type: "toggleReaction", messageId: message.message_id, emoji }),
      {
        secondary: true,
        title: existing?.mine ? "Remove your reaction" : "React",
      },
    );
    toggle.className = `reaction ${existing ? "set" : "unset"} ${existing?.mine ? "mine" : ""}`;
    toggle.setAttribute("aria-pressed", String(!!existing?.mine));
    row.append(toggle);
  }
  return row;
}

function renderChips(
  message: MessageView,
  panelRef: string | null,
): HTMLElement {
  const row = h("div", { class: "chips", label: "Code references" });
  for (const reference of message.references) {
    const key = `chip-${message.message_id}-${reference.reference_id}`;
    const chip = button(
      chipText(reference),
      key,
      () => {
        if (reference.state === "restricted") return;
        panelOrigin = key;
        post({
          type: "openReference",
          messageId: message.message_id,
          referenceId: reference.reference_id,
        });
      },
      {
        secondary: true,
        disabled: reference.state === "restricted",
        title:
          reference.state === "restricted"
            ? "You are a member of this conversation but have no access to that repo"
            : `Open ${reference.path} at ${reference.commit_sha}`,
      },
    );
    chip.className = `chip ${reference.state} ${panelRef === reference.reference_id ? "open" : ""}`;
    chip.setAttribute(
      "aria-pressed",
      String(panelRef === reference.reference_id),
    );
    row.append(chip);
  }
  return row;
}

function messageFocusKey(messageId: string): string {
  return `message-${messageId}`;
}

function renderMessage(
  s: TeamChatViewState,
  message: MessageView,
  panelRef: string | null,
): HTMLElement {
  const mine = message.author_id === s.viewer.user_id;
  const reply = message.reply_to
    ? button(
        `↩ ${message.reply_to.author_name}: ${message.reply_to.excerpt}`,
        `quote-${message.message_id}`,
        () => {
          const target = scroller.querySelector<HTMLElement>(
            `[data-message-id="${CSS.escape(message.reply_to?.message_id ?? "")}"]`,
          );
          target?.scrollIntoView({ block: "center" });
          target?.classList.add("flash");
          target?.focus({ preventScroll: true });
        },
        { secondary: true, title: "Jump to the replied message" },
      )
    : null;
  if (reply) reply.className = "reply-quote";
  const item = h(
    "li",
    {
      class: `message ${mine ? "mine" : ""} ${s.selected?.highlight_message_id === message.message_id ? "highlight" : ""}`,
      key: messageFocusKey(message.message_id),
    },
    h(
      "div",
      { class: "message-head" },
      h("strong", {}, message.author_name),
      h("span", { class: "muted small" }, time(message.created_at)),
      h(
        "span",
        { class: "muted small mono seq", title: "server sequence" },
        `#${message.sequence}`,
      ),
      button(
        "Reply",
        `reply-${message.message_id}`,
        () => {
          updateComposer({
            type: "setReply",
            reply: {
              message_id: message.message_id,
              author_name: message.author_name,
              excerpt: message.body.slice(0, 80),
            },
          });
          textarea.focus();
        },
        { secondary: true },
      ),
    ),
    reply,
    h("p", { class: "body" }, message.body),
    message.references.length > 0 ? renderChips(message, panelRef) : null,
    renderReactions(s, message),
  );
  item.dataset.messageId = message.message_id;
  // Jump targets (reply quote, search hit) receive focus programmatically.
  item.tabIndex = -1;
  return item;
}

function discardButton(item: PendingSend): HTMLButtonElement {
  return button(
    "Discard",
    `discard-${item.client_message_id}`,
    () => {
      returnFocusTo = "composer";
      post({ type: "discardSend", clientMessageId: item.client_message_id });
    },
    { secondary: true },
  );
}

function renderPending(item: PendingSend): HTMLElement {
  const status =
    item.status === "pending"
      ? h("span", { class: "status pending", role: "status" }, "Sending…")
      : h(
          "span",
          { class: `status ${item.status}`, role: "alert" },
          `${item.status === "conflict" ? "Not sent" : "Failed"}: ${item.reason ?? "unknown"}`,
        );
  const actions = h("div", { class: "row" });
  if (item.status === "conflict")
    actions.append(
      button("Edit and resend", `edit-${item.client_message_id}`, () => {
        // The old id is burnt on the server; the draft comes back to the
        // composer and the next send gets a fresh client message id.
        textarea.value = item.body;
        updateComposer({
          type: "input",
          text: item.body,
          caret: item.body.length,
        });
        post({ type: "discardSend", clientMessageId: item.client_message_id });
        returnFocusTo = "composer";
      }),
      discardButton(item),
    );
  if (item.status === "failed")
    actions.append(
      button("Retry", `retry-${item.client_message_id}`, () => {
        returnFocusTo = "composer";
        post({ type: "retrySend", clientMessageId: item.client_message_id });
      }),
      discardButton(item),
    );
  return h(
    "li",
    { class: `message mine ${item.status}` },
    h("div", { class: "message-head" }, h("strong", {}, "You"), status),
    h("p", { class: "body" }, item.body || "(references only)"),
    item.reference_count > 0
      ? h(
          "p",
          { class: "muted small" },
          `${item.reference_count} reference(s) attached`,
        )
      : null,
    actions,
  );
}

function renderThread(
  s: TeamChatViewState,
  selected: SelectedConversation,
): HTMLElement {
  const conversation = selected.conversation;
  const list = h("ol", { class: "messages", label: "Messages" });
  if (selected.older_cursor) {
    const cursor = selected.older_cursor;
    list.append(
      h(
        "li",
        { class: "load-older" },
        button(
          "Load older messages",
          "load-older",
          () => {
            anchorOlder = {
              height: scroller.scrollHeight,
              top: scroller.scrollTop,
            };
            post({
              type: "loadOlder",
              conversationId: conversation.conversation_id,
              cursor,
            });
          },
          { secondary: true },
        ),
      ),
    );
  }
  if (selected.older_blocked)
    list.append(
      h(
        "li",
        { class: "muted small load-older", role: "status" },
        "Older messages exist but are not loaded (in-memory limit reached).",
      ),
    );
  const panelRef = s.panel?.reference_id ?? null;
  for (const message of selected.messages) {
    if (selected.divider_sequence === message.sequence)
      list.append(
        h(
          "li",
          { class: "divider", role: "separator", label: "New messages" },
          h("span", {}, "New messages"),
        ),
      );
    list.append(
      renderMessage(
        s,
        message,
        s.panel?.message_id === message.message_id ? panelRef : null,
      ),
    );
  }
  for (const item of s.pending)
    if (item.conversation_id === conversation.conversation_id)
      list.append(renderPending(item));
  if (selected.messages.length === 0 && s.pending.length === 0)
    list.append(h("li", { class: "muted" }, "No messages yet."));
  scroller.replaceChildren(list);
  const pin = button(
    conversation.pinned ? "Unpin" : "Pin",
    "thread-pin",
    () =>
      post({ type: "togglePin", conversationId: conversation.conversation_id }),
    { secondary: true },
  );
  pin.setAttribute("aria-pressed", String(conversation.pinned));
  return h(
    "section",
    { class: "pane thread", label: "Conversation" },
    h(
      "header",
      { class: "pane-header" },
      h(
        "div",
        { class: "grow" },
        h("h2", {}, conversation.title),
        h(
          "span",
          { class: "muted small" },
          `${conversation.kind === "dm" ? "Direct message" : "Group"} · ${conversation.member_ids.length} members · read to #${conversation.read_cursor}`,
        ),
      ),
      pin,
    ),
    s.notice
      ? h(
          "div",
          {
            class: `notice ${s.notice.kind}`,
            role: s.notice.kind === "error" ? "alert" : "status",
          },
          s.notice.text,
        )
      : null,
    h("div", { class: "thread-body" }, scroller, jumpButton),
    composerRoot,
  );
}

// ---------------------------------------------------------------- composer

const composerRoot = h("div", { class: "composer" });
const agentBar = h("div", { class: "reply-bar agent-bar" });
const replyBar = h("div", { class: "reply-bar" });
const chipBar = h("div", { class: "chip-bar", label: "Attached references" });
const picker = h("ul", {
  class: "picker",
  role: "listbox",
  label: "Mention picker",
});
picker.id = "mention-picker";
/** Polite status for picker results; separate from the message announcer. */
const pickerStatus = h("div", { class: "announcer", role: "status" });
pickerStatus.setAttribute("aria-live", "polite");
pickerStatus.setAttribute("aria-atomic", "true");
let announcedPicker = pickerAnnouncement(null);
const sendButton = button("Send", "send", () => send());
const composerAlert = h("p", {
  class: "notice error composer-error",
  role: "alert",
});
const hint = h(
  "p",
  { class: "hint" },
  "Enter to send · Shift+Enter for a newline · @ to reference a file, symbol or path:start-end",
);
composerRoot.append(
  agentBar,
  replyBar,
  chipBar,
  h("div", { class: "composer-input" }, picker, textarea, sendButton),
  composerAlert,
  hint,
  pickerStatus,
);

function renderComposerParts(): void {
  agentBar.replaceChildren();
  const selectedConversationId =
    state?.selected?.conversation.conversation_id ?? null;
  const preview =
    state?.agent_preview &&
    state.agent_preview.conversation_id === selectedConversationId
      ? state.agent_preview
      : null;
  const request =
    state?.agent_request &&
    state.agent_request.conversation_id === selectedConversationId
      ? state.agent_request
      : null;
  if (preview) {
    const previewMessageIds = preview.items
      .filter(
        (item): item is typeof item & { message_id: string } =>
          item.kind === "message" && typeof item.message_id === "string",
      )
      .map((item) => item.message_id);
    const previewReferenceIds = preview.items
      .filter(
        (item): item is typeof item & { reference_id: string } =>
          item.kind === "reference" && typeof item.reference_id === "string",
      )
      .map((item) => item.reference_id);
    const restrictedSet = new Set(preview.restricted_reference_ids);
    const allowedReferenceIds = previewReferenceIds.filter(
      (refId) => !restrictedSet.has(refId),
    );
    const totalBytes = preview.items.reduce((sum, item) => sum + item.bytes, 0);
    const restricted =
      preview.restricted_reference_ids.length > 0
        ? ` · ${preview.restricted_reference_ids.length} restricted ref(s) blocked`
        : "";
    const confirm =
      preview.restricted_reference_ids.length > 0
        ? button("Preview without restricted refs", "agent-repreview", () => {
            post({
              type: "agentPreview",
              conversationId: preview.conversation_id,
              messageIds: previewMessageIds,
              referenceIds: allowedReferenceIds,
            });
          })
        : button("Confirm @MARS", "agent-confirm", () => {
            post({
              type: "agentRequest",
              conversationId: preview.conversation_id,
              messageIds: previewMessageIds,
              referenceIds: allowedReferenceIds,
              idempotencyKey: `agent_${preview.preview_sha256.slice(0, 16)}_${newClientMessageId()}`,
              previewSha256: preview.preview_sha256,
            });
            composer = EMPTY_COMPOSER;
            composerError = null;
            textarea.value = "";
            stickToBottom = true;
            renderComposerParts();
          });
    const cancel = button(
      "Cancel",
      "agent-cancel-preview",
      () => {
        post({ type: "clearAgent" });
        textarea.focus();
      },
      { secondary: true },
    );
    agentBar.append(
      h(
        "span",
        { class: "small" },
        `@MARS preview: ${previewMessageIds.length} message(s), ${previewReferenceIds.length} ref(s), ${totalBytes}B (${preview.model.model_id})${restricted}`,
      ),
      confirm,
      cancel,
    );
  } else if (request) {
    const active = request.status === "pending" || request.status === "running";
    const action = active
      ? button(
          "Cancel @MARS",
          "agent-cancel-request",
          () => post({ type: "agentCancel", requestId: request.request_id }),
          { secondary: true },
        )
      : button("Dismiss", "agent-dismiss", () => post({ type: "clearAgent" }), {
          secondary: true,
        });
    agentBar.append(
      h("span", { class: "small" }, `@MARS request: ${request.status}`),
      action,
    );
  }
  agentBar.hidden = !preview && !request;
  replyBar.replaceChildren();
  if (composer.reply_to) {
    const clear = button(
      "×",
      "clear-reply",
      () => {
        updateComposer({ type: "clearReply" });
        textarea.focus();
      },
      {
        secondary: true,
        title: "Remove reply context",
      },
    );
    clear.setAttribute("aria-label", "Remove reply context");
    replyBar.append(
      h(
        "span",
        { class: "small" },
        `Replying to ${composer.reply_to.author_name}: ${composer.reply_to.excerpt}`,
      ),
      clear,
    );
  }
  replyBar.hidden = !composer.reply_to;
  chipBar.replaceChildren();
  composer.chips.forEach((chip, index) => {
    const label = chipLabel(chip.reference, chip.repo_name);
    const remove = button(
      `${label} ×`,
      `draft-chip-${chip.key}`,
      () => {
        updateComposer({ type: "removeChip", key: chip.key });
        const remaining = chipBar.querySelectorAll<HTMLElement>("button");
        (remaining[Math.min(index, remaining.length - 1)] ?? textarea).focus();
      },
      { secondary: true, title: "Remove reference" },
    );
    remove.setAttribute("aria-label", `Remove reference ${label}`);
    remove.className = "chip draft";
    chipBar.append(remove);
  });
  chipBar.hidden = composer.chips.length === 0;
  picker.replaceChildren();
  if (composer.picker) {
    const { candidates, selected } = composer.picker;
    if (candidates.length === 0)
      picker.append(
        h(
          "li",
          { class: "muted small", role: "presentation" },
          "No matching file, symbol or range.",
        ),
      );
    candidates.forEach((candidate, index) => {
      const option = h(
        "li",
        {
          class: `candidate ${index === selected ? "selected" : ""}`,
          role: "option",
        },
        h("span", { class: `badge k-${candidate.kind}` }, candidate.kind),
        h("span", { class: "mono" }, candidate.label),
        h("span", { class: "muted small" }, candidate.detail),
      );
      option.id = mentionOptionId(index, candidate);
      option.setAttribute("aria-selected", String(index === selected));
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        composer = {
          ...composer,
          picker: {
            ...(composer.picker as NonNullable<typeof composer.picker>),
            selected: index,
          },
        };
        updateComposer({ type: "pickerSelect" });
        textarea.value = composer.text;
        textarea.setSelectionRange(composer.caret, composer.caret);
        textarea.focus();
      });
      picker.append(option);
    });
    const active = candidates[selected];
    if (active)
      textarea.setAttribute(
        "aria-activedescendant",
        mentionOptionId(selected, active),
      );
    else textarea.removeAttribute("aria-activedescendant");
    textarea.setAttribute("aria-expanded", "true");
  } else {
    textarea.removeAttribute("aria-activedescendant");
    textarea.setAttribute("aria-expanded", "false");
  }
  textarea.setAttribute("aria-controls", picker.id);
  picker.hidden = !composer.picker;
  const announcement = pickerAnnouncement(composer.picker);
  const status = nextPickerStatus(announcedPicker, announcement);
  if (status !== null) pickerStatus.textContent = status;
  announcedPicker = announcement;
  composerAlert.textContent = composerError ?? "";
  composerAlert.hidden = composerError === null;
  sendButton.disabled =
    !state?.selected || composerProblem(composer) === "empty";
}

// ---------------------------------------------------------------- code pane

function closePanel(): void {
  returnFocusTo = panelOrigin;
  post({ type: "closeReference" });
}

function renderCodePane(
  s: TeamChatViewState,
  drawer: boolean,
): HTMLElement | null {
  const panel = s.panel;
  if (!panel) return null;
  const close = button("Close", "close-panel", closePanel, {
    secondary: true,
  });
  const preview = panel.preview;
  let content: HTMLElement;
  let title = "Reference";
  let subtitle = "";
  if (preview.state === "ok") {
    title = preview.path;
    subtitle = `${preview.repo_name} @ ${preview.short_sha}${preview.symbol ? ` · ${preview.symbol}` : ""}${preview.highlight ? ` · lines ${preview.highlight.start}-${preview.highlight.end}` : ""}`;
    const code = h("pre", {
      class: "code",
      label: `${preview.path} at ${preview.commit_sha}`,
    });
    for (const line of preview.lines) {
      const highlighted =
        preview.highlight !== null &&
        line.number >= preview.highlight.start &&
        line.number <= preview.highlight.end;
      const row = h(
        "div",
        { class: `line ${highlighted ? "hl" : ""}` },
        h("span", { class: "ln" }, String(line.number)),
        h("span", { class: "lt" }, line.text),
      );
      if (highlighted && line.number === preview.highlight?.start)
        row.dataset.firstHighlight = "true";
      code.append(row);
    }
    content = code;
  } else if (preview.state === "restricted") {
    content = h(
      "p",
      { class: "notice info" },
      "Restricted reference: you are a member of this conversation but have no access to the referenced repo. No path, revision or excerpt is shown.",
    );
  } else {
    content = h(
      "p",
      { class: "notice error" },
      "Unavailable: the referenced revision or path cannot be resolved.",
    );
  }
  const pane = h(
    drawer ? "div" : "aside",
    {
      class: "pane code",
      label: "Code panel",
      ...(drawer ? { role: "dialog" } : {}),
    },
    h(
      "header",
      { class: "pane-header" },
      h(
        "div",
        { class: "grow" },
        h("h2", { class: "mono" }, title),
        h("span", { class: "muted small" }, subtitle),
        h(
          "span",
          { class: "muted small mono" },
          preview.state === "ok" ? preview.commit_sha : "",
        ),
      ),
      close,
    ),
    content,
  );
  if (drawer) pane.setAttribute("aria-modal", "true");
  return pane;
}

// ---------------------------------------------------------------- render

function render(): void {
  if (!state) return;
  const s = state;
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset
    ?.focusKey;
  const selectedId = s.selected?.conversation.conversation_id ?? null;
  if (selectedId !== composerConversation) {
    composerConversation = selectedId;
    composer = EMPTY_COMPOSER;
    lastPathSearchKey = null;
    textarea.value = "";
    anchorOlder = null;
    stickToBottom = true;
  }
  const drawer = s.panel !== null && narrowLayout.matches;
  const panelId = s.panel
    ? `${s.panel.message_id}:${s.panel.reference_id}`
    : null;
  const drawerOpened = drawer && panelId !== drawerPanel;
  drawerPanel = drawer ? panelId : null;
  const code = renderCodePane(s, drawer);
  const layout = h(
    "div",
    { class: `layout ${code ? "with-code" : ""}` },
    renderInbox(s),
    s.selected
      ? renderThread(s, s.selected)
      : h(
          "section",
          { class: "pane thread" },
          h(
            "p",
            { class: "muted" },
            s.notice?.text ?? "Select a conversation.",
          ),
        ),
    code,
  );
  if (drawer) {
    for (const pane of Array.from(layout.children))
      if (pane !== code) (pane as HTMLElement).inert = true;
  }
  app.replaceChildren(layout);
  if (s.announcement && s.announcement.seq !== announcedSeq) {
    announcedSeq = s.announcement.seq;
    announcer.textContent = s.announcement.text;
  }
  renderComposerParts();
  if (anchorOlder) {
    scroller.scrollTop =
      scroller.scrollHeight - anchorOlder.height + anchorOlder.top;
    anchorOlder = null;
  } else if (stickToBottom) {
    scroller.scrollTop = scroller.scrollHeight;
  }
  const highlightId = s.selected?.highlight_message_id ?? null;
  if (highlightId && highlightId !== scrolledToHit) {
    const target = scroller.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(highlightId)}"]`,
    );
    if (target) {
      scrolledToHit = highlightId;
      target.scrollIntoView({ block: "center" });
      stickToBottom = false;
      returnFocusTo = messageFocusKey(highlightId);
    }
  } else if (!highlightId) scrolledToHit = null;
  jumpButton.hidden = stickToBottom;
  reportViewport();
  const first = code?.querySelector<HTMLElement>("[data-first-highlight]");
  first?.scrollIntoView({ block: "center" });
  const wanted = returnFocusTo ?? focusKey;
  returnFocusTo = null;
  const byKey = (key: string) =>
    Array.from(app.querySelectorAll<HTMLElement>("[data-focus-key]")).find(
      (element) => element.dataset.focusKey === key,
    );
  // The focused control left the DOM (e.g. a resolved pending send): land
  // on the composer instead of letting focus fall to <body>.
  let target = wanted
    ? (byKey(wanted) ?? (textarea.isConnected ? textarea : undefined))
    : undefined;
  if (code && drawer && (drawerOpened || (target && !code.contains(target))))
    target = byKey("close-panel");
  target?.focus();
  if (pendingRestore === undefined) {
    // First render: read the saved selection before anything overwrites it.
    const saved = vscode.getState() as { conversationId?: unknown } | undefined;
    pendingRestore =
      typeof saved?.conversationId === "string" &&
      saved.conversationId !== selectedId &&
      s.conversations.some((c) => c.conversation_id === saved.conversationId)
        ? saved.conversationId
        : null;
    if (pendingRestore)
      post({ type: "selectConversation", conversationId: pendingRestore });
  }
  if (pendingRestore !== null && pendingRestore === selectedId)
    pendingRestore = null;
  if (pendingRestore === null && s.selected)
    vscode.setState({ conversationId: selectedId });
}

window.addEventListener(
  "message",
  (event: MessageEvent<TeamChatHostMessage>) => {
    const message = event.data;
    if (message?.type === "state") {
      state = message.state;
      const digest = JSON.stringify(state.path_search ?? []);
      if (digest !== lastPathSearchDigest) {
        lastPathSearchDigest = digest;
        if (composer.picker) {
          composer = reduceComposer(
            composer,
            { type: "input", text: composer.text, caret: composer.caret },
            env(),
          );
        }
      }
      render();
    } else if (message?.type === "focusComposer") {
      textarea.focus();
    }
  },
);

document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    state?.panel &&
    narrowLayout.matches
  ) {
    event.preventDefault();
    closePanel();
  }
});
narrowLayout.addEventListener("change", render);

post({ type: "ready" });
