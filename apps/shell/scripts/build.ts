import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function buildShell(outdir: string): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const rendererDir = resolve(outdir, "renderer");
  await mkdir(rendererDir, { recursive: true });
  const renderer = await Bun.build({
    entrypoints: [resolve(root, "src/renderer/app.ts")],
    outdir: rendererDir,
    naming: "renderer.js",
    target: "browser",
    format: "esm",
    minify: false,
    plugins: [
      {
        name: "ui-core-browser-projection",
        setup(build) {
          build.onResolve({ filter: /^@mars\/ui-core$/ }, () => ({
            path: resolve(root, "../../packages/ui-core/src/projection.ts"),
          }));
        },
      },
    ],
  });
  if (!renderer.success) throw new Error(renderer.logs.join("\n"));
  const main = await Bun.build({
    entrypoints: [resolve(root, "src/main/main.ts")],
    outdir,
    naming: "main.cjs",
    target: "node",
    format: "cjs",
    external: ["electron"],
  });
  if (!main.success) throw new Error(main.logs.join("\n"));
  const preload = await Bun.build({
    entrypoints: [
      resolve(root, "src/preload/preload.ts"),
      resolve(root, "src/preload/managed.ts"),
    ],
    outdir,
    naming: "[name].cjs",
    target: "node",
    format: "cjs",
    external: ["electron"],
  });
  if (!preload.success) throw new Error(preload.logs.join("\n"));
  const settingsPreload = await Bun.build({
    entrypoints: [resolve(root, "src/preload/settings.ts")],
    outdir,
    naming: "settings.cjs",
    target: "node",
    format: "cjs",
    external: ["electron"],
  });
  if (!settingsPreload.success)
    throw new Error(settingsPreload.logs.join("\n"));
  const settings = await Bun.build({
    entrypoints: [resolve(root, "src/renderer/settings.ts")],
    outdir: rendererDir,
    naming: "settings.js",
    target: "browser",
    format: "esm",
  });
  if (!settings.success) throw new Error(settings.logs.join("\n"));
  await copyFile(
    resolve(root, "src/renderer/settings.html"),
    resolve(rendererDir, "settings.html"),
  );
  await copyFile(
    resolve(root, "src/renderer/index.html"),
    resolve(rendererDir, "index.html"),
  );
  await copyFile(
    resolve(root, "src/renderer/shell.css"),
    resolve(rendererDir, "shell.css"),
  );
  await copyFile(
    resolve(root, "assets/CommitMono-Regular.woff2"),
    resolve(rendererDir, "CommitMono-Regular.woff2"),
  );
  await copyFile(
    resolve(root, "assets/CommitMono-OFL.txt"),
    resolve(outdir, "CommitMono-OFL.txt"),
  );
}

if (import.meta.main) {
  const outdir = resolve(process.argv[2] ?? "dist");
  await buildShell(outdir);
}
