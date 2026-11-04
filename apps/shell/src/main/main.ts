import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, protocol, session } from "electron";
import { resolveConnection } from "./connection";
import { registerBridge } from "./ipc";
import {
  appResponseHeaders,
  resolveAppAsset,
  SHELL_WEB_PREFERENCES,
} from "./security";
import { createReconnectingBridge } from "./session";
import { layoutPath, loadWindowLayout, saveWindowLayout } from "./settings";
import { createLoopbackTransport } from "./transport";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "mars-shell",
    privileges: { standard: true, secure: true },
  },
]);
app.enableSandbox();

const trustedOrigin = "mars-shell://app";

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${trustedOrigin}/`)) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

app.on("ready", async () => {
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

  const bridge = createReconnectingBridge({
    resolve: () => resolveConnection(),
    makeTransport: (connection) => createLoopbackTransport(connection),
  });
  registerBridge(ipcMain, bridge, { trustedOrigin });

  const filePath = layoutPath(app.getPath("home"));
  const saved = await loadWindowLayout(filePath);
  const window = new BrowserWindow({
    title: "MARS Shell",
    width: saved.width,
    height: saved.height,
    backgroundColor: "#18181e",
    webPreferences: {
      ...SHELL_WEB_PREFERENCES,
      preload: join(app.getAppPath(), "preload.cjs"),
    },
  });
  window.on("close", () => {
    const { width, height } = window.getBounds();
    void saveWindowLayout(filePath, { width, height }).catch(() => {});
  });
  await window.loadURL(`${trustedOrigin}/index.html`);
});

app.on("window-all-closed", () => app.quit());
