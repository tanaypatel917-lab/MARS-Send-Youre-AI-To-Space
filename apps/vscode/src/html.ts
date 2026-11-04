export interface HtmlOptions {
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
  title?: string;
}

const ATTR = /[&<>"']/g;
const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeAttribute(value: string): string {
  return value.replace(ATTR, (char) => ENTITIES[char] ?? char);
}

export function isValidNonce(nonce: string): boolean {
  return /^[A-Za-z0-9+/]{22,}={0,2}$/.test(nonce);
}

/**
 * Static shell for the workbench webview. The body is built by the bundled
 * script with DOM APIs and textContent only; the CSP allows no inline script,
 * no inline style, no network access and no frames.
 */
export function buildWebviewHtml(options: HtmlOptions): string {
  if (!isValidNonce(options.nonce)) throw new Error("Invalid CSP nonce");
  const csp = [
    "default-src 'none'",
    `style-src ${options.cspSource}`,
    `img-src ${options.cspSource}`,
    `font-src ${options.cspSource}`,
    `script-src 'nonce-${options.nonce}'`,
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttribute(options.styleUri)}">
<title>${escapeAttribute(options.title ?? "MARS Tasks")}</title>
</head>
<body>
<main id="app" aria-live="polite"></main>
<script nonce="${escapeAttribute(options.nonce)}" src="${escapeAttribute(options.scriptUri)}"></script>
</body>
</html>`;
}
