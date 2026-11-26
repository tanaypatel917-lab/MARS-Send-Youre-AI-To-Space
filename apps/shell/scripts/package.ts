import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createBridge } from "../src/main/bridge";
import { startLocalWorkbench } from "../src/main/local-workbench";
import { createLoopbackTransport } from "../src/main/transport";
import { buildShell } from "./build";
import { buildUpstream } from "./build-upstream";

const shell = resolve(import.meta.dir, "..");
const repo = resolve(shell, "../..");
const electron = join(shell, "node_modules", "electron", "dist");
const output = join(shell, "dist", "installers");
const icon = join(shell, "assets", "mars.png");
const { version } = JSON.parse(
  await readFile(join(shell, "package.json"), "utf8"),
) as { version: string };

function run(program: string, args: string[], cwd?: string) {
  execFileSync(program, args, { cwd, stdio: "inherit" });
}

async function stageWorkbench(resources: string, scratch: string) {
  const runtime = join(resources, "workbench");
  await mkdir(runtime, { recursive: true });
  await copyFile(process.execPath, join(runtime, "bun"));
  await chmod(join(runtime, "bun"), 0o755);
  for (const name of [".bun-version", "bun.lock", "package.json"])
    await copyFile(join(repo, name), join(runtime, name));
  for (const group of ["apps", "packages"]) {
    for (const project of await readdir(join(repo, group))) {
      const from = join(repo, group, project);
      const to = join(runtime, group, project);
      const manifest = await readFile(join(from, "package.json")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (!manifest) continue;
      await mkdir(to, { recursive: true });
      await writeFile(join(to, "package.json"), manifest);
    }
  }
  run(
    process.execPath,
    [
      "install",
      "--filter",
      "@mars/shell",
      "--production",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--backend",
      "copyfile",
    ],
    runtime,
  );
  const runtimePackages = join(runtime, "packages");
  for (const project of await readdir(runtimePackages)) {
    const target = join(runtimePackages, project);
    // The filtered Bun install links the production workspace closure.
    if (!(await readdir(target)).includes("node_modules")) continue;
    await cp(join(repo, "packages", project, "src"), join(target, "src"), {
      recursive: true,
      filter: (path) => !/\.test\.[cm]?[jt]sx?$/.test(path),
    });
    if (project === "providers-omniroute")
      await cp(
        join(repo, "packages", project, "catalog"),
        join(target, "catalog"),
        {
          recursive: true,
        },
      );
  }
  await cp(
    join(shell, "src", "runtime"),
    join(runtime, "apps", "shell", "src", "runtime"),
    { recursive: true },
  );

  await buildUpstream(
    join(runtime, "apps", "shell", "src", "runtime", "catalog"),
  );
  const source = join(scratch, "source");
  await mkdir(source);
  const host = startLocalWorkbench({
    resources: runtime,
    source,
    state: join(scratch, "Application Support", "MARS", "local-workbench"),
  });
  try {
    const connected = await host.connection();
    if (!connected.ok) throw new Error(connected.reason);
    const result = await createBridge({
      transport: createLoopbackTransport(connected.connection),
      connectionScope: connected.connection.scope,
    }).call("workbench.describe", {});
    if (!result.ok) throw new Error("Packaged workbench did not answer RPC.");
    for (const id of ["mcp-filesystem", "mcp-sequential-thinking"]) {
      await host.extensionAction({ action: "install", id });
      if (
        !(await host.extensionAction({ action: "list" })).installed.includes(id)
      )
        throw new Error(`Missing packaged upstream MCP: ${id}`);
    }
    // Native menus and the library can refresh or install at the same time.
    const [before, , after] = await Promise.all([
      host.extensionAction({ action: "list" }),
      host.extensionAction({ action: "install", id: "mars-release-kit" }),
      host.extensionAction({ action: "list" }),
    ]);
    if (
      before.installed.includes("mars-release-kit") ||
      !after.installed.includes("mars-release-kit")
    )
      throw new Error("Packaged extension catalog is unavailable.");
  } finally {
    await host.stop();
  }
  const execution = join(runtime, "packages", "execution", "src", "index.ts");
  run(
    join(runtime, "bun"),
    [
      "--no-env-file",
      "-e",
      `import { probeExecution } from ${JSON.stringify(execution)}; await probeExecution();`,
    ],
    runtime,
  );
}

async function stageApp(resources: string, scratch: string) {
  const app = join(resources, "app");
  await rm(join(resources, "default_app.asar"), { force: true });
  await buildShell(app);
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({
      name: "mars",
      productName: "MARS",
      version,
      main: "main.cjs",
    }),
  );
  await stageWorkbench(resources, scratch);
}

