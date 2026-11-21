import type {
  ConversationPage,
  ConversationSummary,
  MessageView,
  ReactionEmoji,
  ReferencePreview,
  TeamCapabilities,
  TeamServiceLabel,
  UserView,
} from "@mars/team-chat";
import { h, type ShellDocument, type ShellElement } from "./dom";
import { untrusted } from "./untrusted";

export interface TeamChatViewState {
  available: boolean;
  open: boolean;
  loading?: boolean;
  error?: string;
  label?: TeamServiceLabel;
  capabilities?: TeamCapabilities;
  viewer?: string;
  users: UserView[];
  conversations: ConversationSummary[];
  activeConversationId?: string;
  activeView?: ConversationPage;
  draft: string;
  searchQuery: string;
  searchHits?: MessageView[];
  resolvedRefs: Record<string, ReferencePreview>;
  onClose?: () => void;
  onSelectConversation?: (conversationId: string) => void;
  onDraftChange?: (text: string) => void;
  onSend?: (text: string) => void;
  onTogglePin?: (conversationId: string, pinned: boolean) => void;
  onToggleReaction?: (
    messageId: string,
    emoji: ReactionEmoji,
    on: boolean,
  ) => void;
  onResolveReference?: (messageId: string, referenceId: string) => void;
  onSearch?: (query: string) => void;
  onSwitchViewer?: (viewer: string) => void;
  onLoadOlder?: () => void;
}

const QUICK_REACTIONS: ReactionEmoji[] = ["👍", "✅", "👀", "🎉"];

function conversationTitle(
  conv: ConversationSummary,
  users: readonly UserView[],
  viewer: string | undefined,
): string {
  if (conv.title) return conv.title;
  if (conv.kind === "dm") {
    const otherId = conv.member_ids.find((id) => id !== viewer);
    const other = users.find((u) => u.user_id === otherId);
    if (other) return `@${other.display_name}`;
  }
  return conv.conversation_id;
}

function renderMessage(
  doc: ShellDocument,
  message: MessageView,
  state: TeamChatViewState,
): ShellElement {
  const author =
    message.author_name ||
    state.users.find((u) => u.user_id === message.author_id)?.display_name ||
    message.author_id;

  const refNodes = message.references.map((ref) => {
    const key = `${message.message_id}:${ref.reference_id}`;
    const resolved = state.resolvedRefs[key];
    const refLabel =
      ref.state === "ok"
        ? `Inspect ${ref.path}`
        : `Ref ${ref.reference_id} (restricted)`;
    const resolveBtn = h(
      doc,
      "button",
      {
        type: "button",
        class: "team-ref-btn",
        "data-ref-id": ref.reference_id,
      },
      resolved ? `Ref ${ref.reference_id} (${resolved.state})` : refLabel,
    );
    resolveBtn.addEventListener("click", () =>
      state.onResolveReference?.(message.message_id, ref.reference_id),
    );
    let preview: ShellElement | null = null;
    if (resolved) {
      if (resolved.state === "ok") {
        preview = untrusted(
          doc,
          resolved.lines.map((l) => `${l.number}: ${l.text}`).join("\n"),
          `team chat reference · ${resolved.path}`,
        );
      } else {
        preview = h(
          doc,
          "p",
          { class: "muted" },
          `Reference ${resolved.reference_id}: ${resolved.state}`,
        );
      }
    }
    return h(doc, "div", { class: "team-ref" }, resolveBtn, preview);
  });

  const reactionBar = state.capabilities?.reactions
    ? h(
        doc,
        "div",
        { class: "team-reactions" },
        ...QUICK_REACTIONS.map((emoji) => {
          const existing = message.reactions.find((r) => r.emoji === emoji);
          const count = existing?.count ?? 0;
          const active = existing?.mine ?? false;
          const btn = h(
            doc,
            "button",
            {
              type: "button",
              class: `team-reaction-btn${active ? " active" : ""}`,
              "aria-pressed": active ? "true" : "false",
              "data-reaction": emoji,
            },
            count > 0 ? `${emoji} ${count}` : emoji,
          );
          btn.addEventListener("click", () =>
            state.onToggleReaction?.(message.message_id, emoji, !active),
          );
          return btn;
        }),
      )
    : null;

  return h(
    doc,
    "article",
    { class: "team-message", "data-message-id": message.message_id },
    h(
      doc,
      "div",
      { class: "team-message-header" },
      h(doc, "strong", {}, author),
      h(
        doc,
        "span",
        { class: "muted" },
        `#${message.sequence} · ${message.created_at}`,
      ),
    ),
    untrusted(doc, message.body, `team chat · ${author}`),
    ...(refNodes.length > 0 ? refNodes : []),
    reactionBar,
  );
}

