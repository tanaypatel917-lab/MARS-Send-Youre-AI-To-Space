import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow, MenuItemConstructorOptions } from "electron";
import { createDesktop } from "../src/main/desktop";
import { resolveDockerHost } from "../src/main/docker-host";
import { resolveDockerPath } from "../src/main/docker-path";
import {
  createManagedWorkbenchBridge,
  createReconnectingBridge,
} from "../src/main/session";
import {
  createLoopbackTransport,
  type RpcTransport,
} from "../src/main/transport";
import {
  seedVerificationExample,
  VERIFICATION_IMAGE,
} from "../src/main/verification-example";
import { startShell } from "../src/renderer/app";
import { BRIDGE_METHODS, type ShellBridge } from "../src/shared/methods";
import { findAll, MiniDocument } from "./mini-dom";

const originalHost = "unix:///tmp/mars-original.sock";
const newHost = "unix:///tmp/mars-new.sock";

async function withDesktop(
  run: (fixture: Awaited<ReturnType<typeof desktopFixture>>) => Promise<void>,
  wrapTransport?: (transport: RpcTransport) => RpcTransport,
) {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "mars-desktop-"),
  );
  try {
    const fixture = await desktopFixture(directory, wrapTransport);
    try {
      await run(fixture);
    } finally {
      await fixture.desktop.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function desktopFixture(
  directory: string,
  wrapTransport = (transport: RpcTransport) => transport,
) {
  const root = join(directory, "local-workbench");
  const { source } = await seedVerificationExample(root);
  await writeFile(join(root, "project.txt"), source);

  const resources = join(directory, "resources");
  await mkdir(resources);
  await symlink(process.execPath, join(resources, "bun"));
  await symlink(join(import.meta.dir, "../.."), join(resources, "apps"));

  const contextFile = join(directory, "context");
  const probeLog = join(directory, "verification-probes");
  await writeFile(contextFile, originalHost);
  await writeFile(
    join(directory, "docker"),
    `#!/bin/sh
set -eu
case "$1" in
  context) cat "${contextFile}";;
  --version|version|ps) exit 0;;
  image)
    case "$DOCKER_HOST" in
      ${originalHost}|${newHost}) ;;
      *) exit 1;;
    esac
    if [ "$3" = "--format" ]; then
      printf '%s\\n' "$DOCKER_HOST" >> "${probeLog}"
      printf '["%s"]\\n' "${VERIFICATION_IMAGE}"
    fi;;
  *) exit 1;;
esac
`,
    { mode: 0o700 },
  );

  const window = { isDestroyed: () => false } as BrowserWindow;
  let menus: MenuItemConstructorOptions[] = [];
  let notice = Promise.withResolvers<string>();
  const electron = {
    app: { getPath: () => directory },
    dialog: {
      async showMessageBox(_window: unknown, box: { detail?: string }) {
        notice.resolve(box.detail ?? "");
        return { response: 0 };
      },
      showErrorBox(title: string, detail: string) {
        notice.reject(new Error(`${title}: ${detail}`));
      },
    },
    ipcMain: { handle() {} },
    Menu: {
      buildFromTemplate: (items: MenuItemConstructorOptions[]) => items,
      setApplicationMenu: (items: MenuItemConstructorOptions[]) => {
        menus = items;
      },
    },
    safeStorage: { isEncryptionAvailable: () => false },
  } as unknown as Parameters<typeof createDesktop>[3]["electron"];

  let desktop: Awaited<ReturnType<typeof createDesktop>>;
  let windowReloads = 0;
  let notifyWorkbenchChanged: (() => void) | undefined;
  const bridge = createManagedWorkbenchBridge({
    connect: () =>
      createReconnectingBridge({
        resolve: () => desktop.resolve(),
        makeTransport: (connection) =>
          wrapTransport(createLoopbackTransport(connection)),
      }),
    isChanging: () => desktop.isChanging(),
    reloadWindow: () => {
      windowReloads++;
    },
    refreshRenderer: () => {
      notifyWorkbenchChanged?.();
    },
  });
  desktop = await createDesktop(
    window,
    bridge.reconnect,
    bridge.hasPendingLaunch,
    {
      electron,
      resources,
      async locateDocker() {
        const path = resolveDockerPath({ path: directory });
        return { path, host: await resolveDockerHost(path, { env: {} }) };
      },
    },
  );

  const menu = menus.find((item) => item.label === "Project")?.submenu;
  const checkSandbox = Array.isArray(menu)
    ? menu.find((item) => item.label === "Set Up Verification Sandbox…")?.click
    : undefined;
  return {
    bridge,
    desktop,
    switchContext: () => writeFile(contextFile, newHost),
    verifiedHosts: async () =>
      (await readFile(probeLog, "utf8")).trim().split("\n"),
    async checkSandbox() {
      if (!checkSandbox) throw new Error("Sandbox menu item not found");
      notice = Promise.withResolvers<string>();
      // The menu callback does not use Electron's event arguments.
      Reflect.apply(checkSandbox, undefined, []);
      return notice.promise;
    },
    onWorkbenchChanged(refresh: () => void) {
      notifyWorkbenchChanged = refresh;
    },
    windowReloads: () => windowReloads,
  };
}

test.skipIf(process.platform === "win32")(
  "switching Docker contexts replaces a ready desktop workbench and refreshes the composer without discarding drafts",
  async () => {
    await withDesktop(async (fixture) => {
      const doc = new MiniDocument();
      const shell = Object.fromEntries(
        BRIDGE_METHODS.map((method) => [
          method,
          (params: unknown) => fixture.bridge.call(method, params),
        ]),
      ) as ShellBridge;
      const app = startShell({
        document: doc,
        marsWorkbench: shell,
        marsAssistant: {
          onWorkbenchChanged: fixture.onWorkbenchChanged,
          request: async () => ({
            ok: true,
            workspace: fixture.desktop.chatContext().workspace,
            configured: true,
            canConfigure: true,
            sessions: [],
          }),
        },
        addEventListener() {},
      });
      if (!app) throw new Error("Renderer did not start");
      const node = (attr: string, value: string) => {
        const element = findAll(
          doc.root,
          (el) => el.getAttribute(attr) === value,
        )[0];
        if (!element) throw new Error(`Missing ${attr}=${value}`);
        return element;
      };
      try {
        await app.settled();
        const initial = await fixture.desktop.resolve();
        expect(initial.ok).toBe(true);
        expect(await fixture.verifiedHosts()).toEqual([originalHost]);
        const chat = node("data-focus-key", "assistant-input");
        chat.value = "Unsent chat";
        chat.dispatch("input");
        node("data-page", "tasks").click();
        const task = node("data-control", "composer-request");
        task.value = "Unsent task";
        task.dispatch("input");
        const start = node("data-control", "composer-start-now");
        start.checked = true;
        start.dispatch("change");
        const execute = node("data-control", "composer-execute");
        expect(execute.getAttribute("disabled")).toBeNull();

        await fixture.switchContext();
        expect(await fixture.checkSandbox()).toContain("Approve Execute");
        await app.settled();

        const next = await fixture.desktop.resolve();
        expect(next.ok).toBe(true);
        expect(next).not.toEqual(initial);
        expect(await fixture.verifiedHosts()).toEqual([originalHost, newHost]);
        expect(fixture.windowReloads()).toBe(0);
        const refreshed = node("data-control", "composer-execute");
        expect(refreshed).not.toBe(execute);
        expect(refreshed.getAttribute("disabled")).toBeNull();
        expect(node("data-control", "composer-request").value).toBe(
          "Unsent task",
        );
        node("data-page", "chat").click();
        expect(node("data-focus-key", "assistant-input").value).toBe(
          "Unsent chat",
        );
      } finally {
        app.dispose();
      }
    });
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "sandbox refresh waits for a pending tasks.start RPC even when no task is marked running",
  async () => {
    const requestEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await withDesktop(
      async (fixture) => {
        const initial = await fixture.desktop.resolve();
        expect(initial.ok).toBe(true);
        const launch = fixture.bridge.call("tasks.start", {
          task_id: "pending-start",
          expected_revision: 0,
          approvals: { read: true, write: false, execute: false },
        });
        try {
          await Promise.race([
            requestEntered.promise,
            launch.then(() => {
              throw new Error(
                "tasks.start returned without reaching transport",
              );
            }),
          ]);
          expect(await fixture.bridge.call("tasks.list", {})).toEqual({
            ok: true,
            result: [],
          });

          await fixture.switchContext();
          expect(await fixture.checkSandbox()).toContain("A task is running");
          expect(await fixture.desktop.resolve()).toEqual(initial);
          expect(await fixture.verifiedHosts()).toEqual([originalHost]);
        } finally {
          release.resolve();
          await launch;
        }

        expect(await fixture.checkSandbox()).toContain("Approve Execute");
        const next = await fixture.desktop.resolve();
        expect(next.ok).toBe(true);
        expect(next).not.toEqual(initial);
        expect(await fixture.verifiedHosts()).toEqual([originalHost, newHost]);
      },
      (transport) => ({
        async send(request) {
          if (request.method === "tasks.start") {
            requestEntered.resolve();
            await release.promise;
          }
          return transport.send(request);
        },
      }),
    );
  },
  30_000,
);
