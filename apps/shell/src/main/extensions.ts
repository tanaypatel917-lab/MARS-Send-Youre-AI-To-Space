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
  type Removal,
} from "../runtime/extension-wire";

type Project = {
  extensionAction(action: OperatorAction): Promise<CatalogStatus>;
};

export function extensionController(
  project: () => Project | undefined,
  confirm: (entry: CatalogEntry, customized: string[]) => Promise<boolean>,
  confirmRemoval: (
    entry: CatalogEntry,
    plan: Removal,
  ) => Promise<boolean> = async () => false,
): DesktopExtensions {
  let reviewing = false;
  return {
    async list() {
      const active = project();
      if (!active)
        throw new Error("Open a local project to manage extensions.");
      const { installed, expired, conflicts, removable } =
        await active.extensionAction({
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
          removable: removable?.includes(id) ?? false,
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
    async remove(id) {
      const entry = findExtension(id);
      const active = project();
      if (!entry || !active || reviewing) return "unavailable";
      reviewing = true;
      try {
        const { removal } = await active.extensionAction({
          action: "preview-remove",
          id,
        });
        if (project() !== active || removal?.id !== id) return "unavailable";
        if (!(await confirmRemoval(entry, removal))) return "cancelled";
        if (project() !== active) return "unavailable";
        await active.extensionAction({
          action: "remove",
          id,
          revision: removal.revision,
        });
        return "removed";
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
  popup: (items: MenuItemConstructorOptions[]) => void,
): MenuItemConstructorOptions[] {
  const api = extensionController(
    project,
    async (entry, customized) => {
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
    },
    async (entry, plan) => {
      const names = (ids: string[]) =>
        ids.map((id) => findExtension(id)?.name ?? id).join(", ");
      const details = [`Project: ${source()}`];
      if (entry.kind === "mcp") {
        details.push(
          "This project will lose access to the tool. Any current approval is revoked. The bundled server and approval history stay; other projects are unchanged.",
        );
      } else {
        if (plan.archive.length)
          details.push(`Archive for new tasks: ${names(plan.archive)}.`);
        for (const reason of [
          "shared",
          "customized",
          "pinned",
          "pre-existing",
        ] as const) {
          const keep = plan.keep.filter((k) => k.reason === reason);
          if (keep.length)
            details.push(
              `Keep active (${reason === "shared" ? "also added separately or used by another kit" : reason}): ${names(keep.map((k) => k.name))}.`,
            );
        }
        details.push(
          "Skill history stays in this project. You can add the extension again.",
        );
      }
      const { response } = await dialog.showMessageBox(window, {
        type: "question",
        title: "Remove project extension",
        message: `Remove ${entry.name} from this project?`,
        detail: details.join("\n\n"),
        buttons: ["Cancel", "Remove from project"],
        defaultId: 0,
        cancelId: 0,
      });
      return response === 1;
    },
  );
  ipcMain.handle(EXTENSION_CHANNEL, (event, payload: unknown) => {
    if (
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame?.url !== "mars-shell://app/index.html"
    )
      throw new Error("Extensions are unavailable.");
    const request = ExtensionAction.parse(payload);
    return request.action === "list"
      ? api.list()
      : api[request.action](request.id);
  });
  return [
    {
      label: "Add Verified Extension",
      submenu: (
        [
          ["mcp", "MCP servers — tools"],
          ["skill", "Skills — instructions"],
          ["plugin", "Plugins — bundles"],
        ] as const
      ).map(([kind, label]) => ({
        label,
        submenu: CATALOG.filter((entry) => entry.kind === kind).map(
          (entry) => ({
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
          }),
        ),
      })),
    },
    {
      label: "Remove Project Extension…",
      click: async () => {
        const active = project();
        try {
          const entries = (await api.list()).filter((e) => e.removable);
          if (window.isDestroyed() || active !== project()) return;
          if (!entries.length) {
            await dialog.showMessageBox(window, {
              type: "info",
              message: "No extensions to remove from this project.",
            });
            return;
          }
          popup(
            entries.map((entry) => ({
              label: entry.name,
              click: async () => {
                if (active !== project() || window.isDestroyed()) return;
                const result = await api.remove(entry.id);
                if (result === "cancelled" || window.isDestroyed()) return;
                await dialog.showMessageBox(
                  window,
                  result === "removed"
                    ? {
                        type: "info",
                        message: `${entry.name} removed from this project.`,
                      }
                    : {
                        type: "warning",
                        message:
                          "Could not confirm removal. Check the extension list before retrying.",
                      },
                );
              },
            })),
          );
        } catch {
          if (!window.isDestroyed())
            await dialog.showMessageBox(window, {
              type: "warning",
              message: "Open a local project to manage extensions.",
            });
        }
      },
    },
  ];
}
