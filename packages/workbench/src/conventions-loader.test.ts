import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkbenchConventions } from "./conventions-loader";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function checkout() {
  const root = await mkdtemp(join(tmpdir(), "mars-conventions-"));
  roots.push(root);
  await mkdir(join(root, "skills", "release-notes"), { recursive: true });
  await writeFile(
    join(root, "skills", "release-notes", "SKILL.md"),
    "---\nname: release-notes\ndescription: Write release notes\n---\nList user-facing changes.\n",
  );
  await mkdir(join(root, ".claude", "commands"), { recursive: true });
  await writeFile(
    join(root, ".claude", "commands", "review.md"),
    "---\ndescription: Review a file\n---\nReview $ARGUMENTS for defects.\n",
  );
  await mkdir(join(root, ".mars"), { recursive: true });
  await writeFile(
    join(root, ".mars", "hooks.json"),
    JSON.stringify({
      schema_version: 1,
      hooks: {
        "post-tool": [
          { matcher: "mars_write", command: ["bun", "run", "lint", "{path}"] },
        ],
      },
    }),
  );
  await writeFile(join(root, "AGENTS.md"), "Run bun run check.\n");
  return root;
}

test("an untrusted checkout yields skills and commands but no hooks or instruction files", async () => {
  const root = await checkout();
  const report = await loadWorkbenchConventions({
    sourceRoot: root,
    trustProject: false,
    discoverInstructions: async () => {
      throw new Error("must not be called for an untrusted checkout");
    },
  });
  expect(report.summary).toEqual({
    trusted: false,
    instruction_files: [],
    skills: 1,
    hooks: 0,
    commands: ["review"],
    apply_patch: false,
  });
  expect(report.conventions.hooks).toBeUndefined();
  expect(report.conventions.instructions).toBeUndefined();
  expect(report.conventions.applyPatch).toBeUndefined();
  expect(
    report.conventions.commands?.expand("/review src/app.ts")?.prompt,
  ).toBe("Review src/app.ts for defects.");
  expect(report.conventions.commands?.expand("/unknown")).toBeNull();
  expect(report.conventions.repositorySkills?.map((s) => s.name)).toEqual([
    "release-notes",
  ]);
});

test("a trusted checkout also loads hooks and instruction files, and hooks only describe commands", async () => {
  const root = await checkout();
  const applyPatch = async () => ({
    ok: true as const,
    applied: { added: [], modified: [], deleted: [] },
    summary: "Success. Updated the following files:",
  });
  const report = await loadWorkbenchConventions({
    sourceRoot: root,
    trustProject: true,
    applyPatch,
    discoverInstructions: async (discoveredRoot) => {
      expect(discoveredRoot).toBe(root);
      return {
        files: [
          {
            path: "AGENTS.md",
            kind: "AGENTS.md",
            bytes: 19,
            truncated: false,
            text: "Run bun run check.\n",
          },
        ],
        total_bytes: 19,
        omitted: 0,
        text: "Repository instructions:\nRun bun run check.",
        sha256: "0".repeat(64),
      };
    },
  });
  expect(report.summary).toEqual({
    trusted: true,
    instruction_files: ["AGENTS.md"],
    skills: 1,
    hooks: 1,
    commands: ["review"],
    apply_patch: true,
  });
  const executed: string[][] = [];
  const results = await report.conventions.hooks!.run(
    "post-tool",
    { tool: "mars_write", path: "src/a.ts" },
    async (argv) => {
      executed.push(argv);
      return { exit_code: 0, stdout: "", stderr: "" };
    },
  );
  expect(executed).toEqual([["bun", "run", "lint", "src/a.ts"]]);
  expect(results.map((r) => r.outcome)).toEqual(["ran"]);
  expect(
    await report.conventions.hooks!.run(
      "pre-tool",
      { tool: "mars_read" },
      async () => {
        throw new Error("no pre-tool hooks are registered");
      },
    ),
  ).toEqual([]);
});
