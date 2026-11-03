import { randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename } from "node:path";
import * as vscode from "vscode";
import { MarsClient, type VerifiedArtifact } from "./client";
import { importConnection, readConnectionFile } from "./connectionFile";
import {
  type ConnectResult,
  WorkbenchController,
  type WorkbenchUi,
} from "./controller";
import { type DiffOpenerHost, type DiffSide, openFileDiff } from "./diffOpener";
import { checkServerUrl, DEFAULT_SERVER_URL } from "./endpoint";
import { buildWebviewHtml } from "./html";
import type { HostMessage } from "./messages";
import { openReviewTarget, type ReviewOpenerHost } from "./reviewOpener";
import { HttpRpcTransport } from "./rpc";

const TOKEN_KEY = "mars.serverToken";
const VIEW_ID = "mars.workbench";
const VIEW_SCHEME = "mars-view";
const MAX_VIEW_DOCS = 50;

/** Read-only virtual documents for patches, artifacts and diff "before" sides. */
class ReadonlyDocuments implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    const key = uri.path.split("/")[1] ?? "";
    return this.docs.get(key) ?? "";
  }

  put(text: string, label: string): vscode.Uri {
    const key = randomUUID();
    this.docs.set(key, text);
    while (this.docs.size > MAX_VIEW_DOCS) {
      const oldest = this.docs.keys().next().value;
      if (oldest === undefined) break;
      this.docs.delete(oldest);
    }
    const name =
      label.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "content";
    return vscode.Uri.from({ scheme: VIEW_SCHEME, path: `/${key}/${name}` });
  }
}

function settings() {
  const config = vscode.workspace.getConfiguration("mars");
  const timeout = config.get<number>("requestTimeoutMs", 15_000);
  return {
    serverUrl: config.get<string>("serverUrl", DEFAULT_SERVER_URL),
    allowNonLoopback: config.get<boolean>("allowNonLoopbackServer", false),
    modelId: config.get<string>("modelId", "").trim() || null,
    timeoutMs: Math.min(
      120_000,
      Math.max(1_000, Number.isFinite(timeout) ? timeout : 15_000),
    ),
  };
}

class WorkbenchViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private controller: WorkbenchController | undefined;
  private view: vscode.WebviewView | undefined;
  private readonly trustedEndpoints = new Set<string>();
  private suspended = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly documents: ReadonlyDocuments,
  ) {}

  dispose(): void {
    this.controller?.dispose();
    this.controller = undefined;
  }

  /** Drops the connection and blocks reconnects until the returned resume runs. */
  suspendConnections(): () => void {
    this.suspended++;
    void this.controller?.connect();
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.suspended--;
      if (this.suspended === 0) void this.controller?.connect();
    };
  }

  get active(): WorkbenchController | undefined {
    return this.controller;
  }

  post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.controller?.dispose();
    this.view = view;
    const extensionUri = this.context.extensionUri;
    const dist = vscode.Uri.joinPath(extensionUri, "dist");
    const media = vscode.Uri.joinPath(extensionUri, "media");
    view.webview.options = {
      enableScripts: true,
      enableCommandUris: false,
      enableForms: false,
      localResourceRoots: [dist, media],
    };
    view.webview.html = buildWebviewHtml({
      cspSource: view.webview.cspSource,
      nonce: randomBytes(18).toString("base64"),
      scriptUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(dist, "webview.js"))
        .toString(),
      styleUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(media, "workbench.css"))
        .toString(),
    });
    const controller = new WorkbenchController({
      connect: () => this.connect(),
      ui: this.ui(),
      post: (state) => this.post({ type: "state", state }),
      modelId: () => settings().modelId,
      newId: randomUUID,
    });
    this.controller = controller;
    const subscriptions = [
      view.webview.onDidReceiveMessage((message: unknown) => {
        void controller.handleMessage(message);
      }),
    ];
    view.onDidDispose(() => {
      controller.dispose();
      for (const subscription of subscriptions) subscription.dispose();
      if (this.controller === controller) this.controller = undefined;
      if (this.view === view) this.view = undefined;
    });
  }

  private async connect(): Promise<ConnectResult> {
    if (this.suspended > 0)
      return {
        ok: false,
        status: "blocked",
        message: "Updating MARS connection settings…",
      };
    const config = settings();
    const endpoint = checkServerUrl(config.serverUrl, config.allowNonLoopback);
    if (!endpoint.ok)
      return { ok: false, status: "blocked", message: endpoint.reason };
    if (!endpoint.loopback && !this.trustedEndpoints.has(endpoint.rpcUrl)) {
      const action = "Trust and connect";
      const choice = await vscode.window.showWarningMessage(
        "Send your MARS token to a non-loopback server?",
        {
          modal: true,
          detail: `${endpoint.rpcUrl}\nOnly continue if you operate this server. The token is sent as a bearer credential on every request.`,
        },
        action,
      );
      if (choice !== action)
        return {
          ok: false,
          status: "blocked",
          message: `Connection to ${endpoint.rpcUrl} was not trusted.`,
        };
      this.trustedEndpoints.add(endpoint.rpcUrl);
    }
    const token = await this.context.secrets.get(TOKEN_KEY);
    if (!token)
      return {
        ok: false,
        status: "no-token",
        message:
          "Import a local connection file or set a MARS server token to connect.",
      };
    const transport = new HttpRpcTransport({
      rpcUrl: endpoint.rpcUrl,
      // Bound at connect time: a later token is only used after a reconnect
      // that re-reads the URL, never by this client.
      getToken: () => Promise.resolve(token),
      timeoutMs: config.timeoutMs,
    });
    return {
      ok: true,
      client: new MarsClient(transport),
      server: endpoint.rpcUrl,
    };
  }

  private ui(): WorkbenchUi {
    const documents = this.documents;
    const toUri = (side: DiffSide): vscode.Uri =>
      side.kind === "file"
        ? vscode.Uri.file(side.fsPath)
        : documents.put(side.text, side.label);
    const host: DiffOpenerHost = {
      folders: () =>
        (vscode.workspace.workspaceFolders ?? [])
          .filter((folder) => folder.uri.scheme === "file")
          .map((folder) => ({ name: folder.name, fsPath: folder.uri.fsPath })),
      realpath: (path) => realpath(path),
      readText: (path) => readFile(path, "utf8"),
      showDiff: async (left, right, title) => {
        await vscode.commands.executeCommand(
          "vscode.diff",
          toUri(left),
          toUri(right),
          title,
          {
            preview: true,
          },
        );
      },
      showPatch: async (patch, title) => {
        const doc = await vscode.workspace.openTextDocument(
          documents.put(patch, `${basename(title)}.diff`),
        );
        await vscode.languages.setTextDocumentLanguage(doc, "diff");
        await vscode.window.showTextDocument(doc, { preview: true });
      },
    };
    const reviewHost: ReviewOpenerHost = {
      folders: host.folders,
      realpath: host.realpath,
      showRange: async (fsPath, lineStart, lineEnd, title) => {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(fsPath),
        );
        const last = Math.max(doc.lineCount - 1, 0);
        const start = Math.min(lineStart - 1, last);
        const end = Math.min(lineEnd - 1, last);
        const range = new vscode.Range(
          start,
          0,
          end,
          doc.lineAt(end).text.length,
        );
        const editor = await vscode.window.showTextDocument(doc, {
          preview: true,
        });
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        void vscode.window.setStatusBarMessage(title, 10_000);
      },
    };
    return {
      confirm: async (message, detail, action) =>
        (await vscode.window.showWarningMessage(
          message,
          { modal: true, detail },
          action,
        )) === action,
      promptToken: () => promptForToken(this.context),
      openDiff: (server, file) => openFileDiff(host, server, file),
      copyText: async (text) => {
        await vscode.env.clipboard.writeText(text);
      },
      openReview: (server, target) =>
        openReviewTarget(reviewHost, server, target),
      openArtifact: async (artifact: VerifiedArtifact, title: string) => {
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(
            artifact.bytes,
          );
        } catch {
          text = `Binary artifact ${artifact.ref.artifact_id} (${artifact.media_type}, ${artifact.bytes.byteLength} bytes, sha256 ${artifact.ref.sha256}).`;
        }
        const doc = await vscode.workspace.openTextDocument(
          documents.put(text, title),
        );
        await vscode.window.showTextDocument(doc, { preview: true });
      },
    };
  }
}

