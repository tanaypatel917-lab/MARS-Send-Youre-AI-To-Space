import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildShell } from "../scripts/build";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(?:ts|js|html|css)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("renderer sources and built bundle have no unsafe DOM, code, or network primitives", async () => {
  const rendererRoot = new URL("../src/renderer/", import.meta.url);
  const rootPath = decodeURIComponent(rendererRoot.pathname);
  const sources = await sourceFiles(rootPath);
  const output = await mkdtemp(join(tmpdir(), "mars-shell-static-"));
  try {
    await buildShell(output);
    const built = join(output, "renderer", "renderer.js");
    const paths = [...sources, built];
    const forbidden = [
      /\binnerHTML\b/,
      /\bouterHTML\b/,
      /\binsertAdjacentHTML\b/,
      /\bdocument\.write\b/,
      /\beval\s*\(/,
      /\bnew\s+Function\b/,
      /\bsetTimeout\s*\(\s*["'`]/,
      /\bhttps?:\/\//i,
      /\bwss?:\/\//i,
    ];
    for (const path of paths) {
      const content = await readFile(path, "utf8");
      for (const expression of forbidden)
        expect(content).not.toMatch(expression);
      if (path.endsWith(".css")) expect(content).not.toMatch(/url\s*\(/i);
    }
    for (const path of sources.filter((file) => file.endsWith(".ts"))) {
      const content = await readFile(path, "utf8");
      for (const match of content.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
        const specifier = match[1];
        if (!specifier) continue;
        const importStart = content.lastIndexOf("import", match.index ?? 0);
        const declaration = content.slice(importStart, match.index);
        const typeOnly = /^\s*import\s+type\b/.test(declaration);
        if (typeOnly || specifier.startsWith(".")) continue;
        expect(["@mars/ui-core", "@mars/output-format"]).toContain(specifier);
      }
    }

    for (const file of ["main.cjs", "preload.cjs"]) {
      const source = await readFile(join(output, file), "utf8");
      const requires = [...source.matchAll(/\brequire\(["']([^"']+)["']\)/g)]
        .map((match) => match[1])
        .filter((specifier): specifier is string => specifier !== undefined);
      for (const specifier of requires)
        expect(specifier === "electron" || specifier.startsWith("node:")).toBe(
          true,
        );
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
