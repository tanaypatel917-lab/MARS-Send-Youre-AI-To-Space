import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDerivedArtifactStore } from "@mars/context";
import {
  createKnowledgeGraphService,
  type GraphBinding,
  type GraphBuildRecord,
  KNOWLEDGE_GRAPH_ARTIFACT_KIND,
  KnowledgeGraphArtifactSchema,
} from "../src";

const FAKE = join(import.meta.dir, "fake-graphify.ts");

async function fixture(scenario: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "mars-kg-"));
  const workspace = join(root, "ws");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "a.ts"), "export const a = 1;\n");
  const scenarioPath = join(root, "scenario.json");
  const log = join(root, "calls.log");
  await writeFile(scenarioPath, JSON.stringify(scenario));
  const dataRoot = join(root, "state", "knowledge-graph");
  const artifacts = createDerivedArtifactStore({
    rootDir: join(dataRoot, "artifacts"),
  });
  const records: GraphBuildRecord[] = [];
  const service = createKnowledgeGraphService({
    command: [process.execPath, FAKE],
    dataRoot,
    artifacts,
    timeoutMs: 2_000,
    doctorTtlMs: 0,
    env: {
      FAKE_GRAPHIFY_SCENARIO: scenarioPath,
      FAKE_GRAPHIFY_LOG: log,
      SECRET_TOKEN: "must-not-leak",
    },
    processEnv: {
      PATH: process.env.PATH,
      HOME: "/home/someone",
      OPENAI_API_KEY: "must-not-leak",
      SECRET_TOKEN: "must-not-leak",
    },
  });
  const binding: GraphBinding = {
    task_id: "task-1",
    owner_id: "owner",
    project_id: "project",
    workspace_id: "ws1",
    cwd: workspace,
    revision: "rev-1",
    approvals: { read: true },
    evidence: {
      async append(record) {
        records.push(record);
      },
    },
  };
  const calls = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            cwd: string;
            env: Record<string, string>;
          },
      );
  return {
    root,
    workspace,
    dataRoot,
    artifacts,
    service,
    binding,
    records,
    calls,
  };
}

function rawGraph(root: string) {
  const node = (
    id: string,
    label: string,
    file: string,
    community: number,
  ) => ({
    id,
    label,
    _callable: true,
    _origin: "ast",
    community,
    file_type: "code",
    norm_label: label.toLowerCase(),
    source_file: file,
    source_location: "L1",
  });
  return {
    directed: false,
    multigraph: false,
    graph: { schema_version: 1, graphify_version: "0.9.101" },
    nodes: [
      node("src/a.ts::main", "main", "src/a.ts", 0),
      node("src/a.ts::helper", "helper", "src/a.ts", 0),
      node("src/b.py::parse", "parse", join(root, "src/b.py"), 1),
      node("leak", "leak", "/etc/passwd", 1),
    ],
    links: [
      {
        source: "src/a.ts::main",
        target: "src/a.ts::helper",
        relation: "calls",
        confidence: "EXTRACTED",
        source_file: "src/a.ts",
        source_location: "L2",
        weight: 1,
      },
      {
        source: "src/a.ts::helper",
        target: "src/b.py::parse",
        relation: "imports",
        confidence: "weird",
        source_file: "src/a.ts",
      },
      {
        source: "src/a.ts::main",
        target: "leak",
        relation: "calls",
        confidence: "EXTRACTED",
      },
    ],
    hyperedges: [],
  };
}

const analysis = {
  communities: {
    "0": ["src/a.ts::main", "src/a.ts::helper"],
    "1": ["src/b.py::parse", "leak"],
  },
  cohesion: { "0": 0.75, "1": 0.5 },
  gods: [],
};

