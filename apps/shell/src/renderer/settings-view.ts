import {
  HEALTH_LABEL,
  ISSUE_LABEL,
  MILESTONE_LABEL,
  PROVIDER_ISSUES,
  SETUP_MILESTONES,
} from "../shared/setup";
import type { AssistantViewState } from "./assistant-view";
import { h, type ShellDocument, type ShellElement } from "./dom";

/** The workspace never receives the API key; entry belongs to the settings window. */
export function renderSettings(
  doc: ShellDocument,
  model: AssistantViewState,
  error: string | undefined,
  extensions: () => void,
  retry: () => void,
  verification?: {
    checks: number;
    readiness?:
      | {
          status: "ready" | "unavailable";
          reason: string;
          setup?: string | undefined;
        }
      | undefined;
  },
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
        ? "Key present"
        : "No key added";
  const health = model.health?.state ?? "unchecked";
  const readiness = verification?.readiness;
  const row = (label: string, value: string, ok: boolean, key: string) =>
    h(
      doc,
      "li",
      { "data-check": ok ? "ok" : "warn", "data-diagnostic": key },
      h(doc, "span", {}, label),
      h(doc, "span", {}, value),
    );
  const date = (iso: string) => iso.slice(0, 10);
  const issues = PROVIDER_ISSUES.filter((key) => model.setup?.issues[key]);
  const diagnostics = h(
    doc,
    "section",
    { class: "settings-block", "aria-label": "Setup diagnostics" },
    h(
      doc,
      "p",
      { class: "settings-index", "aria-hidden": "true" },
      "04 / DIAGNOSTICS",
    ),
    h(doc, "h2", {}, "Setup diagnostics"),
    h(
      doc,
      "ul",
      { class: "setup-diagnostics" },
      row(
        "Model key",
        model.configured ? "Present" : "Missing: add an OpenRouter key",
        model.configured,
        "key",
      ),
      row(
        "Chat model (OpenRouter free route)",
        health === "unchecked"
          ? "Checked on your next chat message"
          : `${HEALTH_LABEL[health]}${model.health?.at ? ` · ${date(model.health.at)}` : ""}`,
        health === "ok" || health === "unchecked",
        "chat-model",
      ),
      row(
        "Verification checks",
        !verification
          ? "Connect to your workbench to check"
          : readiness
            ? readiness.status === "ready"
              ? "Ready"
              : `${readiness.reason}. ${readiness.setup ?? "Use Project → Set Up Verification Sandbox…"}`
            : verification.checks
              ? `${verification.checks} host check${verification.checks === 1 ? "" : "s"} configured`
              : "No host checks configured. Try Project → Open Verification Example",
        readiness
          ? readiness.status === "ready"
          : Boolean(verification?.checks),
        "verification",
      ),
    ),
    h(doc, "h2", {}, "Pilot progress"),
    h(
      doc,
      "ul",
      { class: "setup-diagnostics" },
      ...SETUP_MILESTONES.map((key) => {
        const at = model.setup?.milestones[key];
        return row(MILESTONE_LABEL[key], at ? date(at) : "Not yet", true, key);
      }),
      ...issues.map((key) =>
        row(
          ISSUE_LABEL[key],
          `${model.setup?.issues[key]}×`,
          false,
          `issue-${key}`,
        ),
      ),
    ),
    h(
      doc,
      "p",
      {},
      "Kept only on this device to help you and your pilot contact see where setup stalled. Nothing here is sent anywhere.",
    ),
  );
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
      h(doc, "p", { class: "eyebrow" }, "04 / MAKE YOURSELF AT HOME"),
      h(doc, "h1", {}, "Settings."),
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
        h(
          doc,
          "p",
          { class: "settings-index", "aria-hidden": "true" },
          "01 / MODEL",
        ),
        h(doc, "h2", {}, "A mind for your mission."),
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
            ? model.configured
              ? "MARS has a key. Saving it checks the format, not whether OpenRouter accepts it. No request is sent just to test it."
              : "One API key powers chat and agent tasks. Chat uses OpenRouter’s free model route."
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
        h(
          doc,
          "p",
          { class: "settings-index", "aria-hidden": "true" },
          "02 / YOUR DATA",
        ),
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
        h(
          doc,
          "p",
          { class: "settings-index", "aria-hidden": "true" },
          "03 / CAPABILITIES",
        ),
        h(doc, "h2", {}, "Project extensions"),
        h(
          doc,
          "p",
          {},
          "Verified MCP servers, skills, and plugins add capabilities to new agent tasks. They don’t change Assistant chat.",
        ),
        button("Browse extensions", "settings-extensions", extensions),
      ),
      diagnostics,
    ),
  );
}
