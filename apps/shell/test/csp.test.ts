import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  appResponseHeaders,
  resolveAppAsset,
  SHELL_CSP,
  SHELL_META_CSP,
  SHELL_WEB_PREFERENCES,
} from "../src/main/security";

test.each(["index.html", "settings.html"])(
  "the %s renderer uses the strict application policy",
  async (page) => {
    const html = await readFile(
      new URL(`../src/renderer/${page}`, import.meta.url),
      "utf8",
    );
    const content = html.match(
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
    )?.[1];
    expect(content).toBe(SHELL_META_CSP);
    expect(SHELL_CSP).toContain("frame-ancestors 'none'");
    expect(SHELL_META_CSP).not.toContain("frame-ancestors");
    for (const forbidden of [
      "unsafe-inline",
      "unsafe-eval",
      "http:",
      "https:",
      "ws:",
      "wss:",
      "data:",
      "blob:",
      "*",
    ])
      expect(SHELL_CSP).not.toContain(forbidden);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(appResponseHeaders()["Content-Security-Policy"]).toBe(SHELL_CSP);
    expect(appResponseHeaders()["X-Content-Type-Options"]).toBe("nosniff");
  },
);

test("only exact same-origin assets resolve and preferences stay sandboxed", async () => {
  const rendererDir = "/shell/renderer";
  expect(resolveAppAsset("mars-shell://app/index.html", rendererDir)).toEqual({
    file: `${rendererDir}/index.html`,
    mediaType: "text/html; charset=utf-8",
  });
  expect(
    resolveAppAsset("mars-shell://app/renderer.js", rendererDir)?.mediaType,
  ).toBe("text/javascript; charset=utf-8");
  expect(
    resolveAppAsset("mars-shell://app/shell.css", rendererDir)?.mediaType,
  ).toBe("text/css; charset=utf-8");
  expect(
    resolveAppAsset("mars-shell://app/settings.html", rendererDir)?.mediaType,
  ).toBe("text/html; charset=utf-8");
  expect(
    resolveAppAsset("mars-shell://app/settings.js", rendererDir)?.mediaType,
  ).toBe("text/javascript; charset=utf-8");
  expect(
    resolveAppAsset("mars-shell://app/CommitMono-Regular.woff2", rendererDir)
      ?.mediaType,
  ).toBe("font/woff2");
  for (const url of [
    "mars-shell://evil/index.html",
    "mars-shell://app/unknown.js",
    "mars-shell://app/%2e%2e/secret",
    "mars-shell://app/a%2fb",
    "mars-shell://app/index.html?x=1",
    "https://example.com/index.html",
  ])
    expect(resolveAppAsset(url, rendererDir)).toBeNull();
  expect(SHELL_WEB_PREFERENCES).toEqual({
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    navigateOnDragDrop: false,
  });
  expect(Object.isFrozen(SHELL_WEB_PREFERENCES)).toBe(true);
  const css = await readFile(
    new URL("../src/renderer/shell.css", import.meta.url),
    "utf8",
  );
  expect(css).not.toMatch(/@import\b/i);
  expect(css.match(/url\s*\([^)]*\)/gi)).toEqual([
    'url("./Manrope-Variable.woff2")',
    'url("./Inter-Variable.woff2")',
    'url("./CommitMono-Regular.woff2")',
    'url("./BarlowCondensed-SemiBold.woff2")',
    'url("./orbit.svg")',
  ]);
});
