import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  safeStorage,
} from "electron";
import { DESKTOP_MODEL_CHANNEL } from "../shared/desktop-model";
import { desktopExtensionsMenu } from "./extensions";
import { startLocalWorkbench } from "./local-workbench";
import { SHELL_WEB_PREFERENCES } from "./security";

const settingsPage = "mars-shell://app/settings.html";

async function replacePrivate(path: string, contents: string | Buffer) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, contents, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

function canStoreKey(): boolean {
  return (
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" ||
      safeStorage.getSelectedStorageBackend() !== "basic_text")
  );
}

export async function createDesktop(window: BrowserWindow, reload: () => void) {
  const root = join(app.getPath("userData"), "local-workbench");
  const demo = join(root, "demo-project");
  const projectFile = join(root, "project.txt");
  const keyFile = join(root, "openrouter-key.bin");
  await mkdir(demo, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await writeFile(
    join(demo, "README.md"),
    "# MARS demo project\n\nThis is a sample project you can give to the MARS agent. Try: summarize the README and suggest a next step.\n",
    { flag: "wx", mode: 0o600 },
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const storedProject = await readFile(projectFile, "utf8").catch(() => "");
  let source = isAbsolute(storedProject) ? storedProject : demo;
  let openRouterKey: string | undefined;
  if (canStoreKey()) {
    try {
      openRouterKey = safeStorage.decryptString(await readFile(keyFile));
    } catch {
      // Unavailable credentials are never passed to the workbench.
    }
  }
  let modelWindow: BrowserWindow | undefined;
  let workbench: ReturnType<typeof startLocalWorkbench> | undefined;
  let changing = false;
  let closing = false;

  const change = async (save: () => Promise<void>) => {
    if (changing || closing) return false;
    changing = true;
    try {
      await save();
      await workbench?.stop();
      if (!closing && !window.isDestroyed()) reload();
      return true;
    } catch {
      return false;
    } finally {
      changing = false;
    }
  };

  const chooseProject = async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "Open a MARS project folder",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return;
    const path = result.filePaths[0];
    if (
      !(await change(async () => {
        const selected = await realpath(path);
        await replacePrivate(projectFile, selected);
        source = selected;
      }))
    )
      dialog.showErrorBox("Project unchanged", "Could not switch projects.");
  };

  const showModelSettings = () => {
    if (modelWindow && !modelWindow.isDestroyed()) {
      modelWindow.focus();
      return;
    }
    modelWindow = new BrowserWindow({
      parent: window,
      modal: true,
      width: 490,
      height: 365,
      resizable: false,
      title: "MARS Model Settings",
      backgroundColor: "#050407",
      webPreferences: {
        ...SHELL_WEB_PREFERENCES,
        preload: join(app.getAppPath(), "settings.cjs"),
      },
    });
    void modelWindow.loadURL(settingsPage);
  };

  ipcMain.handle(DESKTOP_MODEL_CHANNEL, async (event, key: unknown) => {
    if (
      !modelWindow ||
      modelWindow.isDestroyed() ||
      event.sender !== modelWindow.webContents ||
      event.senderFrame?.url !== settingsPage
    )
      return "refused";
    if (
      key !== null &&
      (typeof key !== "string" ||
        key.length > 512 ||
        !/^sk-or-v1-[A-Za-z0-9_-]+$/.test(key))
    )
      return "invalid";
    const persist = key !== null && canStoreKey();
    const saved = await change(async () => {
      if (key === null) await rm(keyFile, { force: true });
      else if (persist)
        await replacePrivate(keyFile, safeStorage.encryptString(key));
      openRouterKey = key ?? undefined;
    });
    return !saved
      ? "unavailable"
      : key === null
        ? "cleared"
        : persist
          ? "saved"
          : "session";
  });

  const activeWorkbench = () => {
    if (changing || closing) return undefined;
    if (!workbench) {
      const running = startLocalWorkbench({
        resources: join(process.resourcesPath, "workbench"),
        onExpired(name) {
          if (
            workbench !== running ||
            changing ||
            closing ||
            window.isDestroyed()
          )
            return;
          void dialog.showMessageBox(window, {
            type: "info",
            message: `${name} needs renewed approval`,
            detail: `This tool is unavailable to tasks in ${source}. Use Project → Add Verified Extension to approve it again.`,
          });
        },
        source,
        state: join(root, "projects"),
        ...(openRouterKey ? { openRouterKey } : {}),
      });
      workbench = running;
      void running.exited.then(() => {
        if (workbench === running) workbench = undefined;
      });
    }
    return workbench;
  };
  const projectMenu: MenuItemConstructorOptions = {
    label: "Project",
    submenu: [
      {
        label: "Open Project Folder…",
        accelerator: "CmdOrCtrl+O",
        click: () =>
          void chooseProject().catch(() =>
            dialog.showErrorBox(
              "Project unchanged",
              "Could not open the folder picker.",
            ),
          ),
      },
      {
        label: "Open Demo Project",
        click: () => {
          void change(async () => {
            await rm(projectFile, { force: true });
            source = demo;
          });
        },
      },
      { type: "separator" },
      { label: "Model Settings…", click: showModelSettings },
      ...desktopExtensionsMenu(
        { dialog, ipcMain },
        window,
        activeWorkbench,
        () => source,
        (items) => Menu.buildFromTemplate(items).popup({ window }),
      ),
      { type: "separator" },
      { role: "close" },
    ],
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" } as const] : []),
      projectMenu,
      { role: "editMenu" },
    ]),
  );

  return {
    resolve() {
      return (
        activeWorkbench()?.connection() ??
        Promise.resolve({
          ok: false as const,
          reason: "The local workbench is switching projects. Try again.",
        })
      );
    },
    async close() {
      closing = true;
      await workbench?.stop();
    },
  };
}
