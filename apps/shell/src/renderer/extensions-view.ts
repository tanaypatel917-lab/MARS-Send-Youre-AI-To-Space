import { h, type ShellDocument, type ShellElement } from "./dom";

export type ExtensionItem = {
  id: string;
  name: string;
  kind: "mcp" | "skill" | "plugin";
  description: string;
  permissions: string[];
  version: string;
  installed: boolean;
};
export type ExtensionsApi = {
  list(): Promise<ExtensionItem[]>;
  install(id: string): Promise<"installed" | "cancelled" | "unavailable">;
};
export type ExtensionState = {
  items: ExtensionItem[];
  busy: boolean;
  notice: string;
  available: boolean;
  onInstall?: (id: string) => void;
  onRefresh?: () => void;
};

/** Native install owns verification, permission consent, and persistence. */
export function renderExtensions(
  doc: ShellDocument,
  state?: ExtensionState,
): ShellElement {
  const categories = [
    {
      icon: "⌘",
      title: "MCP servers",
      subtitle: "Connect tools and data",
      body: "MCP is the connection between MARS and an external tool, like a repository service or database. Each server needs its own permissions and sometimes a separate API key.",
      state: "Host review required",
      detail:
        "MARS checks a server’s identity and permissions before allowing access. A familiar name alone is not verification.",
    },
    {
      icon: "✧",
      title: "Skills",
      subtitle: "Teach a repeatable workflow",
      body: "A skill is a set of instructions for a specific kind of work: reviewing code, writing tests, or following your team’s conventions. It doesn’t add a new external connection.",
      state: "Project conventions supported",
      detail:
        "MARS discovers SKILL.md files in your project’s skills, .claude/skills, .codex/skills, and .agents/skills folders when a task starts.",
    },
    {
      icon: "◇",
      title: "Plugins",
      subtitle: "Bundle capabilities together",
      body: "A plugin is a package that can include skills, tools, and configuration. It’s not the same thing as an MCP server, though a plugin can include one.",
      state: "Review before adding",
      detail:
        "Check the contents and permissions of a bundle before adding it to your project.",
    },
  ];
  const refresh = h(
    doc,
    "button",
    { type: "button", class: "connect-action", disabled: Boolean(state?.busy) },
    "Refresh library",
  );
  refresh.addEventListener("click", () => state?.onRefresh?.());
  return h(
    doc,
    "main",
    { class: "main extensions-main", "data-panel": "extensions" },
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
        h(doc, "strong", {}, "Extensions"),
      ),
    ),
    h(
      doc,
      "section",
      { class: "extensions-content" },
      h(doc, "p", { class: "eyebrow" }, "03 / MAKE MARS YOURS"),
      h(doc, "h1", {}, "More capable. Still in your control."),
      h(
        doc,
        "p",
        { class: "extensions-intro" },
        "Add tools and skills to new agent tasks in this project. Extensions don’t give Assistant chat access to your files or tools.",
      ),
      h(
        doc,
        "section",
        {
          class: "extension-library",
          "aria-label": "Verified extension library",
        },
        h(
          doc,
          "div",
          { class: "library-heading" },
          h(doc, "h2", {}, "Verified library"),
          state?.available ? refresh : null,
        ),
        h(
          doc,
          "p",
          { role: "status", class: "extensions-note" },
          state?.notice ??
            "The verified installer is not available in this build.",
        ),
        ...(state?.items ?? []).map((item) => {
          const add = h(
            doc,
            "button",
            {
              type: "button",
              class: "connect-action",
              disabled: item.installed || state?.busy === true,
              "aria-label": `${item.installed ? "Added" : "Add"} ${item.name}`,
            },
            item.installed ? "Added" : "Add to project",
          );
          add.addEventListener("click", () => state?.onInstall?.(item.id));
          return h(
            doc,
            "article",
            { class: "library-item" },
            h(
              doc,
              "div",
              {},
              h(
                doc,
                "span",
                { class: "extension-state" },
                `${item.kind === "mcp" ? "MCP server" : item.kind} · ${item.version}`,
              ),
              h(doc, "h3", {}, item.name),
              h(doc, "p", {}, item.description),
              h(
                doc,
                "small",
                {},
                `Permissions: ${item.permissions.join(", ") || "None"}`,
              ),
            ),
            add,
          );
        }),
      ),
      ...categories.map((item) =>
        h(
          doc,
          "article",
          { class: "extension-category" },
          h(
            doc,
            "span",
            { class: "extension-icon", "aria-hidden": "true" },
            item.icon,
          ),
          h(
            doc,
            "div",
            {},
            h(doc, "h2", {}, item.title),
            h(doc, "p", { class: "extension-subtitle" }, item.subtitle),
            h(doc, "p", {}, item.body),
            h(doc, "span", { class: "extension-state" }, item.state),
            h(doc, "p", { class: "extension-detail" }, item.detail),
          ),
        ),
      ),
      h(
        doc,
        "p",
        { class: "extensions-note" },
        "Model keys belong in Model settings. A tool’s credentials are separate; never paste secrets into a chat or skill.",
      ),
    ),
  );
}
