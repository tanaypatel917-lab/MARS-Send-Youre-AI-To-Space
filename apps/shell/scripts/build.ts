import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function buildShell(outdir: string): Promise<void> {
  const root = import.meta.dir.replace(/\/scripts$/, "");
  const rendererDir = resolve(outdir, "renderer");
  await mkdir(rendererDir, { recursive: true });
  const renderer = await Bun.build({
    entrypoints: [resolve(root, "src/renderer/app.ts")],
    outdir: rendererDir,
    naming: "renderer.js",
    target: "browser",
    format: "esm",
    minify: false,
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
    entrypoints: [resolve(root, "src/preload/preload.ts")],
    outdir,
    naming: "preload.cjs",
    target: "node",
    format: "cjs",
    external: ["electron"],
  });
  if (!preload.success) throw new Error(preload.logs.join("\n"));
  await copyFile(
    resolve(root, "src/renderer/index.html"),
    resolve(rendererDir, "index.html"),
  );
  await copyFile(
    resolve(root, "src/renderer/shell.css"),
    resolve(rendererDir, "shell.css"),
  );
}

if (import.meta.main) {
  const outdir = resolve(process.argv[2] ?? "dist");
  await buildShell(outdir);
}
