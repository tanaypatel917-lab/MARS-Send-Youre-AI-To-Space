import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  appResponseHeaders,
  resolveAppAsset,
  SHELL_CSP,
  SHELL_META_CSP,
  SHELL_WEB_PREFERENCES,
} from "../src/main/security";

const HTML_PATH = new URL("../src/renderer/index.html", import.meta.url);

test("the renderer meta policy matches the strict application policy", async () => {
  const html = await readFile(HTML_PATH, "utf8");
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
});

test("only three exact same-origin assets resolve and preferences stay sandboxed", async () => {
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
  expect(css).not.toMatch(/url\s*\(/i);
});