async function importLocalConnection(
  context: vscode.ExtensionContext,
  provider: WorkbenchViewProvider,
): Promise<void> {
  const outcome = await importConnection({
    pickFile: async () => {
      const picked = await vscode.window.showOpenDialog({
        title: "Import MARS connection file",
        openLabel: "Import",
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { "MARS connection": ["json"] },
      });
      const uri = picked?.[0];
      return uri?.scheme === "file" ? uri.fsPath : undefined;
    },
    readFile: (fsPath) => readConnectionFile(fsPath),
    globalServerUrl: () =>
      vscode.workspace.getConfiguration("mars").inspect<string>("serverUrl")
        ?.globalValue,
    getToken: () => Promise.resolve(context.secrets.get(TOKEN_KEY)),
    storeToken: (token) =>
      Promise.resolve(context.secrets.store(TOKEN_KEY, token)),
    deleteToken: () => Promise.resolve(context.secrets.delete(TOKEN_KEY)),
    storeGlobalServerUrl: (url) =>
      Promise.resolve(
        vscode.workspace
          .getConfiguration("mars")
          .update("serverUrl", url, vscode.ConfigurationTarget.Global),
      ),
    confirm: async (message, detail, action) =>
      (await vscode.window.showWarningMessage(
        message,
        { modal: true, detail },
        action,
      )) === action,
    suspendConnections: () => provider.suspendConnections(),
  });
  if (outcome.status === "imported")
    void vscode.window.showInformationMessage(
      `MARS connection imported for ${outcome.url} (project ${outcome.scope.project_id}).`,
    );
  else if (outcome.status !== "cancelled")
    void vscode.window.showErrorMessage(outcome.reason);
}

async function promptForToken(context: vscode.ExtensionContext): Promise<void> {
  const token = await vscode.window.showInputBox({
    title: "MARS server token",
    prompt:
      "Paste your MARS server bearer token, or cancel and run 'MARS: Import local connection file' for a local `mars serve`. It is stored only in VS Code Secret Storage.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) =>
      /^[\x21-\x7e]{16,4096}$/.test(value)
        ? undefined
        : "Token must be 16-4096 visible ASCII characters.",
  });
  if (token) await context.secrets.store(TOKEN_KEY, token);
}

export function activate(context: vscode.ExtensionContext): void {
  const documents = new ReadonlyDocuments();
  const provider = new WorkbenchViewProvider(context, documents);
  const reconnect = () => void provider.active?.connect();
  context.subscriptions.push(
    provider,
    vscode.workspace.registerTextDocumentContentProvider(
      VIEW_SCHEME,
      documents,
    ),
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.commands.registerCommand("mars.connect", reconnect),
    vscode.commands.registerCommand("mars.setToken", async () => {
      await promptForToken(context);
    }),
    vscode.commands.registerCommand("mars.importConnection", () =>
      importLocalConnection(context, provider),
    ),
    vscode.commands.registerCommand("mars.clearToken", async () => {
      await context.secrets.delete(TOKEN_KEY);
    }),
    vscode.commands.registerCommand(
      "mars.refresh",
      () => void provider.active?.refresh(),
    ),
    vscode.commands.registerCommand("mars.newTask", async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      provider.post({ type: "focusNewTask" });
    }),
    vscode.commands.registerCommand("mars.cancelTask", () => {
      const controller = provider.active;
      const taskId = controller?.selectedTaskId;
      if (controller && taskId) void controller.cancel(taskId);
      else
        void vscode.window.showInformationMessage("Select a MARS task first.");
    }),
    context.secrets.onDidChange((event) => {
      if (event.key === TOKEN_KEY) reconnect();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mars")) reconnect();
    }),
  );
}

export function deactivate(): void {}
