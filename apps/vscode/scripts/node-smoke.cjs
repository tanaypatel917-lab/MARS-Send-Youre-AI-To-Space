// Loads the built extension in plain Node with a stub `vscode` module and
// checks that activation registers exactly the commands/views the manifest
// declares: with every flag off only unconditional views, with
// `mars.teamChat.enabled` on also the `when`-guarded Team Chat view.
const Module = require("node:module");
const path = require("node:path");
const assert = require("node:assert/strict");

const manifest = require("../package.json");
let registered = { commands: [], views: [], schemes: [] };
let config = {};
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
      getConfiguration: () => ({
        get: (key, fallback) => (key in config ? config[key] : fallback),
      }),
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

function activate(flags) {
  registered = { commands: [], views: [], schemes: [] };
  config = flags;
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
  assert.ok(context.subscriptions.length > 0);
  return registered;
}

const declared = manifest.contributes.commands
  .map((command) => command.command)
  .sort();
const views = manifest.contributes.views.mars;
const unconditional = views.filter((view) => !view.when).map((view) => view.id);
const all = views.map((view) => view.id);
assert.ok(all.includes("mars.teamChat"));
assert.ok(!unconditional.includes("mars.teamChat"));

const off = activate({});
assert.deepEqual([...off.commands].sort(), declared);
assert.deepEqual(off.views, unconditional);

const on = activate({ "teamChat.enabled": true });
assert.deepEqual([...on.commands].sort(), declared);
assert.deepEqual(on.views, all);

console.log(
  `node smoke ok: ${off.commands.length} commands, views off=${off.views.join(",")} on=${on.views.join(",")}`,
);
