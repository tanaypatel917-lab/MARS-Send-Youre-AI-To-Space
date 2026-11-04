import { describe, expect, test } from "bun:test";
import {
  communities,
  indexGraph,
  neighbours,
  paths,
  resolveNodes,
  summarize,
} from "../src/graph";
import {
  type KnowledgeGraphArtifact,
  KnowledgeGraphArtifactSchema,
} from "../src/schema";

export function fixtureArtifact(): KnowledgeGraphArtifact {
  const node = (
    id: string,
    label: string,
    community: number,
    file = "src/a.ts",
  ) => ({
    id,
    label,
    kind: "symbol" as const,
    source_file: file,
    source_location: "L1",
    community,
    callable: true,
  });
  const edge = (source: string, target: string, relation = "calls") => ({
    source,
    target,
    relation,
    confidence: "EXTRACTED" as const,
    source_file: "src/a.ts",
    source_location: "L1",
  });
  return KnowledgeGraphArtifactSchema.parse({
    schema_version: 1,
    producer: {
      name: "graphify",
      version: "0.9.101",
      wrapper: "@mars/knowledge-graph",
      wrapper_version: "0.0.1",
    },
    workspace: { workspace_id: "ws", revision: "rev1" },
    built_at: "2026-01-01T00:00:00.000Z",
    content_digest: "a".repeat(64),
    complete: true,
    nodes: [
      node("a::main", "main", 0),
      node("a::helper", "helper", 0),
      node("b::parse", "parse", 1, "src/b.py"),
      node("b::emit", "emit", 1, "src/b.py"),
      node("c::lonely", "lonely", 2, "src/c.ts"),
    ],
    edges: [
      edge("a::main", "a::helper"),
      edge("a::helper", "b::parse", "imports"),
      edge("b::parse", "b::emit"),
    ],
    communities: [
      {
        id: 0,
        label: "entry",
        cohesion: 0.5,
        members: ["a::main", "a::helper"],
      },
      { id: 1, label: null, cohesion: null, members: ["b::parse", "b::emit"] },
      { id: 2, label: null, cohesion: null, members: ["c::lonely"] },
    ],
    stats: {
      files: 3,
      nodes: 5,
      edges: 3,
      communities: 3,
      dropped_nodes: 0,
      dropped_edges: 0,
    },
  });
}

describe("graph queries", () => {
  const index = indexGraph(fixtureArtifact());

  test("resolves by id, label and path fragment deterministically", () => {
    expect(resolveNodes(index, "a::main").map((n) => n.id)).toEqual([
      "a::main",
    ]);
    expect(resolveNodes(index, "PARSE").map((n) => n.id)).toEqual(["b::parse"]);
    expect(resolveNodes(index, "b.py").map((n) => n.id)).toEqual([
      "b::emit",
      "b::parse",
    ]);
    expect(resolveNodes(index, "   ")).toEqual([]);
  });

  test("neighbours walk both directions with bounded depth and limit", () => {
    const start = index.nodes.get("a::helper");
    if (!start) throw new Error("missing");
    expect(
      neighbours(index, start).map((h) => `${h.node.id}@${h.distance}`),
    ).toEqual(["b::parse@1", "a::main@1"]);
    expect(
      neighbours(index, start, { depth: 99 }).map((h) => h.node.id),
    ).toEqual(["b::parse", "a::main", "b::emit"]);
    expect(neighbours(index, start, { depth: 2, limit: 1 })).toHaveLength(1);
  });

  test("paths are shortest first and respect the hop limit", () => {
    const from = index.nodes.get("a::main");
    const to = index.nodes.get("b::emit");
    if (!from || !to) throw new Error("missing");
    const found = paths(index, from, to);
    expect(found.map((p) => p.nodes.map((n) => n.label))).toEqual([
      ["main", "helper", "parse", "emit"],
    ]);
    expect(paths(index, from, to, { maxDepth: 2 })).toEqual([]);
    const lonely = index.nodes.get("c::lonely");
    if (!lonely) throw new Error("missing");
    expect(paths(index, from, lonely)).toEqual([]);
  });

  test("communities are listed largest first with bounded members", () => {
    const all = communities(index, { members: 1 });
    expect(all.map((c) => [c.community.id, c.size, c.members.length])).toEqual([
      [0, 2, 1],
      [1, 2, 1],
      [2, 1, 1],
    ]);
    expect(communities(index, { community: 7 })).toEqual([]);
  });

  test("summary is deterministic, budgeted and free of absolute paths", () => {
    const text = summarize(fixtureArtifact(), 10_000);
    expect(text).toBe(summarize(fixtureArtifact(), 10_000));
    expect(text).toContain("graphify 0.9.101 · workspace revision rev1");
    expect(text).toContain("- c0 entry [2]: helper, main");
    expect(text).toContain("Most connected:");
    expect(text).not.toMatch(/\/home\//);
    const short = summarize(fixtureArtifact(), 80);
    expect(short.length).toBeLessThanOrEqual(80);
    expect(short.endsWith("…truncated")).toBe(true);
  });
});

describe("artifact schema", () => {
  test("rejects absolute or escaping source paths", () => {
    const artifact = fixtureArtifact();
    for (const bad of ["/home/u/x.ts", "C:\\x.ts", "../x.ts"]) {
      const nodes = artifact.nodes.map((n, i) =>
        i === 0 ? { ...n, source_file: bad } : n,
      );
      expect(
        KnowledgeGraphArtifactSchema.safeParse({ ...artifact, nodes }).success,
      ).toBe(false);
    }
  });
});
