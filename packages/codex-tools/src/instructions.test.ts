import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_INSTRUCTION_BYTES,
  discoverInstructions,
  INSTRUCTIONS_PREAMBLE,
  InstructionsError,
  renderInstructions,
} from "./instructions";

const ROOT = join(import.meta.dir, "..", "test", "fixtures", "instructions");

describe("discoverInstructions on the committed fixture", () => {
  test("root only: AGENTS.md then CLAUDE.md", async () => {
    const found = await discoverInstructions({ root: ROOT });
    expect(found.files.map((f) => [f.path, f.kind])).toEqual([
      ["AGENTS.md", "AGENTS.md"],
      ["CLAUDE.md", "CLAUDE.md"],
    ]);
    expect(found.omitted).toBe(0);
    expect(found.total_bytes).toBe(
      "Root agents.\n".length + "Root claude.\n".length,
    );
    expect(found.text).toBe(
      `${INSTRUCTIONS_PREAMBLE}\n\n--- AGENTS.md ---\nRoot agents.\n\n\n--- CLAUDE.md ---\nRoot claude.\n`,
    );
    expect(found.sha256).toBe(
      createHash("sha256").update(found.text).digest("hex"),
    );
    expect(renderInstructions(found)).toBe(found.text);
  });

  test("walks root to cwd, override shadows plain, raw text kept", async () => {
    const found = await discoverInstructions({
      root: ROOT,
      cwd: join(ROOT, "sub", "deep"),
    });
    expect(found.files.map((f) => f.path)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "sub/AGENTS.override.md",
      "sub/deep/CLAUDE.md",
    ]);
    expect(found.files[2]?.kind).toBe("AGENTS.override.md");
    expect(found.files[3]?.text).toBe("Deep claude with NUL \0 and tab\t.\n");
    expect(found.files.every((f) => !f.truncated)).toBe(true);
  });

  test("filenames option narrows candidates", async () => {
    const found = await discoverInstructions({
      root: ROOT,
      cwd: join(ROOT, "sub"),
      filenames: ["AGENTS.md"],
    });
    expect(found.files.map((f) => f.path)).toEqual([
      "AGENTS.md",
      "sub/AGENTS.md",
    ]);
    await expect(
      discoverInstructions({ root: ROOT, filenames: ["README.md"] }),
    ).rejects.toThrow(InstructionsError);
  });

  test("budget truncates the crossing file and omits the rest", async () => {
    const found = await discoverInstructions({
      root: ROOT,
      cwd: join(ROOT, "sub", "deep"),
      maxTotalBytes: 20,
    });
    expect(found.files.map((f) => [f.path, f.bytes, f.truncated])).toEqual([
      ["AGENTS.md", 13, false],
      ["CLAUDE.md", 7, true],
    ]);
    expect(found.files[1]?.text).toBe("Root cl");
    expect(found.total_bytes).toBe(20);
    expect(found.omitted).toBe(2);
  });

  test("zero budget omits everything and renders empty", async () => {
    const found = await discoverInstructions({ root: ROOT, maxTotalBytes: 0 });
    expect(found.files).toEqual([]);
    expect(found.omitted).toBe(2);
    expect(found.text).toBe("");
    expect(renderInstructions(found)).toBe("");
  });

  test("rejects relative or escaping paths", async () => {
    await expect(
      discoverInstructions({ root: "relative/root" }),
    ).rejects.toThrow("root must be absolute");
    await expect(
      discoverInstructions({ root: ROOT, cwd: "sub" }),
    ).rejects.toThrow("cwd must be absolute");
    await expect(
      discoverInstructions({ root: ROOT, cwd: join(ROOT, "..") }),
    ).rejects.toThrow("is outside root");
    await expect(
      discoverInstructions({ root: ROOT, maxTotalBytes: -1 }),
    ).rejects.toThrow("non-negative integer");
  });

  test("default budget is 32 KiB", () => {
    expect(DEFAULT_MAX_INSTRUCTION_BYTES).toBe(32768);
  });
});

describe("discoverInstructions on a temp tree", () => {
  test("skips symlinks and directories, truncates on a UTF-8 boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-instructions-"));
    await writeFile(join(root, "real.md"), "linked\n");
    await symlink(join(root, "real.md"), join(root, "AGENTS.md"));
    await mkdir(join(root, "CLAUDE.md"));
    await mkdir(join(root, "pkg"));
    await writeFile(join(root, "pkg", "AGENTS.md"), "héllo wörld\n");
    const found = await discoverInstructions({
      root,
      cwd: join(root, "pkg"),
      maxTotalBytes: 2,
    });
    expect(found.files.map((f) => f.path)).toEqual(["pkg/AGENTS.md"]);
    expect(found.files[0]).toMatchObject({
      text: "h",
      bytes: 1,
      truncated: true,
    });
    expect(found.omitted).toBe(0);
  });

  test("a non-UTF-8 file cannot inflate past the byte budget when decoded", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-instructions-"));
    // 3,000 invalid bytes decode to 3,000 U+FFFD characters (9,000 UTF-8 bytes).
    await writeFile(join(root, "AGENTS.md"), Buffer.alloc(3_000, 0xff));
    const found = await discoverInstructions({ root, maxTotalBytes: 4_000 });
    expect(found.files.map((f) => f.path)).toEqual(["AGENTS.md"]);
    const [agents] = found.files;
    expect(agents?.truncated).toBe(true);
    expect(Buffer.byteLength(agents?.text ?? "", "utf8")).toBeLessThanOrEqual(
      4_000,
    );
    expect(agents?.bytes).toBe(Buffer.byteLength(agents?.text ?? "", "utf8"));
    expect(found.total_bytes).toBeLessThanOrEqual(4_000);
    expect(Buffer.byteLength(found.text, "utf8")).toBeLessThan(4_200);
  });

  test("a directory whose name starts with '..' is still inside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-instructions-"));
    await mkdir(join(root, "..hidden"));
    await writeFile(join(root, "..hidden", "AGENTS.md"), "dotdot\n");
    const found = await discoverInstructions({
      root,
      cwd: join(root, "..hidden"),
    });
    expect(found.files.map((f) => f.path)).toEqual(["..hidden/AGENTS.md"]);
    await expect(
      discoverInstructions({ root, cwd: join(root, "..") }),
    ).rejects.toBeInstanceOf(InstructionsError);
  });
});
