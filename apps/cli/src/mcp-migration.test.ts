import { afterEach, expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHmacApprovalAuthorizer,
  createIntegrationTrust,
  type SourceEvidence,
  signApproval,
} from "@mars/integration-trust";
import {
  createHostMcpControlPlane,
  defaultRequestContext,
  type StdioTransportConfig,
} from "@mars/mcp-client";
import { openRuntimeMcp, runMcp } from "./mcp";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const tool = { name: "check", inputSchema: { type: "object", properties: {} } };
function server(expression: string, startupCheck = "") {
  return `#!/usr/bin/env node
${startupCheck}
require("node:readline").createInterface({input:process.stdin}).on("line", line=>{
const {method,id}=JSON.parse(line); if(id===undefined)return;
const result=method==="initialize"?{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}:
method==="tools/list"?{tools:[${JSON.stringify(tool)}]}:{content:[{type:"text",text:${expression}}]};
console.log(JSON.stringify({jsonrpc:"2.0",id,result}));});`;
}
const ctx = defaultRequestContext("owner", "project");
async function oldGrant(stateDir: string, transport: StdioTransportConfig) {
  const cp = await createHostMcpControlPlane({
    stateDir,
    scope: ctx.scope,
    workspaceRoots: [],
  });
  const config = {
    schema_version: 1 as const,
    id: "demo",
    transport,
    registered_at: new Date().toISOString(),
    permissions: [{ capability: "tool.invoke" as const, resource: "check" }],
    credential_bindings: [],
  };
  await cp.registry.upsert(config);
  // A persisted, signed grant in the pre-layout format. Migration must not rely on digest heuristics.
  const hash = "1".repeat(64);
  const evidence: SourceEvidence = {
    schema_version: 1,
    kind: "mcp",
    integration_id: "demo",
    source: {
      type: "local-artifact",
      locator: transport.command,
      revision: hash.slice(0, 40),
      content_sha256: hash,
    },
    config_sha256: hash,
    dependency_sha256: hash,
    endpoint: null,
    tools: [
      { name: "check", input_schema_sha256: hash, output_schema_sha256: null },
    ],
    observed_at: new Date().toISOString(),
  };
  const key = randomBytes(32);
  const { admin } = createIntegrationTrust({
    store: cp.store,
    authorizer: createHmacApprovalAuthorizer({
      key,
      approvers: [
        { approver_id: "owner", owner_id: "owner", project_ids: ["project"] },
      ],
    }),
    probe: {
      async observe() {
        return evidence;
      },
    },
  });
  const review = await admin.submitCandidate(ctx, {
    evidence,
    permissions: config.permissions,
    credential_bindings: [],
  });
  await admin.approve(ctx, {
    review_id: review.review_id,
    expected_revision: review.revision,
    proof: signApproval(
      key,
      {
        review_id: review.review_id,
        review_revision: review.revision,
        binding_sha256: review.binding_sha256,
        scope: ctx.scope,
        decision: "approve",
        expires_at: review.expires_at,
      },
      "owner",
      randomUUID(),
    ),
  });
  return cp;
}

