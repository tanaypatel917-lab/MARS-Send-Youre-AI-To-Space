import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CommandError,
  CommandRegistry,
  expandCommand,
  findUnsupported,
  loadCommands,
  MAX_COMMAND_BODY_BYTES,
  MAX_COMMANDS,
  parseSlashInput,
  substitutePlaceholders,
} from "./index";

const FIXTURES = resolve(import.meta.dir, "../test/fixtures/commands");

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mars-commands-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadCommands", () => {
  it("loads .mars and .claude commands with namespacing, shadowing and skips", async () => {
    const registry = await loadCommands(join(FIXTURES, "basic"));
    expect(registry.list().map((c) => [c.name, c.source, c.path])).toEqual([
      ["review", ".mars/commands", ".mars/commands/review.md"],
      ["status", ".mars/commands", ".mars/commands/status.md"],
      [
        "frontend:component",
        ".claude/commands",
        ".claude/commands/frontend/component.md",
      ],
      ["optimize", ".claude/commands", ".claude/commands/optimize.md"],
    ]);
    expect(registry.shadowed).toEqual([
      {
        name: "review",
        path: ".claude/commands/review.md",
        shadowed_by: ".mars/commands/review.md",
      },
    ]);
    expect(registry.skipped).toEqual([
      { path: ".claude/commands/Bad Name.md", reason: "invalid-name" },
    ]);
    const review = registry.get("review");
    expect(review?.description).toBe("Review a file for bugs");
    expect(review?.argument_hint).toBe("<path> [focus]");
    expect(review?.frontmatter).toEqual({
      description: "Review a file for bugs",
      "argument-hint": "<path> [focus]",
      "allowed-tools": "Read, Grep",
    });
    expect(review?.body).toBe(
      "Review $1 for bugs. Focus: $2.\n\nFull arguments: $ARGUMENTS\n",
    );
    expect(review?.unsupported).toEqual([]);
    const status = registry.get("status");
    expect(status?.description).toBeUndefined();
    expect(status?.frontmatter).toEqual({});
    expect(status?.unsupported).toEqual([
      "shell inclusion is not executed: !`git log --oneline -5`",
      "shell inclusion is not executed: !`git diff HEAD`",
    ]);
    expect(status?.body).toContain("!`git log --oneline -5`");
    expect(status?.body).toContain("@README.md");
    expect(registry.get("deep:nested:ignored")).toBeUndefined();
    expect(registry.get("notes")).toBeUndefined();
    expect(registry.size).toBe(4);
  });

  it("is deterministic and returns copies", async () => {
    const a = await loadCommands(join(FIXTURES, "basic"));
    const b = await loadCommands(join(FIXTURES, "basic"));
    expect(b.list()).toEqual(a.list());
    a.get("review")?.unsupported.push("mutated");
    expect(a.get("review")?.unsupported).toEqual([]);
  });

  it("returns an empty registry without convention folders", async () => {
    const registry = await loadCommands(root);
    expect(registry.list()).toEqual([]);
    expect(registry.shadowed).toEqual([]);
    expect(registry.skipped).toEqual([]);
  });

  it("skips symlinks, oversize bodies, bad frontmatter and non-UTF-8 files", async () => {
    const dir = join(root, ".mars", "commands");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "ok.md"), "Body\n");
    await symlink(join(dir, "ok.md"), join(dir, "link.md"));
    await writeFile(
      join(dir, "big.md"),
      "x".repeat(MAX_COMMAND_BODY_BYTES + 1),
    );
    await writeFile(join(dir, "bad.md"), "---\nname: [flow]\n---\nBody\n");
    await writeFile(join(dir, "bin.md"), Buffer.from([0xff, 0xfe, 0x00]));
    await writeFile(join(dir, "dashes.md"), "---\nno fence end\n");
    const registry = await loadCommands(root);
    expect(registry.list().map((c) => c.name)).toEqual(["ok"]);
    expect(registry.skipped).toEqual([
      { path: ".mars/commands/bad.md", reason: "frontmatter" },
      { path: ".mars/commands/big.md", reason: "oversize" },
      { path: ".mars/commands/bin.md", reason: "encoding" },
      { path: ".mars/commands/dashes.md", reason: "frontmatter" },
      { path: ".mars/commands/link.md", reason: "symlink" },
    ]);
  });

  it("caps the number of commands", async () => {
    const dir = join(root, ".claude", "commands");
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < MAX_COMMANDS + 2; i += 1)
      await writeFile(
        join(dir, `c${String(i).padStart(3, "0")}.md`),
        `Body ${i}\n`,
      );
    const registry = await loadCommands(root);
    expect(registry.size).toBe(MAX_COMMANDS);
    expect(registry.skipped.map((s) => s.reason)).toEqual(["limit", "limit"]);
  });
});

