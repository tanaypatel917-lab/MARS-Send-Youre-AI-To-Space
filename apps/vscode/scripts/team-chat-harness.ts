// Builds the Team Chat webview with a stub VS Code API over the fixture and
// screenshots deterministic scenarios in headless Chrome. Development aid for
// the PR 1 prototype; not part of `bun run check`.
//
//   bun scripts/team-chat-harness.ts --out /tmp/team-chat-shots [--chrome google-chrome] [--keep]
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWebviewHtml } from "../src/html";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg?.startsWith("--")) continue;
  const next = argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(arg.slice(2), next);
    i++;
  } else args.set(arg.slice(2), "true");
}
const out = resolve(args.get("out") ?? join(root, "dist", "harness"));
const chrome = args.get("chrome") ?? "google-chrome";

const SCENARIOS: { name: string; width: number; height: number }[] = [
  { name: "inbox", width: 1400, height: 900 },
  { name: "group", width: 1400, height: 900 },
  { name: "picker", width: 1400, height: 900 },
  { name: "chips", width: 1400, height: 900 },
  { name: "panel", width: 1400, height: 900 },
  { name: "linus", width: 1400, height: 900 },
  { name: "pending", width: 1400, height: 900 },
  { name: "failed", width: 1400, height: 900 },
  { name: "narrow", width: 560, height: 900 },
  { name: "service", width: 1400, height: 900 },
];

const THEME = `
:root {
  --vscode-font-family: "Segoe WPC", "Segoe UI", system-ui, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: "Droid Sans Mono", "monospace", monospace;
  --vscode-editor-font-size: 12px;
  --vscode-foreground: #cccccc;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-errorForeground: #f48771;
  --vscode-focusBorder: #007fd4;
  --vscode-panel-border: #2b2b2b;
  --vscode-editor-background: #1e1e1e;
  --vscode-editor-foreground: #d4d4d4;
  --vscode-editorWidget-background: #252526;
  --vscode-editorWidget-border: #454545;
  --vscode-editor-selectionBackground: #264f78;
  --vscode-editorLineNumber-foreground: #858585;
  --vscode-editorLineNumber-activeForeground: #c6c6c6;
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-secondaryBackground: #3a3d41;
  --vscode-button-secondaryForeground: #ffffff;
  --vscode-input-background: #3c3c3c;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-badge-background: #4d4d4d;
  --vscode-badge-foreground: #ffffff;
  --vscode-list-activeSelectionBackground: #04395e;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-textLink-foreground: #3794ff;
}
body { background: var(--vscode-editor-background); }
`;

async function main(): Promise<void> {
  await mkdir(out, { recursive: true });
  const build = await Bun.build({
    entrypoints: [join(here, "team-chat-harness", "entry.ts")],
    target: "browser",
    format: "iife",
    outdir: out,
    naming: "harness.js",
  });
  if (!build.success) {
    for (const log of build.logs) console.error(String(log));
    throw new Error("harness bundle failed");
  }
  const css = await Bun.file(join(root, "media", "team-chat.css")).text();
  await writeFile(join(out, "harness.css"), `${THEME}\n${css}`);
  const nonce = Buffer.from(
    crypto.getRandomValues(new Uint8Array(18)),
  ).toString("base64");
  const html = buildWebviewHtml({
    cspSource: "file:",
    nonce,
    scriptUri: "harness.js",
    styleUri: "harness.css",
    title: "MARS Team Chat harness (FIXTURE)",
  });
  const page = join(out, "harness.html");
  await writeFile(page, html);
  const results: string[] = [];
  for (const scenario of SCENARIOS) {
    const png = join(out, `team-chat-${scenario.name}.png`);
    const proc = Bun.spawn(
      [
        chrome,
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        `--window-size=${scenario.width},${scenario.height}`,
        "--virtual-time-budget=4000",
        `--screenshot=${png}`,
        `file://${page}?scenario=${scenario.name}`,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`chrome failed for ${scenario.name}: ${err.slice(-400)}`);
    }
    results.push(png);
  }
  console.log(results.join("\n"));
}

await main();