for (const scenario of [
  "sibling imports",
  "venv Python",
  "offline npx",
  "writable database",
] as const) {
  test(`re-approves and calls a real server: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-migrate-"));
    roots.push(root);
    const cwd = join(root, "program"),
      state = join(root, "state");
    await mkdir(cwd);
    const transport: StdioTransportConfig = {
      type: "stdio",
      command: process.execPath,
      args: ["server.cjs"],
      cwd,
      env_allowlist: [],
      entrypoint: "server.cjs",
    };
    let answers = ["", "program", cwd, "no", "yes"];
    let expected = "sibling-ok";
    switch (scenario) {
      case "sibling imports":
        await writeFile(
          join(cwd, "server.cjs"),
          // Both descriptor discovery and invocation must run the private command and script.
          server(
            'require("./sibling.cjs")',
            'if (![__filename, process.execPath].every(p=>p.includes("/packages-v1/"))) process.exit(1);',
          ),
        );
        // A literal should not turn into a filename.
        transport.args.push("stdio");
        answers.splice(3, 0, "text");
        await writeFile(join(cwd, "stdio"), "");
        await writeFile(
          join(cwd, "sibling.cjs"),
          'module.exports=process.argv[2]==="stdio"?"sibling-ok":"wrong argument"',
        );
        break;
      case "writable database":
        transport.args.push("user.sqlite");
        answers.splice(3, 0, "data");
        answers[4] = "yes"; // The working folder is private but the database must not move.
        expected = "saved";
        await writeFile(
          join(cwd, "server.cjs"),
          server(
            '(()=>{const db=new (require("bun:sqlite").Database)(process.argv[2]);db.exec("create table if not exists notes(body); insert into notes values (1)");db.close();return "saved"})()',
          ),
        );
        break;
      case "venv Python": {
        const venv = join(root, "env");
        const setup = Bun.spawnSync([
          "python3",
          "-m",
          "venv",
          "--without-pip",
          venv,
        ]);
        expect(setup.exitCode).toBe(0);
        transport.command = join(venv, "bin", "python");
        const site = Bun.spawnSync([
          transport.command,
          "-c",
          "import sysconfig;print(sysconfig.get_path('purelib'))",
        ])
          .stdout.toString()
          .trim();
        await writeFile(join(site, "mars_fixture.py"), 'value="venv-ok"');
        transport.entrypoint = "server.py";
        transport.args = ["server.py"];
        expected = "venv-ok";
        await writeFile(
          join(cwd, "server.py"),
          `import sys,json,mars_fixture
for line in sys.stdin:
 r=json.loads(line)
 if "id" not in r: continue
 result={"initialize":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"venv","version":"1"}},"tools/list":{"tools":[${JSON.stringify(tool)}]},"tools/call":{"content":[{"type":"text","text":mars_fixture.value if sys.prefix!=sys.base_prefix and "packages-v1" in sys.prefix else "wrong prefix"}]}}[r["method"]]
 print(json.dumps({"jsonrpc":"2.0","id":r["id"],"result":result}),flush=True)`,
        );
        break;
      }
      case "offline npx": {
        transport.command = "npx";
        transport.args = ["--offline", "--no-install", "mars-fixture"];
        delete transport.entrypoint;
        answers = ["", "text", "text", "text", "yes", "yes"];
        expected = "local-package-ok";
        const modules = join(cwd, "node_modules"),
          pkg = join(modules, "mars-fixture");
        await mkdir(pkg, { recursive: true });
        await mkdir(join(modules, ".bin"));
        await writeFile(
          join(cwd, "package.json"),
          '{"name":"host","version":"1.0.0","dependencies":{"mars-fixture":"1.0.0"}}',
        );
        await writeFile(
          join(pkg, "package.json"),
          '{"name":"mars-fixture","version":"1.0.0","bin":{"mars-fixture":"server.cjs"}}',
        );
        await writeFile(
          join(pkg, "server.cjs"),
          server(
            '__filename.includes("packages-v1")?"local-package-ok":"wrong package"',
          ),
          { mode: 0o700 },
        );
        await symlink(
          "../mars-fixture/server.cjs",
          join(modules, ".bin", "mars-fixture"),
        );
        break;
      }
    }
    const cp = await oldGrant(state, transport);
    const flags = [
      "--state-dir",
      state,
      "--owner",
      "owner",
      "--project",
      "project",
    ];
    const run = async (args: string[], inputs?: string[]) => {
      const lines: string[] = [];
      await runMcp([...args, ...flags], {
        workspaceRoots: [],
        stdout: (s) => lines.push(s),
        ask: async () => {
          const a = inputs?.shift();
          if (a === undefined) throw new Error("Unexpected prompt");
          return a;
        },
      });
      return lines.join("\n");
    };
    await expect(cp.loader.admitServer(ctx, "demo")).rejects.toThrow(
      "mars mcp reapprove demo",
    );
    expect(await run(["list"])).toContain("is paused");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 2; i++)
        await (await openRuntimeMcp(state, [], ctx.scope)).listServerIds();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    const before = (await cp.readState()).state.reviews.length;
    await expect(
      run(["reapprove", "demo"], [...answers.slice(0, -1), "no"]),
    ).rejects.toThrow("remains paused");
    expect((await cp.readState()).state.reviews).toHaveLength(before);
    const migration = await run(["reapprove", "demo"], answers);
    expect(answers).toHaveLength(0);
    let reviewId = /mars mcp approve ([a-z0-9-]+)/.exec(migration)?.[1];
    if (!reviewId) throw new Error(migration);
    expect(await run(["reapprove", "demo"])).toContain(reviewId);
    expect((await cp.readState()).state.reviews).toHaveLength(before + 1);
    if (scenario === "sibling imports") {
      const loaded = await cp.store.load();
      const pending = loaded.state.reviews.find(
        (r) => r.review_id === reviewId,
      );
      if (!pending) throw new Error("Missing migration review");
      pending.expires_at = new Date(0).toISOString();
      await cp.store.commit(loaded.revision, loaded.state, []);
      await expect(run(["approve", reviewId])).rejects.toThrow(
        "approval_invalid",
      );
      await expect(run(["reapprove", "demo"], ["no"])).rejects.toThrow(
        "remains paused",
      );
      const refreshed = await run(["reapprove", "demo"], ["yes"]);
      expect(refreshed).toContain("file choices are saved");
      expect(refreshed).not.toContain(reviewId);
      reviewId = /mars mcp approve ([a-z0-9-]+)/.exec(refreshed)?.[1];
      if (!reviewId) throw new Error(refreshed);
    }
    if (scenario === "writable database") {
      await writeFile(join(cwd, "new-module.cjs"), "module.exports = 1;");
      await expect(run(["approve", reviewId])).rejects.toThrow("drift");
      const refreshed = await run(["reapprove", "demo"], ["yes"]);
      expect(refreshed).toContain("changed before approval");
      expect(refreshed).not.toContain(reviewId);
      reviewId = /mars mcp approve ([a-z0-9-]+)/.exec(refreshed)?.[1];
      if (!reviewId) throw new Error(refreshed);
    }
    await run(["approve", reviewId]);
    expect(await run(["list"])).not.toContain("is paused");
    expect(await run(["reapprove", "demo"])).toContain(
      "already uses protected",
    );
    try {
      const output = await cp.loader.invokeTool(ctx, {
        server_id: "demo",
        tool: "check",
        input: {},
      });
      expect(output.content[0]?.text).toBe(expected);
      if (scenario === "writable database")
        expect(
          (await readFile(join(cwd, "user.sqlite"))).subarray(0, 15).toString(),
        ).toBe("SQLite format 3");
    } finally {
      await cp.loader.closeAll();
    }
  }, 60000);
}
