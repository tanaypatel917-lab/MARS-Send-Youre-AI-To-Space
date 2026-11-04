import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RequestContext } from "@mars/contracts";
import { createMemoryStore } from "@mars/memory";
import { SkillStore } from "@mars/skills";

const entrypoint = resolve(import.meta.dir, "main.ts");
const ctx: RequestContext = {
  schema_version: 1,
  scope: { owner_id: "local", project_id: "demo" },
  request_id: "vault-cli-seed",
};

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, entrypoint, "vault", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exit };
}

async function seed(state: string) {
  const memory = createMemoryStore({ rootDir: join(state, "memory") });
  await memory.batch(ctx, 0, [
    {
      operation: "add",
      entry: {
        entry_id: "fact-1",
        scope: ctx.scope,
        target: "project",
        fact: "Releases ship from the release branch.",
        revision: 0,
        source_event_ids: ["event-1"],
        observed_at: "2026-01-01T00:00:00.000Z",
        verified_at: null,
        supersedes: null,
        deleted: false,
      },
    },
  ]);
  await memory.close();
  const skills = new SkillStore(join(state, "skills"));
  await skills.create(
    "release",
    "---\nname: release\ndescription: Release checklist\n---\n\n# Release\n\n1. Tag.\n",
    { actor: "seed", source: "test" },
  );
}

test("mars vault export/status/import run against a temp state dir and only create proposals", async () => {
  const root = mkdtempSync(join(tmpdir(), "mars-vault-cli-"));
  const state = join(root, "state");
  const vault = join(root, "vault");
  try {
    await seed(state);
    const base = ["--state", state, "--vault", vault, "--project", "demo"];

    const missing = await run(["status", ...base]);
    expect(missing.exit).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("manifest");

    const exported = await run(["export", ...base, "--json"]);
    expect(exported.stderr).toBe("");
    expect(exported.exit).toBe(0);
    const exportReport = JSON.parse(exported.stdout);
    expect(exportReport.notes).toEqual({
      memory_fact: 1,
      project: 1,
      skill: 1,
    });
    expect(readFileSync(join(vault, "facts/fact-1.md"), "utf8")).toContain(
      "mars_kind: memory_fact",
    );
    expect(readFileSync(join(vault, "skills/release.md"), "utf8")).toContain(
      "<!-- mars:body -->",
    );

    const human = await run(["status", ...base]);
    expect(human.exit).toBe(0);
    expect(human.stdout).toContain("memory: exported revision 1, current 1");
    expect(human.stdout).toContain("unchanged 1");

    const factPath = join(vault, "facts/fact-1.md");
    writeFileSync(
      factPath,
      readFileSync(factPath, "utf8").replace("release branch", "main branch"),
    );
    const imported = await run(["import", ...base, "--json"]);
    expect(imported.stderr).toBe("");
    expect(imported.exit).toBe(0);
    const importReport = JSON.parse(imported.stdout);
    expect(importReport.summary).toEqual({ unchanged: 2, proposed: 1 });
    expect(importReport.proposals.memory).toHaveLength(1);

    const memory = createMemoryStore({ rootDir: join(state, "memory") });
    const snapshot = await memory.snapshot(ctx);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.entries[0]?.fact).toBe(
      "Releases ship from the release branch.",
    );
    const pending = await memory.listProposals(ctx, "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.source).toBe("memory-vault");
    await memory.close();

    const status = await run(["status", ...base, "--json"]);
    expect(status.exit).toBe(0);
    const statusReport = JSON.parse(status.stdout);
    expect(statusReport.memory.pending_vault_proposals).toBe(1);
    expect(statusReport.memory.notes.modified).toBe(1);

    const inside = await run([
      "export",
      "--state",
      state,
      "--vault",
      join(state, "vault"),
      "--project",
      "demo",
    ]);
    expect(inside.exit).toBe(1);
    expect(inside.stderr).toContain("private");

    if (process.platform !== "win32") {
      mkdirSync(join(root, "src"));
      symlinkSync(join(root, "src"), join(root, "link"));
      const linked = await run([
        "export",
        "--state",
        state,
        "--vault",
        join(root, "vault-linked"),
        "--source",
        join(root, "link"),
        "--json",
      ]);
      expect(linked.exit).toBe(0);
      const real = realpathSync(join(root, "src"));
      expect(JSON.parse(linked.stdout).scope.project_id).toBe(
        `project-${createHash("sha256").update(real).digest("hex").slice(0, 24)}`,
      );
    }

    const usage = await run(["bogus"]);
    expect(usage.exit).toBe(1);
    expect(usage.stderr).toContain("Usage: mars vault");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("--graph accepts a bare artifact or the derived-store envelope and rejects anything else", async () => {
  const { readGraphArtifactFile } = await import("./vault");
  const dir = mkdtempSync(join(tmpdir(), "mars-vault-graph-"));
  const artifact = {
    schema_version: 1,
    producer: {
      name: "graphify",
      version: "0.9.101",
      wrapper: "@mars/knowledge-graph",
      wrapper_version: "0.0.1",
    },
    workspace: { workspace_id: "ws", revision: "r1" },
    built_at: "2026-01-01T00:00:00.000Z",
    content_digest: "a".repeat(64),
    complete: true,
    nodes: [
      {
        id: "src/a.ts::main",
        label: "main",
        kind: "symbol",
        source_file: "src/a.ts",
        source_location: "L1",
        community: 0,
        callable: true,
      },
    ],
    edges: [],
    communities: [
      { id: 0, label: null, cohesion: null, members: ["src/a.ts::main"] },
    ],
    stats: {
      files: 1,
      nodes: 1,
      edges: 0,
      communities: 1,
      dropped_nodes: 0,
      dropped_edges: 0,
    },
  };
  const bare = join(dir, "bare.json");
  writeFileSync(bare, JSON.stringify(artifact));
  const envelope = join(dir, "knowledge-graph.abc.json");
  writeFileSync(
    envelope,
    JSON.stringify({
      schema_version: 1,
      key: {
        owner_id: "o",
        project_id: "p",
        workspace_id: "ws",
        kind: "knowledge-graph",
      },
      revision: "r1",
      stored_at: "2026-01-01T00:00:00.000Z",
      value: artifact,
    }),
  );
  const other = join(dir, "other.json");
  writeFileSync(
    other,
    JSON.stringify({ key: { kind: "other" }, value: artifact }),
  );
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{not json");
  expect((await readGraphArtifactFile(bare)).workspace.revision).toBe("r1");
  expect((await readGraphArtifactFile(envelope)).content_digest).toBe(
    "a".repeat(64),
  );
  await expect(readGraphArtifactFile(other)).rejects.toThrow("does not match");
  await expect(readGraphArtifactFile(broken)).rejects.toThrow("not valid JSON");
  await expect(
    readGraphArtifactFile(join(dir, "missing.json")),
  ).rejects.toThrow("Cannot read");
});