describe("knowledge graph service", () => {
  let f: Awaited<ReturnType<typeof fixture>>;

  beforeEach(async () => {
    f = await fixture({});
  });

  test("builds a normalised, deterministic artifact in a sandboxed subprocess", async () => {
    await writeFile(
      join(f.root, "scenario.json"),
      JSON.stringify({ graph: rawGraph(f.workspace), analysis }),
    );
    const first = await f.service.build(f.binding);
    expect(first.status).toBe("built");
    if (first.status !== "built") throw new Error("unreachable");
    expect(first.artifact.nodes.map((n) => n.id)).toEqual([
      "src/a.ts::helper",
      "src/a.ts::main",
      "src/b.py::parse",
    ]);
    expect(first.artifact.nodes[2]?.source_file).toBe("src/b.py");
    expect(first.artifact.stats).toEqual({
      files: 3,
      nodes: 3,
      edges: 2,
      communities: 2,
      dropped_nodes: 1,
      dropped_edges: 1,
    });
    expect(first.artifact.edges.map((e) => e.confidence)).toEqual([
      "AMBIGUOUS",
      "EXTRACTED",
    ]);
    expect(first.artifact.communities[1]).toEqual({
      id: 1,
      label: null,
      cohesion: 0.5,
      members: ["src/b.py::parse"],
    });
    expect(JSON.stringify(first.artifact)).not.toContain(f.workspace);

    const second = await f.service.build(f.binding);
    if (second.status !== "built") throw new Error("unreachable");
    expect(second.artifact.content_digest).toBe(first.artifact.content_digest);

    const stored = await f.artifacts.read(
      {
        owner_id: "owner",
        project_id: "project",
        workspace_id: "ws1",
        kind: KNOWLEDGE_GRAPH_ARTIFACT_KIND,
      },
      KnowledgeGraphArtifactSchema,
    );
    expect(stored?.revision).toBe("rev-1");
    expect(stored?.value.content_digest).toBe(first.artifact.content_digest);
    expect(f.records.map((r) => r.status)).toEqual(["built", "built"]);
    expect(f.records[0]?.isolation).toBe("process_env");
    expect(f.records[0]?.content_digest).toBe(first.artifact.content_digest);

    const calls = await f.calls();
    const extract = calls.find((call) => call.args[0] === "extract");
    if (!extract) throw new Error("extract was not invoked");
    expect(extract.args.slice(0, 4)).toEqual([
      "extract",
      f.workspace,
      "--code-only",
      "--out",
    ]);
    expect(extract.args[4]?.startsWith(f.dataRoot)).toBe(true);
    expect(extract.cwd).toBe(f.workspace);
    expect(extract.env.HOME?.startsWith(f.dataRoot)).toBe(true);
    expect(extract.env.GRAPHIFY_OUT?.startsWith(f.dataRoot)).toBe(true);
    expect(extract.env.HTTPS_PROXY).toBe("http://127.0.0.1:9");
    expect(extract.env.OPENAI_API_KEY).toBeUndefined();
    expect(extract.env.SECRET_TOKEN).toBeUndefined();
    expect(calls[0]?.args).toEqual(["--version"]);
  });

  test("reports unavailable when graphify is missing or not the pinned release", async () => {
    const missing = createKnowledgeGraphService({
      command: [join(f.root, "no-such-graphify")],
      dataRoot: f.dataRoot,
      artifacts: f.artifacts,
    });
    const outcome = await missing.build(f.binding);
    expect(outcome.status).toBe("unavailable");
    expect((await missing.doctor()).available).toBe(false);
    expect(f.records.at(-1)?.status).toBe("unavailable");

    await writeFile(
      join(f.root, "scenario.json"),
      JSON.stringify({ version: "0.9.0", graph: rawGraph(f.workspace) }),
    );
    const wrong = await f.service.build(f.binding);
    expect(wrong.status).toBe("unavailable");
    if (wrong.status === "built") throw new Error("unreachable");
    expect(wrong.reason).toContain("not the pinned 0.9.101");
    const text = await f.service.toolsFor(f.binding).build();
    expect(text).toContain("· mars_graph_build · unavailable ·");
    expect(text).toContain("Nothing was built or changed");
    expect(await f.service.lookup(f.binding)).toEqual({ status: "not_built" });
  });

  test("an empty graph, a missing graph.json, a crash or a timeout never count as success", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ graph: { nodes: [], links: [] } }, "empty graph"],
      [{}, "no graph.json"],
      [{ extract_exit: 3, extract_stderr: "boom" }, "exit 3"],
      [{ graph_text: "{not json" }, "no graph.json"],
      [{ hang_ms: 5_000, graph: rawGraph(f.workspace) }, "timed out"],
    ];
    for (const [scenario, expected] of cases) {
      await writeFile(join(f.root, "scenario.json"), JSON.stringify(scenario));
      const outcome = await f.service.build(f.binding);
      expect(outcome.status).toBe("failed");
      if (outcome.status === "built") throw new Error("unreachable");
      expect(`${outcome.reason} ${outcome.record.summary}`).toContain(expected);
      expect(await f.service.lookup(f.binding)).toEqual({
        status: "not_built",
      });
    }
    expect(f.records.every((r) => r.status === "failed")).toBe(true);
  });

  test("queries answer only for the current revision and render derived evidence", async () => {
    await writeFile(
      join(f.root, "scenario.json"),
      JSON.stringify({ graph: rawGraph(f.workspace), analysis }),
    );
    const tools = f.service.toolsFor(f.binding);
    expect(await tools.query({ kind: "communities" })).toContain(
      "· not_built ·",
    );
    expect(await tools.build()).toContain("· mars_graph_build · built ·");
    const near = await tools.query({ kind: "neighbours", node: "helper" });
    expect(near).toContain(
      "[derived evidence · code knowledge graph · mars_graph_query · neighbours · workspace revision rev-1]",
    );
    expect(near).toContain("main (src/a.ts:L1) c0");
    expect(near).toContain("parse (src/b.py:L1) c1 [AMBIGUOUS]");
    const route = await tools.query({
      kind: "paths",
      from: "main",
      to: "parse",
    });
    expect(route).toContain("- main → helper → parse (calls, imports)");
    const groups = await tools.query({ kind: "communities", community: 0 });
    expect(groups).toContain(
      "- c0 [2, cohesion 0.75]: helper (src/a.ts:L1) c0; main (src/a.ts:L1) c0",
    );
    const miss = await tools.query({ kind: "neighbours", node: "nope" });
    expect(miss).toContain("· mars_graph_query · error ·");
    expect(miss).toContain('no graph node matches node "nope"');
    expect(await tools.query({ kind: "paths", from: "main" })).toContain(
      "to is required",
    );

    const moved = f.service.toolsFor({ ...f.binding, revision: "rev-2" });
    const stale = await moved.query({ kind: "communities" });
    expect(stale).toContain("· stale ·");
    expect(stale).toContain("built for revision rev-1, not the current rev-2");
    expect(stale).not.toContain("c0");
  });

  test("a failed rebuild discards the earlier graph instead of leaving it queryable", async () => {
    await writeFile(
      join(f.root, "scenario.json"),
      JSON.stringify({ graph: rawGraph(f.workspace), analysis }),
    );
    expect((await f.service.build(f.binding)).status).toBe("built");
    expect((await f.service.lookup(f.binding)).status).toBe("ready");
    await writeFile(
      join(f.root, "scenario.json"),
      JSON.stringify({
        extract_exit: 3,
        extract_stderr: `Traceback: ${f.workspace}/src/a.ts failed; see ${f.dataRoot}/tasks/x/out and /etc/hosts`,
      }),
    );
    const outcome = await f.service.build(f.binding);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "built") throw new Error("unreachable");
    expect(outcome.reason).not.toContain(f.workspace);
    expect(outcome.reason).not.toContain(f.dataRoot);
    expect(outcome.reason).not.toContain("/etc/hosts");
    expect(outcome.reason).toContain("<private>/src/a.ts");
    expect(outcome.record.summary).not.toContain(f.root);
    expect(outcome.record.limitations).toContain(
      "previous graph for this workspace discarded",
    );
    expect(await f.service.lookup(f.binding)).toEqual({ status: "not_built" });
    const text = await f.service
      .toolsFor(f.binding)
      .query({ kind: "communities" });
    expect(text).toContain("· not_built ·");

    // unavailable (wrong version) leaves an existing graph alone and says so
    await writeFile(
      join(f.root, "scenario.json"),
      JSON.stringify({ graph: rawGraph(f.workspace), analysis }),
    );
    expect((await f.service.build(f.binding)).status).toBe("built");
    await writeFile(
      join(f.root, "scenario.json"),
      JSON.stringify({ version: "0.9.0" }),
    );
    const unavailable = await f.service.toolsFor(f.binding).build();
    expect(unavailable).toContain("· unavailable ·");
    expect(unavailable).toContain("stays as it was");
    expect((await f.service.lookup(f.binding)).status).toBe("ready");
  });

  test("builds and queries follow the workspace's current revision, not the binding-time one", async () => {
    await writeFile(
      join(f.root, "scenario.json"),
      JSON.stringify({ graph: rawGraph(f.workspace), analysis }),
    );
    let revision = "rev-5";
    const binding: GraphBinding = {
      ...f.binding,
      revision: "rev-1",
      currentRevision: async () => revision,
    };
    const built = await f.service.build(binding);
    if (built.status !== "built") throw new Error(built.reason);
    expect(built.artifact.workspace.revision).toBe("rev-5");
    expect(built.record.revision).toBe("rev-5");
    const tools = f.service.toolsFor(binding);
    expect(await tools.query({ kind: "communities" })).toContain(
      "· communities · workspace revision rev-5]",
    );
    revision = "rev-6";
    const stale = await tools.query({ kind: "communities" });
    expect(stale).toContain("· stale · workspace revision rev-6]");
    expect(stale).toContain("built for revision rev-5, not the current rev-6");

    // a write that lands during extraction fences the build
    let calls = 0;
    const racing: GraphBinding = {
      ...binding,
      currentRevision: async () => `rev-${7 + calls++}`,
    };
    const raced = await f.service.build(racing);
    expect(raced.status).toBe("failed");
    if (raced.status === "built") throw new Error("unreachable");
    expect(raced.reason).toContain("workspace changed during extraction");
    expect(await f.service.lookup(binding)).toEqual({ status: "not_built" });
  });

  test("queries are refused without read approval", async () => {
    await writeFile(
      join(f.root, "scenario.json"),
      JSON.stringify({ graph: rawGraph(f.workspace), analysis }),
    );
    expect((await f.service.build(f.binding)).status).toBe("built");
    const denied = f.service.toolsFor({
      ...f.binding,
      approvals: { read: false },
    });
    const text = await denied.query({ kind: "communities" });
    expect(text).toContain("· refused ·");
    expect(text).toContain("read approval is required");
    expect(text).not.toContain("c0");
    expect(await denied.build()).toContain("· refused ·");
  });

  test("refuses to build without read approval", async () => {
    const outcome = await f.service.build({
      ...f.binding,
      approvals: { read: false },
    });
    expect(outcome.status).toBe("refused");
    expect(await f.calls()).toEqual([]);
  });
});
