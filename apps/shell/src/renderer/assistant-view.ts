import type { AssistantSession } from "../shared/assistant";
import { h, type ShellDocument, type ShellElement } from "./dom";

export type AssistantViewState = {
  sessions: AssistantSession[];
  unsentIds?: string[];
  activeId: string;
  draft: string;
  configured: boolean;
  canConfigure?: boolean;
  consent: boolean;
  busy: boolean;
  loading: boolean;
  error?: string | undefined;
  validation?: "key" | "consent" | undefined;
  pending?: { id: string; text: string } | undefined;
  onDraft?: (draft: string) => void;
  onConsent?: (consent: boolean) => void;
  onSend?: () => void;
  onSettings?: () => void;
  onRetryLoad?: () => void;
  onNew?: () => void;
  onSelect?: (id: string) => void;
  onTask?: (text: string) => void;
};

function action(
  doc: ShellDocument,
  text: string,
  className: string,
  fn?: () => void,
): ShellElement {
  const button = h(doc, "button", { type: "button", class: className }, text);
  button.addEventListener("click", () => fn?.());
  return button;
}

export function renderAssistant(
  doc: ShellDocument,
  state: AssistantViewState,
): ShellElement {
  const validation =
    state.validation === "key" && !state.configured
      ? state.canConfigure === false
        ? "Set OPENROUTER_API_KEY and restart the attached app to start chatting."
        : "Connect a model to start chatting."
      : state.validation === "consent" && state.configured && !state.consent
        ? "Allow this conversation to be sent to OpenRouter, then send your message."
        : undefined;
  const error = state.error ?? validation;
  const connect = action(
    doc,
    "Connect model",
    "connect-action",
    state.onSettings,
  );
  connect.setAttribute("data-focus-key", "connect-model");
  const session = state.sessions.find((item) => item.id === state.activeId);
  const messages = [
    ...(session?.messages ?? []),
    ...(state.pending?.id === state.activeId
      ? [{ role: "user" as const, content: state.pending.text }]
      : []),
  ];
  const empty = messages.length === 0;
  const input = h(doc, "textarea", {
    id: "assistant-composer-input",
    rows: "2",
    maxlength: "8000",
    class: "assistant-input",
    "aria-label": "Message MARS",
    placeholder: "Ask MARS a question…",
    "data-focus-key": "assistant-input",
    disabled: state.busy || state.loading,
  });
  input.value = state.draft;
  input.addEventListener("input", () => state.onDraft?.(input.value ?? ""));
  input.addEventListener("keydown", (event) => {
    const key = event as typeof event & {
      key?: string;
      shiftKey?: boolean;
      isComposing?: boolean;
    };
    if (key.key === "Enter" && !key.shiftKey && !key.isComposing) {
      event.preventDefault?.();
      state.onSend?.();
    }
  });
  const send = action(
    doc,
    state.busy ? "Thinking…" : "Send ↗",
    "assistant-send",
    state.onSend,
  );
  send.disabled =
    state.busy || state.loading || !state.configured || !state.consent;
  const consent = h(doc, "input", {
    type: "checkbox",
    "aria-label": "Share this chat with OpenRouter",
    "data-focus-key": "chat-consent",
  });
  consent.checked = state.consent;
  consent.addEventListener("change", () =>
    state.onConsent?.(Boolean(consent.checked)),
  );
  const suggestions = [
    [
      "Explore an idea",
      "Help me think through an idea for a new feature. Ask me a few questions to get started.",
    ],
    [
      "Plan a build",
      "Help me break down a coding project into a clear implementation plan.",
    ],
    [
      "Talk through code",
      "I want to understand some code. What should I share so we can walk through it together?",
    ],
  ];
  const quickStarts = empty
    ? h(
        doc,
        "div",
        { class: "suggestion-grid" },
        ...suggestions.map(([title, prompt], index) => {
          const suggestion = action(doc, "", "suggestion", () => {
            const draft = input.value ?? "";
            const next = draft ? `${draft}\n\n${prompt}` : (prompt ?? "");
            if (next.length > 8000) return;
            input.value = next;
            state.onDraft?.(next);
            doc.getElementById("assistant-composer-input")?.focus();
          });
          // The live composer does not re-render on each keystroke.
          const updateSuggestion = () => {
            suggestion.disabled =
              state.busy ||
              state.loading ||
              (input.value ?? "").length +
                (input.value ? 2 : 0) +
                (prompt?.length ?? 0) >
                8000;
          };
          updateSuggestion();
          input.addEventListener("input", updateSuggestion);
          suggestion.append(
            h(
              doc,
              "span",
              { class: "suggestion-number", "aria-hidden": "true" },
              `0${index + 1}`,
            ),
            h(doc, "span", {}, title ?? ""),
            h(
              doc,
              "span",
              { class: "suggestion-arrow", "aria-hidden": "true" },
              "↗",
            ),
          );
          return suggestion;
        }),
      )
    : null;
  const form = h(
    doc,
    "form",
    { class: "assistant-composer" },
    input,
    h(
      doc,
      "div",
      { class: "assistant-composer-tools" },
      h(doc, "span", { class: "composer-mode" }, "Chat"),
      h(
        doc,
        "span",
        { class: "composer-model" },
        state.configured ? "OpenRouter · Free" : "No model connected",
        state.configured ? h(doc, "span", { class: "model-dot" }, "●") : null,
      ),
      send,
    ),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault?.();
    state.onSend?.();
  });
  return h(
    doc,
    "main",
    {
      class: `main assistant-main${empty ? " is-empty" : ""}`,
      "data-panel": "assistant",
    },
    h(
      doc,
      "header",
      { class: "workspace-toolbar" },
      h(
        doc,
        "div",
        { class: "breadcrumb" },
        "Workspace",
        h(doc, "span", {}, "/"),
        h(doc, "strong", {}, session?.title ?? "New conversation"),
      ),
      h(doc, "span", { class: "mode-badge" }, "Chat"),
    ),
    h(
      doc,
      "section",
      {
        class: "assistant-scroll",
        role: "log",
        "aria-label": "Assistant conversation",
        "aria-live": "polite",
      },
      ...(empty
        ? [
            h(
              doc,
              "div",
              { class: "assistant-welcome" },
              h(
                doc,
                "div",
                { class: "orbit-mark", "aria-hidden": "true" },
                "✳",
              ),
              h(doc, "p", { class: "eyebrow" }, "MARS  /  ASSISTANT"),
              h(doc, "h1", {}, "Where should we start?"),
              h(
                doc,
                "p",
                { class: "welcome-subtitle" },
                "Explore an idea, plan a build, or talk through code.",
              ),
            ),
          ]
        : messages.map((message) =>
            h(
              doc,
              "article",
              { class: `assistant-message message-${message.role}` },
              h(
                doc,
                "div",
                { class: "message-avatar", "aria-hidden": "true" },
                message.role === "user" ? "Y" : "✳",
              ),
              h(
                doc,
                "div",
                { class: "message-body" },
                h(
                  doc,
                  "p",
                  { class: "message-author" },
                  message.role === "user" ? "You" : "MARS",
                ),
                h(doc, "pre", { class: "message-content" }, message.content),
                message.role === "assistant"
                  ? action(doc, "Make a task  ↗", "message-handoff", () =>
                      state.onTask?.(message.content),
                    )
                  : null,
              ),
            ),
          )),
      state.busy
        ? h(
            doc,
            "p",
            { class: "thinking", role: "status" },
            "✧  MARS is thinking…",
          )
        : null,
    ),
    h(
      doc,
      "div",
      { class: "assistant-compose-wrap" },
      !state.configured && !state.loading && state.canConfigure !== undefined
        ? h(
            doc,
            "div",
            { class: "connect-notice" },
            h(
              doc,
              "div",
              {},
              h(doc, "strong", {}, "Add your API key"),
              h(
                doc,
                "p",
                {},
                state.canConfigure
                  ? "Connect OpenRouter to send your first message."
                  : "Set OPENROUTER_API_KEY in the environment that launches MARS, then restart the attached app.",
              ),
            ),
            state.canConfigure ? connect : null,
          )
        : null,
      error
        ? h(
            doc,
            "div",
            { class: "chat-error", role: "alert" },
            error,
            state.onRetryLoad
              ? action(doc, "Retry chat", "retry", state.onRetryLoad)
              : null,
          )
        : null,
      form,
      state.configured
        ? h(
            doc,
            "label",
            { class: "chat-cost" },
            consent,
            "Send this conversation to OpenRouter’s free model route",
          )
        : null,
      h(
        doc,
        "p",
        { class: "composer-footnote" },
        state.loading
          ? "Loading your conversations…"
          : "Enter to send  ·  Shift + Enter for a new line",
      ),
      quickStarts,
    ),
  );
}
