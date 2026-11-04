import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_MAX_SKILL_BYTES,
  DEFAULT_MAX_SKILLS,
  discoverSkills,
  isValidSkillName,
  toSkillRecords,
} from "./index";

const FIXTURES = resolve(import.meta.dir, "../test/fixtures/discovery");
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const skill = (name: string, description = "A skill") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mars-discovery-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("discoverSkills", () => {
  it("loads every convention folder in source order, dedups by name and records shadowed/skipped/warnings", async () => {
    const report = await discoverSkills({ root: join(FIXTURES, "basic") });
    expect(report.skills.map((s) => [s.name, s.source, s.path])).toEqual([
      ["alpha", "skills", "skills/alpha/SKILL.md"],
      ["beta", "skills", "skills/vendor/acme/beta/SKILL.md"],
      ["gamma", ".claude/skills", ".claude/skills/gamma/SKILL.md"],
      ["delta", ".codex/skills", ".codex/skills/delta/SKILL.md"],
      ["zeta", ".codex/skills", ".codex/skills/renamed/SKILL.md"],
      ["epsilon", ".agents/skills", ".agents/skills/epsilon/SKILL.md"],
    ]);
    expect(report.shadowed).toEqual([
      {
        name: "alpha",
        path: ".claude/skills/alpha/SKILL.md",
        shadowed_by: "skills/alpha/SKILL.md",
      },
    ]);
    expect(report.skipped).toEqual([
      { path: ".agents/skills/broken/SKILL.md", reason: "frontmatter" },
      {
        path: ".agents/skills/nameless/SKILL.md",
        reason: "missing-name-or-description",
      },
    ]);
    expect(report.warnings).toEqual([
      {
        path: ".codex/skills/renamed/SKILL.md",
        message: 'frontmatter name "zeta" differs from folder "renamed"',
      },
    ]);
    const alpha = report.skills[0];
    expect(alpha?.description).toBe(
      "Project skill alpha (wins over the .claude copy)",
    );
    expect(alpha?.content.startsWith("---\nname: alpha")).toBe(true);
    expect(alpha?.bytes).toBe(Buffer.byteLength(alpha?.content ?? ""));
    const beta = report.skills[1];
    expect(beta?.frontmatter).toEqual({
      name: "beta",
      version: "1.0.0",
      description: "Vendored skill beta",
      "argument-hint": "<thing>",
      "allowed-tools": "Bash, Read",
      license: "MIT",
    });
    expect(report.skills.some((s) => s.name === "old")).toBe(false);
  });

  it("is deterministic across runs", async () => {
    const a = await discoverSkills({ root: join(FIXTURES, "basic") });
    const b = await discoverSkills({ root: join(FIXTURES, "basic") });
    expect(b).toEqual(a);
  });

  it("loads the vendored watch-skill folders from this repository", async () => {
    const report = await discoverSkills({ root: REPO_ROOT });
    const names = report.skills
      .filter((s) => s.path.startsWith("skills/vendor/watch-skill/"))
      .map((s) => s.name);
    expect(names).toContain("watch");
    expect(names).toContain("the-loop");
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(report.skipped.filter((s) => s.path.startsWith("skills/"))).toEqual(
      [],
    );
    for (const found of report.skills) {
      expect(found.source).toBe("skills");
      expect(isValidSkillName(found.name)).toBe(true);
      expect(found.description.length).toBeGreaterThan(0);
    }
  });

  it("returns an empty report for a root without convention folders", async () => {
    expect(await discoverSkills({ root })).toEqual({
      skills: [],
      shadowed: [],
      skipped: [],
      warnings: [],
    });
  });

  it("skips symlinked folders and files, oversize files, invalid names and non-UTF-8 content", async () => {
    await mkdir(join(root, "skills", "real"), { recursive: true });
    await writeFile(join(root, "skills", "real", "SKILL.md"), skill("real"));
    await symlink(join(root, "skills", "real"), join(root, "skills", "linked"));
    await mkdir(join(root, "skills", "file-link"));
    await symlink(
      join(root, "skills", "real", "SKILL.md"),
      join(root, "skills", "file-link", "SKILL.md"),
    );
    await mkdir(join(root, "skills", "big"));
    await writeFile(
      join(root, "skills", "big", "SKILL.md"),
      skill("big", "x".repeat(DEFAULT_MAX_SKILL_BYTES)),
    );
    await mkdir(join(root, "skills", "Upper"));
    await writeFile(join(root, "skills", "Upper", "SKILL.md"), skill("Upper"));
    await mkdir(join(root, "skills", "binary"));
    await writeFile(
      join(root, "skills", "binary", "SKILL.md"),
      Buffer.concat([Buffer.from(skill("binary")), Buffer.from([0xff, 0xfe])]),
    );
    await mkdir(join(root, "skills", "proto"));
    await writeFile(
      join(root, "skills", "proto", "SKILL.md"),
      skill("constructor"),
    );
    const report = await discoverSkills({ root });
    expect(report.skills.map((s) => s.name)).toEqual(["real"]);
    expect(report.skipped).toEqual([
      { path: "skills/Upper/SKILL.md", reason: "invalid-name" },
      { path: "skills/big/SKILL.md", reason: "oversize" },
      { path: "skills/binary/SKILL.md", reason: "encoding" },
      { path: "skills/file-link/SKILL.md", reason: "symlink" },
      { path: "skills/proto/SKILL.md", reason: "invalid-name" },
    ]);
    expect(report.shadowed).toEqual([]);
  });

  it("honours maxSkills and maxContentBytes", async () => {
    for (const name of ["a", "b", "c"]) {
      await mkdir(join(root, ".codex", "skills", name), { recursive: true });
      await writeFile(
        join(root, ".codex", "skills", name, "SKILL.md"),
        skill(name),
      );
    }
    const limited = await discoverSkills({ root, maxSkills: 2 });
    expect(limited.skills.map((s) => s.name)).toEqual(["a", "b"]);
    expect(limited.skipped).toEqual([
      { path: ".codex/skills/c/SKILL.md", reason: "limit" },
    ]);
    const tiny = await discoverSkills({ root, maxContentBytes: 10 });
    expect(tiny.skills).toEqual([]);
    expect(tiny.skipped.every((s) => s.reason === "oversize")).toBe(true);
    expect(DEFAULT_MAX_SKILLS).toBe(256);
    await expect(discoverSkills({ root, maxSkills: -1 })).rejects.toThrow(
      RangeError,
    );
    await expect(discoverSkills({ root, maxContentBytes: 0 })).rejects.toThrow(
      RangeError,
    );
  });

  it("ignores stray SKILL.md files outside the one-level layout", async () => {
    await mkdir(join(root, "skills", "nested", "deeper"), { recursive: true });
    await writeFile(
      join(root, "skills", "nested", "deeper", "SKILL.md"),
      skill("deeper"),
    );
    await writeFile(join(root, "skills", "SKILL.md"), skill("skills"));
    await mkdir(join(root, ".claude", "skills", "ok"), { recursive: true });
    await writeFile(
      join(root, ".claude", "skills", "ok", "SKILL.md"),
      skill("ok"),
    );
    const report = await discoverSkills({ root });
    expect(report.skills.map((s) => s.name)).toEqual(["ok"]);
    expect(report.skipped).toEqual([]);
  });
});

describe("toSkillRecords", () => {
  it("maps discovered skills to active, unpinned SkillRecords with fixed epoch metadata", async () => {
    const report = await discoverSkills({ root: join(FIXTURES, "basic") });
    const records = toSkillRecords(report);
    expect(records.length).toBe(report.skills.length);
    expect(records[0]).toEqual({
      name: "alpha",
      content: report.skills[0]?.content ?? "",
      status: "active",
      pinned: false,
      createdAt: 0,
      lastActivity: 0,
      useCount: 0,
    });
    expect(toSkillRecords(report.skills)).toEqual(records);
  });
});
