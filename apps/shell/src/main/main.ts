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
import { explicitConnection, resolveConnection } from "./connection";
import { createDesktop } from "./desktop";
import { registerBridge, registerTeamChatBridge } from "./ipc";
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
    backgroundColor: "#050407",
    webPreferences: {
      ...SHELL_WEB_PREFERENCES,
      preload: join(app.getAppPath(), managed ? "managed.cjs" : "preload.cjs"),
    },
  });
  mainWindow = window;
  const newBridge = () =>
    createReconnectingBridge({
      resolve: () => (desktop ? desktop.resolve() : resolveConnection()),
      makeTransport: (connection) => createLoopbackTransport(connection),
    });
  let bridge = newBridge();
  registerBridge(
    ipcMain,
    { call: (method, params) => bridge.call(method, params) },
    { trustedOrigin },
  );
  registerTeamChatBridge(ipcMain, createTeamChatBridge(), { trustedOrigin });
  if (managed) {
    try {
      desktop = await createDesktop(window, () => {
        bridge = newBridge();
        window.webContents.reload();
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
  await window.loadURL(`${trustedOrigin}/index.html`);
});

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
