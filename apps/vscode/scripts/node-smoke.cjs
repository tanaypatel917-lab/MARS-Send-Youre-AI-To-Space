// Loads the built extension in plain Node with a stub `vscode` module and
// checks that activation registers exactly the commands/view the manifest declares.
const Module = require("node:module");
const path = require("node:path");
const assert = require("node:assert/strict");

const manifest = require("../package.json");
const registered = { commands: [], views: [], schemes: [] };
const disposable = { dispose() {} };

function anything() {
  const fn = () => proxy;
  const proxy = new Proxy(fn, {
    get: (_target, key) =>
      key === "then" ? undefined : key === "dispose" ? () => {} : proxy,
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

const vscode = new Proxy(
  {
    commands: {
      registerCommand: (id) => {
        registered.commands.push(id);
        return disposable;
      },
      executeCommand: async () => undefined,
    },
    window: {
      registerWebviewViewProvider: (id) => {
        registered.views.push(id);
        return disposable;
      },
    },
    workspace: {
      registerTextDocumentContentProvider: (scheme) => {
        registered.schemes.push(scheme);
        return disposable;
      },
      onDidChangeConfiguration: () => disposable,
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      workspaceFolders: [],
    },
    Uri: anything(),
    EventEmitter: class {
      event = () => disposable;
      fire() {}
      dispose() {}
    },
  },
  { get: (target, key) => (key in target ? target[key] : anything()) },
);

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") return vscode;
  return load.call(this, request, ...rest);
};

const extension = require(path.join(__dirname, "..", "dist", "extension.js"));
const context = {
  subscriptions: [],
  extensionUri: anything(),
  secrets: {
    get: async () => undefined,
    store: async () => {},
    delete: async () => {},
    onDidChange: () => disposable,
  },
};
extension.activate(context);

const declared = manifest.contributes.commands
  .map((command) => command.command)
  .sort();
assert.deepEqual([...registered.commands].sort(), declared);
assert.deepEqual(
  registered.views,
  manifest.contributes.views.mars.map((view) => view.id),
);
assert.ok(context.subscriptions.length > 0);
console.log(
  `node smoke ok: ${registered.commands.length} commands, views ${registered.views.join(",")}`,
);
