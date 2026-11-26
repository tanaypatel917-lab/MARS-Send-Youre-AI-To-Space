import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session,
} from "electron";
import { MODEL_CHANGED } from "../shared/desktop-model";
import { createAssistant } from "./assistant";
import { explicitConnection, resolveConnection } from "./connection";
import { createDesktop } from "./desktop";
import {
  registerAssistantBridge,
  registerBridge,
  registerPatchHandoff,
  registerTeamChatBridge,
} from "./ipc";
import { createPatchHandoff } from "./patch-handoff";
import {
  appResponseHeaders,
  resolveAppAsset,
  SHELL_WEB_PREFERENCES,
} from "./security";
import { createReconnectingBridge } from "./session";
import { layoutPath, loadWindowLayout, saveWindowLayout } from "./settings";
import { createTeamChatBridge } from "./team-chat-bridge";
import { createLoopbackTransport } from "./transport";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "mars-shell",
    privileges: { standard: true, secure: true },
  },
]);
app.enableSandbox();

const trustedOrigin = "mars-shell://app";
const indexPage = `${trustedOrigin}/index.html`;
const recoveryPage = `${trustedOrigin}/recovery.html`;
const managed = app.isPackaged && !explicitConnection();
const primary = !managed || app.requestSingleInstanceLock();
if (!primary) app.quit();
let mainWindow: BrowserWindow | undefined;
let desktop: Awaited<ReturnType<typeof createDesktop>> | undefined;
let shuttingDown = false;

app.on("second-instance", () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.focus();
});

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

app.on("ready", async () => {
  if (!primary) return;
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  defaultSession.setPermissionCheckHandler(() => false);
  defaultSession.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      callback({ cancel: !details.url.startsWith(`${trustedOrigin}/`) });
    },
  );
  Menu.setApplicationMenu(null);
  protocol.handle("mars-shell", async (request) => {
    if (request.url === recoveryPage) {
      return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>MARS recovery</title>
        <link rel="stylesheet" href="./shell.css"><main><h1>MARS could not restore this window</h1>
        <p>Quit and reopen MARS to try again.</p></main></html>`,
        {
          headers: {
            ...appResponseHeaders(),
            "Content-Type": "text/html; charset=utf-8",
          },
        },
      );
    }
    const rendererDir = join(app.getAppPath(), "renderer");
    const asset = resolveAppAsset(request.url, rendererDir);
    if (!asset)
      return new Response("Not found", {
        status: 404,
        headers: appResponseHeaders(),
      });
    try {
      return new Response(await readFile(asset.file), {
        status: 200,
        headers: {
          ...appResponseHeaders(),
          "Content-Type": asset.mediaType,
        },
      });
    } catch {
      return new Response("Not found", {
        status: 404,
        headers: appResponseHeaders(),
      });
    }
  });

  const filePath = layoutPath(app.getPath("home"));
  const saved = await loadWindowLayout(filePath);
  const window = new BrowserWindow({
    title: managed ? "MARS" : "MARS Shell",
    width: saved.width,
    height: saved.height,
    backgroundColor: "#101216",
    webPreferences: {
      ...SHELL_WEB_PREFERENCES,
      preload: join(app.getAppPath(), managed ? "managed.cjs" : "preload.cjs"),
    },
  });
  mainWindow = window;
  const openRenderer = installRendererRecovery(window);
  const senderPolicy = { trustedOrigin, trustedContents: window.webContents };
  const newBridge = () =>
    createReconnectingBridge({
      resolve: () => (desktop ? desktop.resolve() : resolveConnection()),
      makeTransport: (connection) => createLoopbackTransport(connection),
    });
  let bridge = newBridge();
  registerBridge(
    ipcMain,
    { call: (method, params) => bridge.call(method, params) },
    senderPolicy,
  );
  registerPatchHandoff(
    ipcMain,
    createPatchHandoff(
      () => bridge,
      async () => {
        const result = await dialog.showOpenDialog(window, {
          title: "Save verified patch and check receipt",
          buttonLabel: "Save handoff here",
          properties: ["openDirectory"],
        });
        return result.canceled ? undefined : result.filePaths[0];
      },
    ),
    senderPolicy,
  );
  registerTeamChatBridge(ipcMain, createTeamChatBridge(), senderPolicy);
  registerAssistantBridge(
    ipcMain,
    createAssistant({
      directory: join(app.getPath("userData"), "assistant-history"),
      context: async () => {
        if (desktop) return desktop.chatContext();
        const connection = await resolveConnection();
        if (!connection.ok) throw new Error("Workbench unavailable");
        return {
          workspace: JSON.stringify(connection.connection.scope),
          key: process.env.OPENROUTER_API_KEY,
        };
      },
    }),
    senderPolicy,
  );
  if (managed) {
    try {
      desktop = await createDesktop(window, (kind) => {
        bridge = newBridge();
        if (kind === "project") window.webContents.reload();
        else window.webContents.send(MODEL_CHANGED);
      });
    } catch {
      showDesktopStartupError();
      return;
    }
  }
  window.on("close", () => {
    const { width, height } = window.getBounds();
    void saveWindowLayout(filePath, { width, height }).catch(() => {});
  });
  openRenderer();
});

function installRendererRecovery(window: BrowserWindow) {
  const contents = window.webContents;
  let closing = false;
  let stopped = false;
  let reloads: number[] = [];
  let hangPrompt: AbortController | undefined;
  const isClosing = () => closing || shuttingDown || window.isDestroyed();
  const dismissPrompt = () => {
    hangPrompt?.abort();
    hangPrompt = undefined;
  };
  window.on("close", () => {
    closing = true;
    dismissPrompt();
  });
  window.on("responsive", dismissPrompt);
  window.on("unresponsive", async () => {
    if (isClosing() || stopped || hangPrompt) return;
    const prompt = new AbortController();
    hangPrompt = prompt;
    try {
      const { response } = await dialog.showMessageBox(window, {
        message: "The MARS window is not responding.",
        detail: "Reloading may discard unsent text.",
        buttons: ["Keep waiting", "Reload window"],
        defaultId: 0,
        cancelId: 0,
        signal: prompt.signal,
      });
      if (response === 1 && !prompt.signal.aborted && !isClosing())
        contents.forcefullyCrashRenderer();
    } catch {
      // If the native prompt is unavailable, leave the renderer alone.
    } finally {
      if (hangPrompt === prompt) hangPrompt = undefined;
    }
  });

  const load = (url: string) => {
    if (isClosing()) return;
    void window.loadURL(url).catch((error: NodeJS.ErrnoException) => {
      if (!isClosing() && error.code !== "ERR_ABORTED" && !contents.isCrashed())
        dialog.showErrorBox(
          "MARS could not load its window",
          "Quit and reopen MARS to try again.",
        );
    });
  };
  contents.on("render-process-gone", (_event, { reason }) => {
    dismissPrompt();
    if (isClosing() || reason === "clean-exit" || stopped) return;
    const now = performance.now();
    reloads = reloads.filter((time) => now - time < 60_000);
    if (reloads.length >= 2) {
      stopped = true;
      load(recoveryPage);
    } else {
      reloads.push(now);
      load(indexPage);
    }
  });
  return () => load(indexPage);
}

function showDesktopStartupError() {
  dialog.showErrorBox(
    "MARS could not open",
    "The app could not prepare its local data folder. Check its permissions and reopen MARS.",
  );
  app.quit();
}

app.on("before-quit", (event) => {
  if (!desktop) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  void desktop.close().finally(() => {
    desktop = undefined;
    app.quit();
  });
});

app.on("window-all-closed", () => app.quit());