export function renderTeamChatPane(
  doc: ShellDocument,
  state: TeamChatViewState,
): ShellElement {
  const closeBtn = h(
    doc,
    "button",
    {
      type: "button",
      class: "team-close-btn",
      "data-focus-key": "team-chat-close",
    },
    "Back to workbench",
  );
  closeBtn.addEventListener("click", () => state.onClose?.());

  let viewerControl: ShellElement | null = null;
  if (state.label === "FIXTURE" && state.users.length > 1) {
    const select = h(
      doc,
      "select",
      {
        class: "team-viewer-select",
        "aria-label": "Team chat viewer",
        "data-focus-key": "team-viewer",
      },
      ...state.users.map((user) =>
        h(
          doc,
          "option",
          {
            value: user.user_id,
            selected: user.user_id === state.viewer,
          },
          user.display_name,
        ),
      ),
    );
    select.value = state.viewer ?? state.users[0]?.user_id ?? "";
    select.addEventListener("change", (event) => {
      const next = (event.target as { value?: string } | undefined)?.value;
      if (next) state.onSwitchViewer?.(next);
    });
    viewerControl = h(
      doc,
      "label",
      { class: "team-viewer-label" },
      "Viewer ",
      select,
    );
  }

  const header = h(
    doc,
    "header",
    { class: "team-header" },
    h(
      doc,
      "div",
      { class: "team-header-title" },
      h(
        doc,
        "h1",
        { "data-focus-key": "heading", tabindex: "-1" },
        "Team Chat",
      ),
      state.label
        ? h(doc, "span", { class: "entry-badge" }, state.label)
        : null,
    ),
    h(doc, "div", { class: "team-header-actions" }, viewerControl, closeBtn),
  );

  if (state.error) {
    return h(
      doc,
      "section",
      { class: "team-pane", "data-panel": "team-chat" },
      header,
      h(doc, "p", { class: "error", role: "alert" }, state.error),
    );
  }

  const convItems = state.conversations.map((conv) => {
    const title = conversationTitle(conv, state.users, state.viewer);
    const selected = conv.conversation_id === state.activeConversationId;
    const selectBtn = h(
      doc,
      "button",
      {
        type: "button",
        class: `team-conv-btn${selected ? " selected" : ""}`,
        "data-conversation-id": conv.conversation_id,
        "aria-pressed": selected ? "true" : "false",
      },
      h(doc, "span", { class: "team-conv-name" }, title),
      conv.pinned ? h(doc, "span", { class: "entry-badge" }, "pinned") : null,
      conv.unread_count > 0
        ? h(
            doc,
            "span",
            { class: "team-unread-badge" },
            String(conv.unread_count),
          )
        : null,
    );
    selectBtn.addEventListener("click", () =>
      state.onSelectConversation?.(conv.conversation_id),
    );
    const pinBtn = h(
      doc,
      "button",
      {
        type: "button",
        class: "team-pin-btn",
        "data-pin-conversation": conv.conversation_id,
      },
      conv.pinned ? "Unpin" : "Pin",
    );
    pinBtn.addEventListener("click", () =>
      state.onTogglePin?.(conv.conversation_id, !conv.pinned),
    );
    return h(doc, "li", { class: "team-conv-item" }, selectBtn, pinBtn);
  });

  let searchSection: ShellElement | null = null;
  if (state.capabilities?.search) {
    const searchInput = h(doc, "input", {
      type: "text",
      class: "team-search-input",
      placeholder: "Search messages…",
      value: state.searchQuery,
      "aria-label": "Search team chat messages",
    });
    searchInput.value = state.searchQuery;
    const searchBtn = h(
      doc,
      "button",
      { type: "button", class: "team-search-btn" },
      "Search",
    );
    searchBtn.addEventListener("click", () =>
      state.onSearch?.(searchInput.value ?? ""),
    );
    searchSection = h(
      doc,
      "div",
      { class: "team-search" },
      searchInput,
      searchBtn,
    );
  }

  const activeMessages = state.activeView?.messages ?? [];
  const loadOlderBtn =
    !state.searchHits && state.activeView?.older_cursor
      ? (() => {
          const btn = h(
            doc,
            "button",
            {
              type: "button",
              class: "team-load-older-btn",
              disabled: Boolean(state.loading),
              "data-action": "team-load-older",
            },
            state.loading ? "Loading older…" : "Load older messages",
          );
          btn.disabled = Boolean(state.loading);
          btn.addEventListener("click", () => state.onLoadOlder?.());
          return btn;
        })()
      : null;
  const messageFeed = h(
    doc,
    "div",
    { class: "team-messages", role: "log", "aria-live": "polite" },
    ...(state.searchHits
      ? [
          h(
            doc,
            "p",
            { class: "muted" },
            `Search results (${state.searchHits.length})`,
          ),
          ...state.searchHits.map((msg) => renderMessage(doc, msg, state)),
        ]
      : activeMessages.length > 0
        ? [
            ...(loadOlderBtn ? [loadOlderBtn] : []),
            ...activeMessages.map((msg) => renderMessage(doc, msg, state)),
          ]
        : [
            h(
              doc,
              "p",
              { class: "muted" },
              state.loading
                ? "Loading conversation…"
                : "Select a conversation to view messages.",
            ),
          ]),
  );

  const composerInput = h(doc, "textarea", {
    class: "team-composer-input",
    rows: "2",
    placeholder: "Message team chat…",
    "aria-label": "Team chat message",
    "data-focus-key": "team-composer",
  });
  composerInput.value = state.draft;
  composerInput.addEventListener("input", (event) => {
    const next = (event.target as { value?: string } | undefined)?.value ?? "";
    state.onDraftChange?.(next);
  });

  const sendBtn = h(
    doc,
    "button",
    {
      type: "button",
      class: "team-send-btn primary-btn",
      disabled: !state.activeConversationId,
    },
    "Send message",
  );
  sendBtn.addEventListener("click", () => {
    const body = (composerInput.value ?? state.draft).trim();
    if (!body) return;
    state.onSend?.(body);
  });

  const composer = h(
    doc,
    "div",
    { class: "team-composer" },
    composerInput,
    sendBtn,
  );

  return h(
    doc,
    "section",
    { class: "team-pane", "data-panel": "team-chat" },
    header,
    searchSection,
    h(
      doc,
      "div",
      { class: "team-layout" },
      h(doc, "ul", { class: "team-conv-list" }, ...convItems),
      h(doc, "div", { class: "team-thread" }, messageFeed, composer),
    ),
  );
}
