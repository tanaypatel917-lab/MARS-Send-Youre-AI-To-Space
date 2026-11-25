import { execFile } from "node:child_process";
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
import { basename, isAbsolute, join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  safeStorage,
  shell,
} from "electron";
import { DESKTOP_MODEL_CHANNEL } from "../shared/desktop-model";
import { resolveDockerHost } from "./docker-host";
import { resolveDockerPath } from "./docker-path";
import { desktopExtensionsMenu } from "./extensions";
import { startLocalWorkbench } from "./local-workbench";
import { hasRemovableKey } from "./model-key";
import {
  PROJECT_VERIFICATION_IMAGE,
  projectChecksFile,
  removeProjectChecks,
  saveProjectChecks,
  suggestProjectChecks,
} from "./project-verification";
import { SHELL_WEB_PREFERENCES } from "./security";
import {
  seedVerificationExample,
  VERIFICATION_IMAGE,
} from "./verification-example";
import { verificationStateRoot } from "./verification-state";

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

export async function createDesktop(
  window: BrowserWindow,
  reload: (change: "project" | "model") => void,
) {
  const root = join(app.getPath("userData"), "local-workbench");
  const demo = join(root, "demo-project");
  const projectFile = join(root, "project.txt");
  const projectVerificationRoot = join(root, "project-verification");
  const keyFile = join(root, "openrouter-key.bin");
  await mkdir(demo, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const verification = await seedVerificationExample(root);
  const verificationState = await verificationStateRoot(
    join(root, "projects"),
    app.getPath("home"),
  );
  let dockerPath = resolveDockerPath();
  let dockerHost = await resolveDockerHost(dockerPath);
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
  let chatLifetime = new AbortController();

  const change = async (
    save: () => Promise<void>,
    kind: "project" | "model" = "project",
  ) => {
    if (changing || closing) return false;
    changing = true;
    chatLifetime.abort();
    try {
      await save();
      await workbench?.stop();
      if (!closing && !window.isDestroyed()) reload(kind);
      return true;
    } catch {
      return false;
    } finally {
      chatLifetime = new AbortController();
      changing = false;
    }
  };

  const downloadSandbox = async (project: string, image: string) => {
    dockerPath = resolveDockerPath();
    dockerHost = await resolveDockerHost(dockerPath);
    const executable = dockerPath;
    const env = {
      PATH: process.env.PATH,
      HOME: "/nonexistent",
      ...(dockerHost ? { DOCKER_HOST: dockerHost } : {}),
    };
    const run = (args: string[]) =>
      new Promise<boolean>((resolve) => {
        if (!executable) return resolve(false);
        execFile(
          executable,
          args,
          {
            env,
            timeout: args[0] === "pull" ? 600_000 : 5_000,
          },
          (error) => resolve(!error),
        );
      });
    if (!(await run(["--version"]))) {
      const answer = await dialog.showMessageBox(window, {
        type: "info",
        message: "Install Docker to run verification checks",
        detail:
          "Install and start Docker, then use Set Up Verification Sandbox… again.",
        buttons: ["Cancel", "Open Docker installation guide"],
        cancelId: 0,
      });
      if (answer.response === 1)
        await shell.openExternal("https://docs.docker.com/get-docker/");
      return;
    }
    if (!(await run(["version", "--format", "{{.Server.Version}}"]))) {
      await dialog.showMessageBox(window, {
        type: "info",
        message: "Start Docker to run verification checks",
        detail:
          "Make sure the local Docker daemon is running and available, then use Set Up Verification Sandbox… again.",
      });
      return;
    }
    if (await run(["image", "inspect", image])) {
      if (source === project) await change(async () => {});
      await dialog.showMessageBox(window, {
        message: "Verification sandbox is already downloaded",
        detail: "Approve Execute and select your checks when starting a task.",
      });
      return;
    }
    const answer = await dialog.showMessageBox(window, {
      type: "question",
      message: "Download the verification sandbox?",
      detail: `Docker will pull this exact pinned image:\n${image}\nChecks run without network access.`,
      buttons: ["Cancel", "Download"],
      cancelId: 0,
      defaultId: 0,
    });
    if (answer.response !== 1) return;
    const ok = await run(["pull", image]);
    if (ok && source === project) await change(async () => {});
    if (closing || window.isDestroyed()) return;
    await dialog.showMessageBox(window, {
      type: ok ? "info" : "error",
      message: ok
        ? "Verification sandbox downloaded"
        : "Sandbox download failed",
      detail: ok
        ? "Approve Execute and select your checks when starting a task."
        : "Make sure Docker is running and your connection can reach the image registry, then try again.",
    });
  };

  let settingUpVerification = false;
  const setupVerification = async (project: string, firstOpen = false) => {
    if (settingUpVerification || closing) return;
    settingUpVerification = true;
    try {
      if (project === verification.source || project === demo) {
        if (!firstOpen) await downloadSandbox(project, VERIFICATION_IMAGE);
        return;
      }
      const current = await projectChecksFile(projectVerificationRoot, project);
      if (firstOpen && current) return;
      const proposal = await suggestProjectChecks(project);
      if (source !== project || closing || window.isDestroyed()) return;
      if (!proposal && !current) {
        if (!firstOpen)
          await dialog.showMessageBox(window, {
            message: "No supported verification checks found",
            detail:
              "Add a test, lint, or typecheck script to the root package.json and try again. Or open the built-in Verification Example.",
          });
        return;
      }
      if (current) {
        const answer = await dialog.showMessageBox(window, {
          type: "question",
          message: "Manage project verification",
          detail: project,
          buttons: [
            "Cancel",
            "Check Sandbox",
            "Remove Checks",
            ...(proposal ? ["Review Current Scripts"] : []),
          ],
          defaultId: 0,
          cancelId: 0,
        });
        if (source !== project || answer.response === 0) return;
        if (answer.response === 1) {
          await downloadSandbox(project, PROJECT_VERIFICATION_IMAGE);
          return;
        }
        if (answer.response === 2) {
          if (
            !(await change(() =>
              removeProjectChecks(projectVerificationRoot, project),
            ))
          )
            throw new Error("Could not remove checks");
          return;
        }
      }
      if (!proposal) return;
      const selected = new Set<string>();
      for (const { name, steps } of proposal.checks) {
        const commands = steps
          .map((step) => `${step.name}: ${JSON.stringify(step.command)}`)
          .join("\n");
        const answer = await dialog.showMessageBox(window, {
          type: "question",
          message: `Use the ${name} script as a verification check?`,
          detail: `${project}\n\n${commands}\n\nApprove only if you trust this project and the code these scripts invoke. Checks run in Docker, offline, without dependencies installed by MARS. Task changes can still alter the project’s tests.`,
          buttons: ["Cancel Setup", "Skip", "Use Check"],
          defaultId: 0,
          cancelId: 0,
        });
        if (source !== project || closing || answer.response === 0) return;
        if (answer.response === 2) selected.add(name);
      }
      if (!selected.size) return;
      if (
        !(await change(() =>
          saveProjectChecks(
            projectVerificationRoot,
            project,
            proposal,
            selected,
          ),
        ))
      )
        throw new Error("Could not save checks");
      await downloadSandbox(project, PROJECT_VERIFICATION_IMAGE);
    } catch {
      dialog.showErrorBox(
        "Verification setup failed",
        "Could not finish verification setup. Use the Project menu to try again.",
      );
    } finally {
      settingUpVerification = false;
    }
  };

  const chooseProject = async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "Open a MARS project folder",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return;
    const selected = await realpath(result.filePaths[0]);
    if (
      !(await change(async () => {
        await replacePrivate(projectFile, selected);
        source = selected;
      }))
    ) {
      dialog.showErrorBox("Project unchanged", "Could not switch projects.");
      return;
    }
    await setupVerification(selected, true);
  };

  const showModelSettings = () => {
    if (modelWindow && !modelWindow.isDestroyed()) {
      modelWindow.focus();
      return;
    }
    modelWindow = new BrowserWindow({
      parent: window,
      modal: true,
      width: 560,
      height: 590,
      resizable: false,
      title: "MARS Model Settings",
      backgroundColor: "#101216",
      webPreferences: {
        ...SHELL_WEB_PREFERENCES,
        preload: join(app.getAppPath(), "settings.cjs"),
      },
    });
    void modelWindow.loadURL(settingsPage);
  };

  ipcMain.handle(`${DESKTOP_MODEL_CHANNEL}:key-page`, async (event) => {
    if (
      !modelWindow ||
      modelWindow.isDestroyed() ||
      event.sender !== modelWindow.webContents ||
      event.senderFrame?.url !== settingsPage
    )
      return false;
    await shell.openExternal("https://openrouter.ai/settings/keys");
    return true;
  });

  ipcMain.handle(
    `${DESKTOP_MODEL_CHANNEL}:has-key`,
    (event) =>
      !!modelWindow &&
      !modelWindow.isDestroyed() &&
      event.sender === modelWindow.webContents &&
      event.senderFrame?.url === settingsPage &&
      hasRemovableKey(keyFile, openRouterKey),
  );

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
    if (key === null && !openRouterKey) {
      // An unreadable credential from an earlier login may still exist.
      try {
        await rm(keyFile, { force: true });
        return "cleared";
      } catch {
        return "unavailable";
      }
    }
    const saved = await change(async () => {
      if (key === null) await rm(keyFile, { force: true });
      else if (persist)
        await replacePrivate(keyFile, safeStorage.encryptString(key));
      else await rm(keyFile, { force: true });
      openRouterKey = key ?? undefined;
    }, "model");
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
        state:
          source === verification.source
            ? verificationState.state
            : join(root, "projects"),
        ...(dockerPath ? { dockerPath } : {}),
        ...(dockerHost ? { dockerHost } : {}),
        ...(source === verification.source
          ? {
              ...(verificationState.reason
                ? { verificationUnavailableReason: verificationState.reason }
                : { image: VERIFICATION_IMAGE }),
              checksFile: verification.checksFile,
              verifiedExportsOnly: true,
            }
          : { projectVerificationRoot }),
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
      {
        label: "Open Verification Example",
        click: () => {
          void change(async () => {
            await replacePrivate(projectFile, verification.source);
            source = verification.source;
          });
        },
      },
      {
        label: "Set Up Verification Sandbox…",
        click: () => void setupVerification(source),
      },
      { type: "separator" },
      { label: "Model Settings…", click: showModelSettings },
      ...desktopExtensionsMenu(
        { dialog, ipcMain },
        window,
        activeWorkbench,
        () =>
          source === demo
            ? "demo-project"
            : `${basename(source) || source}\nFolder: ${source}`,
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
    chatContext() {
      if (changing || closing) throw new Error("Workspace changing");
      return {
        workspace: source,
        key: openRouterKey,
        signal: chatLifetime.signal,
        settings: showModelSettings,
      };
    },
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
      chatLifetime.abort();
      await workbench?.stop();
    },
  };
}
