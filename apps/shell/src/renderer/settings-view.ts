import type { AssistantViewState } from "./assistant-view";
import { h, type ShellDocument, type ShellElement } from "./dom";

/** The workspace never receives the API key; entry belongs to the settings window. */
export function renderSettings(
  doc: ShellDocument,
  model: AssistantViewState,
  error: string | undefined,
  extensions: () => void,
  retry: () => void,
): ShellElement {
  const button = (label: string, key: string, click: () => void) => {
    const el = h(
      doc,
      "button",
      { type: "button", class: "settings-action", "data-focus-key": key },
      label,
    );
    el.addEventListener("click", click);
    return el;
  };
  const status =
    model.canConfigure === undefined
      ? model.loading
        ? "Checking…"
        : "Status unavailable"
      : model.configured
        ? "Key configured"
        : "No key added";
  return h(
    doc,
    "main",
    { class: "main settings-main", "data-panel": "settings" },
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
        h(doc, "strong", {}, "Settings"),
      ),
    ),
    h(
      doc,
      "div",
      { class: "settings-content" },
      h(doc, "p", { class: "eyebrow" }, "04 / YOUR WORKSPACE, YOUR RULES"),
      h(doc, "h1", {}, "Settings"),
      h(
        doc,
        "p",
        { class: "settings-lede" },
        "Manage your model, privacy, and project extensions.",
      ),
      h(
        doc,
        "section",
        { class: "settings-block", "aria-label": "Model connection" },
        h(doc, "h2", {}, "Model connection"),
        h(
          doc,
          "div",
          { class: "settings-provider" },
          h(doc, "strong", {}, "OpenRouter"),
          h(doc, "span", { class: "extension-state" }, status),
        ),
        h(
          doc,
          "p",
          {},
          model.canConfigure === true
            ? "One API key powers chat and agent tasks. Chat uses OpenRouter’s free model route."
            : model.canConfigure === false
              ? "This app is attached to a workbench. Set OPENROUTER_API_KEY in the environment that launches MARS, then restart the app."
              : "Connect to your workbench to check model settings. In the installed app, you can also use Project → Model Settings.",
        ),
        model.canConfigure
          ? button(
              model.configured ? "Manage API key" : "Add API key",
              "settings-key",
              () => model.onSettings?.(),
            )
          : model.canConfigure === undefined && !model.loading
            ? button("Check again", "settings-retry", retry)
            : null,
        error
          ? h(doc, "p", { class: "chat-error", role: "alert" }, error)
          : null,
      ),
      h(
        doc,
        "section",
        { class: "settings-block" },
        h(doc, "h2", {}, "Privacy"),
        h(
          doc,
          "p",
          {},
          "Sending a chat shares that conversation with OpenRouter, not your project files. Completed conversations are saved on this device, separately for each project.",
        ),
      ),
      h(
        doc,
        "section",
        { class: "settings-block" },
        h(doc, "h2", {}, "Project extensions"),
        h(
          doc,
          "p",
          {},
          "Verified MCP servers, skills, and plugins add capabilities to new agent tasks. They don’t change Assistant chat.",
        ),
        button("Browse extensions", "settings-extensions", extensions),
      ),
    ),
  );
}
