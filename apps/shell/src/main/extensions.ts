import type {
  BrowserWindow,
  Dialog,
  IpcMain,
  MenuItemConstructorOptions,
} from "electron";
import {
  CATALOG,
  type CatalogEntry,
  type DesktopExtensions,
  EXTENSION_CHANNEL,
  findExtension,
} from "../runtime/extension-catalog";
import {
  type CatalogStatus,
  ExtensionAction,
  type OperatorAction,
} from "../runtime/extension-wire";

type Project = {
  extensionAction(action: OperatorAction): Promise<CatalogStatus>;
};

export function extensionController(
  project: () => Project | undefined,
  confirm: (entry: CatalogEntry, customized: string[]) => Promise<boolean>,
): DesktopExtensions {
  let reviewing = false;
  return {
    async list() {
      const active = project();
      if (!active)
        throw new Error("Open a local project to manage extensions.");
      const { installed, expired, conflicts } = await active.extensionAction({
        action: "list",
      });
      return CATALOG.map(
        ({ id, name, kind, version, description, permissions }) => ({
          id,
          name,
          kind,
          version,
          description: expired.includes(id)
            ? `Approval expired. Add again to renew. ${description}`
            : conflicts.includes(id)
              ? `Add again to review restoring customized instructions. ${description}`
              : description,
          permissions,
          installed: installed.includes(id),
        }),
      );
    },
    async install(id) {
      const entry = findExtension(id);
      if (!entry || reviewing) return "unavailable";
      const active = project();
      if (!active) return "unavailable";
      reviewing = true;
      try {
        const status =
          entry.kind !== "mcp"
            ? await active.extensionAction({ action: "list" })
            : undefined;
        if (project() !== active) return "unavailable";
        const customized = entry.assets
          .map((asset) => asset.file.replace(/\.md$/, ""))
          .filter((name) => status?.conflicts.includes(name));
        const restoring = customized.length > 0;
        if (status?.conflicts.includes(id) && (!restoring || !status.revision))
          return "unavailable";
        if (!(await confirm(entry, customized))) return "cancelled";
        if (project() !== active) return "unavailable";
        await active.extensionAction(
          restoring && status?.revision
            ? { action: "restore", id, revision: status.revision }
            : { action: "install", id },
        );
        return "installed";
      } catch {
        return "unavailable";
      } finally {
        reviewing = false;
      }
    },
  };
}

export function desktopExtensionsMenu(
  { dialog, ipcMain }: { dialog: Dialog; ipcMain: IpcMain },
  window: BrowserWindow,
  project: () => Project | undefined,
  source: () => string,
): MenuItemConstructorOptions {
  const api = extensionController(project, async (entry, customized) => {
    const restoring = customized.length > 0;
    const { response } = await dialog.showMessageBox(window, {
      type: "question",
      title: "Add verified extension",
      message: restoring
        ? `Restore bundled instructions for ${entry.name}?`
        : `Add ${entry.name} to this project?`,
      detail: [
        entry.description,
        `Bundled with MARS · v${entry.version}`,
        `Project: ${source()}`,
        ...entry.permissions,
        entry.kind === "mcp"
          ? "Approval lasts 30 days. Add again after expiry to renew."
          : restoring
            ? `Only these customized instructions will be replaced with their bundled versions: ${customized.join(", ")}. Previous content stays in skill version history.`
            : "Adding restores archived skills to the bundled version and keeps prior content in version history. Customized active skills require separate confirmation.",
      ].join("\n\n"),
      buttons: [
        "Cancel",
        restoring ? "Restore bundled instructions" : "Add to project",
      ],
      defaultId: 0,
      cancelId: 0,
    });
    return response === 1;
  });
  ipcMain.handle(EXTENSION_CHANNEL, (event, payload: unknown) => {
    if (
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame?.url !== "mars-shell://app/index.html"
    )
      throw new Error("Extensions are unavailable.");
    const request = ExtensionAction.parse(payload);
    return request.action === "list" ? api.list() : api.install(request.id);
  });
  return {
    label: "Add Verified Extension",
    submenu: (
      [
        ["mcp", "MCP servers — tools"],
        ["skill", "Skills — instructions"],
        ["plugin", "Plugins — bundles"],
      ] as const
    ).map(([kind, label]) => ({
      label,
      submenu: CATALOG.filter((entry) => entry.kind === kind).map((entry) => ({
        label: `${entry.name}…`,
        click: async () => {
          const result = await api.install(entry.id);
          if (window.isDestroyed() || result === "cancelled") return;
          await dialog.showMessageBox(
            window,
            result === "installed"
              ? {
                  type: "info",
                  message: `${entry.name} is ready for new tasks in this project.`,
                }
              : {
                  type: "warning",
                  message: "Could not confirm installation",
                  detail:
                    "Your task service was not stopped by the catalog. Check the extension list before retrying; if it stays unavailable, reopen the project after running tasks finish.",
                },
          );
        },
      })),
    })),
  };
}