async function packageMac(stage: string) {
  const volume = join(stage, "volume");
  await mkdir(volume);
  const bundle = join(volume, "MARS.app");
  const contents = join(bundle, "Contents");
  const resources = join(contents, "Resources");
  run("ditto", [join(electron, "Electron.app"), bundle]);
  await rename(
    join(contents, "MacOS", "Electron"),
    join(contents, "MacOS", "MARS"),
  );
  await stageApp(resources, stage);
  const plist = join(contents, "Info.plist");
  for (const [key, value] of [
    ["CFBundleExecutable", "MARS"],
    ["CFBundleName", "MARS"],
    ["CFBundleDisplayName", "MARS"],
    ["CFBundleIdentifier", "io.github.tanaypatel917-lab.mars"],
    ["CFBundleShortVersionString", version],
    ["CFBundleVersion", version],
    ["CFBundleIconFile", "mars.icns"],
  ] as const)
    run("plutil", ["-replace", key, "-string", value, plist]);
  const iconset = join(stage, "mars.iconset");
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      run("sips", [
        "-z",
        pixels,
        pixels,
        icon,
        "--out",
        join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
      ]);
    }
  }
  run("iconutil", ["-c", "icns", iconset, "-o", join(resources, "mars.icns")]);
  run("codesign", ["--force", "--deep", "--sign", "-", bundle]);
  run("codesign", ["--verify", "--deep", "--strict", bundle]);
  await symlink("/Applications", join(volume, "Applications"));
  const file = join(output, `MARS-${version}-macOS-${process.arch}.dmg`);
  for (let attempt = 1; attempt <= 5; attempt++) {
    await rm(file, { force: true });
    try {
      run("hdiutil", [
        "create",
        "-volname",
        "MARS",
        "-srcfolder",
        volume,
        "-format",
        "UDZO",
        file,
      ]);
      break;
    } catch (error) {
      if (attempt === 5) throw error;
      await Bun.sleep(2000 * attempt);
    }
  }
}

async function packageLinux(stage: string) {
  const payload = join(stage, "deb");
  const app = join(payload, "opt", "mars");
  const locals = join(payload, "usr", "share");
  const control = join(payload, "DEBIAN");
  await mkdir(join(locals, "applications"), { recursive: true });
  await mkdir(join(locals, "pixmaps"), { recursive: true });
  await mkdir(control, { recursive: true });
  await cp(electron, app, { recursive: true, verbatimSymlinks: true });
  await rename(join(app, "electron"), join(app, "mars"));
  await chmod(join(app, "chrome-sandbox"), 0o4755);
  await stageApp(join(app, "resources"), stage);
  await copyFile(icon, join(locals, "pixmaps", "mars.png"));
  await writeFile(
    join(locals, "applications", "mars.desktop"),
    "[Desktop Entry]\nType=Application\nName=MARS\nComment=MARS desktop workbench\nExec=/opt/mars/mars\nIcon=mars\nTerminal=false\nCategories=Development;\n",
  );
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  await writeFile(
    join(control, "control"),
    `Package: mars-workbench\nVersion: ${version}\nSection: devel\nPriority: optional\nArchitecture: ${arch}\nDepends: libgtk-3-0t64 | libgtk-3-0, libasound2t64 | libasound2, libnss3, libxss1, libgbm1, libxkbcommon0, libx11-xcb1\nMaintainer: MARS maintainers\nDescription: MARS desktop workbench\n`,
  );
  run("dpkg-deb", [
    "--root-owner-group",
    "-Zgzip",
    "-z3",
    "--build",
    payload,
    join(output, `MARS-${version}-linux-${arch}.deb`),
  ]);
}

if (
  !["darwin", "linux"].includes(process.platform) ||
  !["arm64", "x64"].includes(process.arch)
)
  throw new Error("Build MARS on a supported macOS or Linux host.");
const expectedBun = (await readFile(join(repo, ".bun-version"), "utf8")).trim();
if (Bun.version !== expectedBun)
  throw new Error(`Use Bun ${expectedBun} to package MARS.`);
await mkdir(output, { recursive: true });
// Stage outside the checkout so missing dependencies cannot resolve from its node_modules.
const stage = await mkdtemp(join(await realpath(tmpdir()), "mars-desktop-"));
try {
  await (process.platform === "darwin"
    ? packageMac(stage)
    : packageLinux(stage));
  console.log(`Built MARS in ${basename(output)}/`);
} finally {
  await rm(stage, { force: true, recursive: true });
}
