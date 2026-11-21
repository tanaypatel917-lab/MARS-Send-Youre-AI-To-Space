import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDerivedArtifactStore } from "@mars/context";
import { createKnowledgeGraphService } from "../src/index";

const GRAPHIFY_BIN = process.env.MARS_GRAPHIFY_BIN?.trim();
const REPO_MEMORY_DIR = resolve(import.meta.dir, "../../memory");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!GRAPHIFY_BIN)("real graphifyy==0.9.101 integration", () => {
  test("doctor, build, normalize, and query (communities, neighbours, paths, stale) through the real CLI wrapper", async () => {
    const base = await mkdtemp(join(tmpdir(), "mars-real-kg-"));
    dirs.push(base);

    const artifacts = createDerivedArtifactStore({
      rootDir: join(base, "artifacts"),
    });
    const kg = createKnowledgeGraphService({
      command: [GRAPHIFY_BIN as string],
      dataRoot: join(base, "kg-data"),
      artifacts,
    });

    const doctor = await kg.doctor();
    expect(doctor.available).toBe(true);
    expect(doctor.version).toBe("0.9.101");
    expect(doctor.reason).toBeNull();

    let revision = "rev-1";
    const binding = {
      task_id: "real-graphify-task",
      owner_id: "local",
      project_id: "mars-test",
      workspace_id: "ws-memory",
      cwd: REPO_MEMORY_DIR,
      revision,
      currentRevision: async () => revision,
      approvals: { read: true },
    };

    const built = await kg.build(binding);
    expect(built.status).toBe("built");
    if (built.status !== "built") return;

    expect(built.artifact.producer.version).toBe("0.9.101");
    expect(built.artifact.stats.nodes).toBeGreaterThan(20);
    expect(built.artifact.stats.edges).toBeGreaterThan(20);
    expect(built.artifact.stats.communities).toBeGreaterThan(0);

    // Zero host-path leakage (raw or slugified) across every node and community.
    const serialized = JSON.stringify(built.artifact);
    expect(serialized).not.toContain(REPO_MEMORY_DIR);
    expect(serialized).not.toContain(base);
    const rootSlug = REPO_MEMORY_DIR.toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    expect(serialized.toLowerCase()).not.toContain(rootSlug);

    // Tool wrappers: mars_graph_build and mars_graph_query
    const tools = kg.toolsFor(binding);
    const buildOutput = await tools.build();
    expect(buildOutput).toContain("mars_graph_build · built");
    expect(buildOutput).toContain("graphify 0.9.101");

    const communities = await tools.query({ kind: "communities", limit: 5 });
    expect(communities).toContain("mars_graph_query · communities");
    expect(communities).toContain("DurableMemoryStore");

    const neighbours = await tools.query({
      kind: "neighbours",
      node: "DurableMemoryStore",
      depth: 1,
      limit: 10,
    });
    expect(neighbours).toContain("mars_graph_query · neighbours");
    expect(neighbours).toContain("DurableMemoryStore");
    expect(neighbours).not.toContain("(no neighbours)");

    const paths = await tools.query({
      kind: "paths",
      from: "DurableMemoryStore",
      to: "scanThreat",
      max_depth: 4,
      limit: 3,
    });
    expect(paths).toContain("mars_graph_query · paths");
    expect(paths).not.toContain("(no path within the hop limit)");
    expect(paths).toMatch(/^- DurableMemoryStore → .+ → scanThreat\(\)/m);

    // Stale revision fencing: advancing revision must refuse stale answers.
    revision = "rev-2";
    const stale = await tools.query({ kind: "communities" });
    expect(stale).toContain("mars_graph_query · stale");
    expect(stale).toContain("No stale answer is given");
  }, 60_000);
});