describe("CommandRegistry", () => {
  it("rejects invalid or duplicate names", () => {
    const command = {
      name: "ok",
      path: ".mars/commands/ok.md",
      source: ".mars/commands" as const,
      body: "x",
      unsupported: [],
      frontmatter: {},
    };
    expect(new CommandRegistry([command]).size).toBe(1);
    expect(() => new CommandRegistry([command, command])).toThrow(CommandError);
    expect(() => new CommandRegistry([{ ...command, name: "Not Ok" }])).toThrow(
      /invalid command name/,
    );
    expect(() => new CommandRegistry([{ ...command, name: "a:b:c" }])).toThrow(
      CommandError,
    );
  });
});

describe("parseSlashInput", () => {
  it("splits name, raw argument text and positional arguments", () => {
    expect(parseSlashInput("/review src/foo.ts  security  ")).toEqual({
      name: "review",
      argumentsText: "src/foo.ts  security",
      positional: ["src/foo.ts", "security"],
    });
    expect(parseSlashInput("/frontend:component Button 'a b' c")).toEqual({
      name: "frontend:component",
      argumentsText: "Button 'a b' c",
      positional: ["Button", "'a", "b'", "c"],
    });
    expect(parseSlashInput("/status")).toEqual({
      name: "status",
      argumentsText: "",
      positional: [],
    });
    expect(parseSlashInput("/review\nline two")).toEqual({
      name: "review",
      argumentsText: "line two",
      positional: ["line", "two"],
    });
    expect(parseSlashInput("review src")).toBeNull();
    expect(parseSlashInput("/")).toBeNull();
    expect(parseSlashInput("/Bad Name")).toBeNull();
    expect(parseSlashInput("/../etc")).toBeNull();
    expect(parseSlashInput("")).toBeNull();
  });
});

describe("expandCommand", () => {
  it("substitutes $ARGUMENTS and $1…$9 in one pass", async () => {
    const registry = await loadCommands(join(FIXTURES, "basic"));
    const expanded = expandCommand(registry, "/review src/foo.ts security $1");
    expect(expanded?.name).toBe("review");
    expect(expanded?.prompt).toBe(
      "Review src/foo.ts for bugs. Focus: security.\n\nFull arguments: src/foo.ts security $1\n",
    );
    expect(expanded?.command.path).toBe(".mars/commands/review.md");
    expect(expandCommand(registry, "/review")?.prompt).toBe(
      "Review  for bugs. Focus: .\n\nFull arguments: \n",
    );
    expect(
      expandCommand(registry, "/frontend:component Button a b")?.prompt,
    ).toBe("Create a React component named Button with props a b.\n");
  });

  it("appends arguments when the body uses no placeholder and leaves shell inclusion inert", async () => {
    const registry = await loadCommands(join(FIXTURES, "basic"));
    const expanded = expandCommand(registry, "/status include the diff");
    expect(expanded?.prompt).toBe(
      "Summarise the current repository status.\n\nRecent changes: !`git log --oneline -5`\nDiff: !`git diff HEAD`\nSee @README.md for context.\n\ninclude the diff\n",
    );
    expect(expanded?.command.unsupported.length).toBe(2);
    expect(expandCommand(registry, "/optimize")?.prompt).toBe(
      "Analyse this code for performance issues and suggest optimisations.\n",
    );
  });

  it("returns null for unknown names and non-slash input", async () => {
    const registry = await loadCommands(join(FIXTURES, "basic"));
    expect(expandCommand(registry, "/unknown")).toBeNull();
    expect(expandCommand(registry, "review")).toBeNull();
    expect(expandCommand(registry, "/deep:nested:ignored")).toBeNull();
    expect(expandCommand(registry, "/Review")).toBeNull();
  });

  it("rejects expanded prompts over 64 KiB", async () => {
    const dir = join(root, ".mars", "commands");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "big.md"),
      "$ARGUMENTS $ARGUMENTS $ARGUMENTS $ARGUMENTS $ARGUMENTS\n",
    );
    const registry = await loadCommands(root);
    expect(() => expandCommand(registry, `/big ${"x".repeat(14_000)}`)).toThrow(
      CommandError,
    );
    expect(
      expandCommand(registry, `/big ${"x".repeat(10_000)}`)?.prompt.length,
    ).toBe(5 * 10_000 + 5);
  });
});

describe("helpers", () => {
  it("substitutePlaceholders reports whether anything was substituted", () => {
    expect(substitutePlaceholders("no placeholders", "a", ["a"])).toEqual({
      prompt: "no placeholders",
      substituted: false,
    });
    expect(
      substitutePlaceholders("$9 $1 $ARGUMENTSX", "a b", ["a", "b"]),
    ).toEqual({
      prompt: " a a bX",
      substituted: true,
    });
    expect(findUnsupported("plain")).toEqual([]);
    expect(findUnsupported("!`a` and !`b`")).toEqual([
      "shell inclusion is not executed: !`a`",
      "shell inclusion is not executed: !`b`",
    ]);
  });
});
