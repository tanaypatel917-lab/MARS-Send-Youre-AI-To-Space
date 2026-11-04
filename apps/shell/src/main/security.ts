import { join } from "node:path";

export const SHELL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const SHELL_META_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export const SHELL_WEB_PREFERENCES = Object.freeze({
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

export type AppAsset = { file: string; mediaType: string };

export function resolveAppAsset(
  url: string,
  rendererDir = join(process.cwd(), "apps", "shell", "dist", "renderer"),
): AppAsset | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "mars-shell:" ||
    parsed.host !== "app" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  )
    return null;
  const assets: Record<string, string> = {
    "/index.html": "text/html; charset=utf-8",
    "/renderer.js": "text/javascript; charset=utf-8",
    "/shell.css": "text/css; charset=utf-8",
  };
  const mediaType = assets[parsed.pathname];
  if (!mediaType) return null;
  return {
    file: join(rendererDir, parsed.pathname.slice(1)),
    mediaType,
  };
}

export function appResponseHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": SHELL_CSP,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}
