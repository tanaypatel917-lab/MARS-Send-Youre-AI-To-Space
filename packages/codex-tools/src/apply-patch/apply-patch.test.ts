import { describe, expect, test } from "bun:test";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PatchFileSystem } from "../types";
import {
  applyPatch,
  MAX_HUNKS,
  MAX_PATCH_BYTES,
  MAX_SEEK_LINE_COMPARISONS,
  PatchParseError,
  parsePatch,
  renderApplyPatchInstructions,
  renderApplyPatchSummary,
  SeekBudgetExceededError,
  SourceFile,
  StreamingPatchParser,
  seekSequence,
  validatePatchPath,
} from "./index";

const FIXTURES = join(
  import.meta.dir,
  "..",
  "..",
  "test",
  "fixtures",
  "apply-patch",
);

class MemoryFs implements PatchFileSystem {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();

  constructor(entries: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(entries)) {
      this.files.set(path, text);
    }
  }

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, text: string): Promise<void> {
    this.files.set(path, text);
  }

  async remove(path: string): Promise<void> {
    if (!this.files.delete(path)) {
      throw new Error(`ENOENT ${path}`);
    }
  }

  async exists(path: string): Promise<"file" | "directory" | null> {
    if (this.files.has(path)) {
      return "file";
    }
    if (this.directories.has(path)) {
      return "directory";
    }
    const prefix = `${path}/`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        return "directory";
      }
    }
    return null;
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(
      [...this.files.entries()].sort(([a], [b]) => a.localeCompare(b)),
    );
  }
}

async function readTree(
  dir: string,
  prefix = "",
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(out, await readTree(join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out[rel] = await readFile(join(dir, entry.name), "utf8");
    }
  }
  return out;
}

const FAILING_SCENARIO = /rejects|fails|requires|failure/;

describe("upstream scenarios", async () => {
  const names = (await readdir(FIXTURES, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(names.length).toBeGreaterThanOrEqual(24);
  for (const name of names) {
    test(name, async () => {
      const dir = join(FIXTURES, name);
      const fs = new MemoryFs(await readTree(join(dir, "input")));
      const patch = await readFile(join(dir, "patch.txt"), "utf8");
      const result = await applyPatch(patch, fs);
      expect(result.ok).toBe(!FAILING_SCENARIO.test(name));
      expect(fs.snapshot()).toEqual(await readTree(join(dir, "expected")));
    });
  }
});

describe("exact upstream messages", () => {
  test("empty patch applies nothing", async () => {
    const result = await applyPatch(
      "*** Begin Patch\n*** End Patch\n",
      new MemoryFs(),
    );
    expect(result).toEqual({
      ok: false,
      applied: { added: [], modified: [], deleted: [] },
      failed_hunk: null,
      error: "No files were modified.",
    });
  });

  test("invalid hunk header names the line", async () => {
    const result = await applyPatch(
      "*** Begin Patch\n*** Frobnicate File: foo\n*** End Patch",
      new MemoryFs(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        "Invalid patch hunk on line 2: '*** Frobnicate File: foo' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'",
      );
    }
  });

  test("empty update hunk", () => {
    expect(() =>
      parsePatch("*** Begin Patch\n*** Update File: foo.txt\n*** End Patch"),
    ).toThrow(
      "Invalid patch hunk on line 2: Update file hunk for path 'foo.txt' is empty",
    );
  });

  test("chunk without lines followed by another @@", () => {
    expect(() =>
      parsePatch(
        "*** Begin Patch\n*** Update File: a\n@@\n@@\n-x\n+y\n*** End Patch",
      ),
    ).toThrow("Unexpected line found in update hunk: '@@'");
  });

  test("move after a chunk is rejected", () => {
    expect(() =>
      parsePatch(
        "*** Begin Patch\n*** Update File: a\n@@\n-x\n+y\n*** Move to: b\n*** End Patch",
      ),
    ).toThrow("Expected update hunk to start with a @@ context marker");
  });

  test("missing expected lines", async () => {
    const result = await applyPatch(
      "*** Begin Patch\n*** Update File: modify.txt\n@@\n-missing\n+changed\n*** End Patch",
      new MemoryFs({ "modify.txt": "one\n" }),
    );
    expect(result).toMatchObject({
      ok: false,
      failed_hunk: 0,
      error: "Failed to find expected lines in modify.txt:\nmissing",
    });
  });

  test("missing context", async () => {
    const result = await applyPatch(
      "*** Begin Patch\n*** Update File: a.txt\n@@ nowhere\n-one\n+two\n*** End Patch",
      new MemoryFs({ "a.txt": "one\n" }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: "Failed to find context 'nowhere' in a.txt",
    });
  });

  test("update of a missing file / delete of a directory", async () => {
    const fs = new MemoryFs({ "dir/foo.txt": "x\n" });
    expect(
      await applyPatch(
        "*** Begin Patch\n*** Update File: nope\n@@\n-a\n+b\n*** End Patch",
        fs,
      ),
    ).toMatchObject({
      ok: false,
      failed_hunk: 0,
      error: "Failed to read file to update nope",
    });
    expect(
      await applyPatch(
        "*** Begin Patch\n*** Delete File: dir\n*** End Patch",
        fs,
      ),
    ).toMatchObject({
      ok: false,
      error: "Failed to delete file dir",
    });
    expect(
      await applyPatch(
        "*** Begin Patch\n*** Delete File: gone\n*** End Patch",
        fs,
      ),
    ).toMatchObject({
      ok: false,
      error: "Failed to delete file gone",
    });
  });

  test("summary matches print_summary and move reports the destination", async () => {
    const fs = new MemoryFs({ "old.txt": "a\n", "gone.txt": "" });
    const result = await applyPatch(
      [
        "*** Begin Patch",
        "*** Add File: new.txt",
        "+hi",
        "*** Update File: old.txt",
        "*** Move to: moved/new.txt",
        "@@",
        "-a",
        "+b",
        "*** Delete File: gone.txt",
        "*** End Patch",
      ].join("\n"),
      fs,
    );
    expect(result).toEqual({
      ok: true,
      applied: {
        added: ["new.txt"],
        modified: ["moved/new.txt"],
        deleted: ["gone.txt"],
      },
      summary:
        "Success. Updated the following files:\nA new.txt\nM moved/new.txt\nD gone.txt\n",
    });
    expect(fs.snapshot()).toEqual({
      "moved/new.txt": "b\n",
      "new.txt": "hi\n",
    });
    expect(
      renderApplyPatchSummary({ added: [], modified: [], deleted: [] }),
    ).toBe("Success. Updated the following files:\n");
  });

  test("first failing hunk stops the patch and keeps earlier hunks", async () => {
    const fs = new MemoryFs();
    const result = await applyPatch(
      "*** Begin Patch\n*** Add File: a.txt\n+a\n*** Delete File: missing\n*** Add File: b.txt\n+b\n*** End Patch",
      fs,
    );
    expect(result).toEqual({
      ok: false,
      applied: { added: ["a.txt"], modified: [], deleted: [] },
      failed_hunk: 1,
      error: "Failed to delete file missing",
    });
    expect(fs.snapshot()).toEqual({ "a.txt": "a\n" });
  });
});

describe("MARS bounds", () => {
  test.each([
    ["../escape.txt", "'..'"],
    ["/etc/passwd", "relative"],
    ["dir\\file.txt", "forward slashes"],
    ["C:/windows", "relative"],
    ["a//b", "empty segment"],
    ["./a", "'.'"],
    ["bad\u0007name", "control character"],
    [`${"x".repeat(1025)}`, "1024 bytes"],
  ])("rejects path %j", async (path, reason) => {
    expect(validatePatchPath(path)).toContain(reason);
    const fs = new MemoryFs({ "ok.txt": "" });
    const result = await applyPatch(
      `*** Begin Patch\n*** Add File: ok.txt\n+x\n*** Add File: ${path}\n+boom\n*** End Patch`,
      fs,
    );
    expect(result).toMatchObject({ ok: false, failed_hunk: 1 });
    expect(fs.snapshot()).toEqual({ "ok.txt": "" });
  });

  test("accepts ordinary relative paths including unicode", () => {
    expect(validatePatchPath("src/a-b_c.ts")).toBeNull();
    expect(validatePatchPath("docs/héllo wörld.md")).toBeNull();
    expect(validatePatchPath("x".repeat(1024))).toBeNull();
    expect(validatePatchPath("")).toContain("empty");
  });

  test("move destination is validated too", async () => {
    const result = await applyPatch(
      "*** Begin Patch\n*** Update File: a\n*** Move to: ../b\n@@\n-x\n+y\n*** End Patch",
      new MemoryFs({ a: "x\n" }),
    );
    expect(result).toMatchObject({
      ok: false,
      failed_hunk: 0,
      error: "Invalid path '../b': path contains a '..' segment",
    });
  });

  test("patches over 1 MiB are rejected", async () => {
    const big = `*** Begin Patch\n*** Add File: big.txt\n+${"a".repeat(MAX_PATCH_BYTES)}\n*** End Patch`;
    const result = await applyPatch(big, new MemoryFs());
    expect(result).toMatchObject({ ok: false, failed_hunk: null });
    if (!result.ok) {
      expect(result.error).toContain(`limit is ${MAX_PATCH_BYTES} bytes`);
    }
  });

  test("a pathological context search fails fast instead of stalling the host", async () => {
    // Every candidate position matches until the final pattern line, so an
    // unbounded search would cost ~(lines × pattern) comparisons.
    const lines = Array.from({ length: 20_000 }, () => "a");
    const pattern = [...Array.from({ length: 10_000 }, () => "a"), "b"];
    expect(lines.length * pattern.length).toBeGreaterThan(
      MAX_SEEK_LINE_COMPARISONS,
    );
    expect(() =>
      seekSequence(lines, pattern, 0, false, {
        remaining: MAX_SEEK_LINE_COMPARISONS,
      }),
    ).toThrow(SeekBudgetExceededError);
    const fs = new MemoryFs({ "big.txt": `${lines.join("\n")}\n` });
    const result = await applyPatch(
      `*** Begin Patch\n*** Update File: big.txt\n@@\n${pattern.map((line) => `-${line}`).join("\n")}\n+c\n*** End Patch`,
      fs,
    );
    expect(result).toMatchObject({ ok: false, failed_hunk: 0 });
    if (!result.ok) {
      expect(result.error).toBe(
        `Failed to apply chunks to big.txt: context search exceeded ${MAX_SEEK_LINE_COMPARISONS} line comparisons`,
      );
    }
    expect(fs.snapshot()).toEqual({ "big.txt": `${lines.join("\n")}\n` });
  });

  test("more than 4096 hunks are rejected", () => {
    const hunks = Array.from(
      { length: MAX_HUNKS + 1 },
      (_, i) => `*** Delete File: f${i}`,
    );
    expect(() =>
      parsePatch(`*** Begin Patch\n${hunks.join("\n")}\n*** End Patch`),
    ).toThrow(`more than ${MAX_HUNKS} hunks`);
    const ok = parsePatch(
      `*** Begin Patch\n${hunks.slice(0, MAX_HUNKS).join("\n")}\n*** End Patch`,
    );
    expect(ok.hunks).toHaveLength(MAX_HUNKS);
  });
});

describe("parser leniency", () => {
  const inner = "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch";

  test.each(["<<EOF", "<<'EOF'", '<<"EOF"'])(
    "heredoc %s unwrapped in lenient mode",
    (open) => {
      const wrapped = `${open}\n${inner}\nEOF\n`;
      expect(parsePatch(wrapped).hunks).toEqual([
        { kind: "add", path: "a.txt", contents: "hello\n" },
      ]);
      expect(() => parsePatch(wrapped, "strict")).toThrow(
        "Invalid patch: The first line of the patch must be '*** Begin Patch'",
      );
    },
  );

  test("mismatched heredoc quotes are not unwrapped", () => {
    expect(() => parsePatch(`<<"EOF'\n${inner}\nEOF\n`)).toThrow(
      PatchParseError,
    );
  });

  test("whitespace around markers and CRLF patch text", () => {
    const parsed = parsePatch(
      "  *** Begin Patch \r\n   *** Update File: a.txt\r\n@@\r\n-x\r\n+y\r\n*** End Patch  \r\n",
    );
    expect(parsed.hunks).toEqual([
      {
        kind: "update",
        path: "a.txt",
        move_path: null,
        chunks: [
          {
            change_context: null,
            old_lines: ["x"],
            new_lines: ["y"],
            context_line_indices: [],
            is_end_of_file: false,
          },
        ],
      },
    ]);
  });

  test("environment id is accepted, exposed and validated", () => {
    expect(
      parsePatch(
        `*** Begin Patch\n*** Environment ID: env-1\n*** Add File: a\n+x\n*** End Patch`,
      ),
    ).toMatchObject({
      environment_id: "env-1",
      hunks: [{ kind: "add", path: "a" }],
    });
    expect(parsePatch(inner).environment_id).toBeNull();
    expect(() =>
      parsePatch("*** Begin Patch\n*** Environment ID:   \n*** End Patch"),
    ).toThrow("apply_patch environment_id cannot be empty");
    expect(() =>
      parsePatch(
        "*** Begin Patch\n*** Environment ID: a\n*** Environment ID: b\n*** End Patch",
      ),
    ).toThrow("cannot be specified more than once");
  });

  test("context, end-of-file marker and empty context lines", () => {
    const parsed = parsePatch(
      "*** Begin Patch\n*** Update File: a\n@@ fn main\n keep\n-old\n+new\n\n*** End of File\n*** End Patch",
    );
    expect(parsed.hunks[0]).toEqual({
      kind: "update",
      path: "a",
      move_path: null,
      chunks: [
        {
          change_context: "fn main",
          old_lines: ["keep", "old", ""],
          new_lines: ["keep", "new", ""],
          context_line_indices: [
            [0, 0],
            [2, 2],
          ],
          is_end_of_file: true,
        },
      ],
    });
  });

  test("streaming parser handles partial lines across deltas", () => {
    const parser = new StreamingPatchParser();
    expect(
      parser.pushDelta(
        "*** Begin Patch\n*** Add File: src/hello.txt\n+hello\n+wor",
      ),
    ).toEqual([{ kind: "add", path: "src/hello.txt", contents: "hello\n" }]);
    expect(parser.pushDelta("ld\n")).toEqual([
      { kind: "add", path: "src/hello.txt", contents: "hello\nworld\n" },
    ]);
    parser.pushDelta("*** End Patch");
    expect(parser.finish()).toHaveLength(1);
    expect(() => new StreamingPatchParser().finish()).toThrow(
      "The last line of the patch must be '*** End Patch'",
    );
  });
});

describe("seekSequence", () => {
  const lines = ["alpha", "beta  ", "  gamma", "“quoted” — dash", "end"];
  test("passes of decreasing strictness", () => {
    expect(seekSequence(lines, ["alpha"], 0, false)).toBe(0);
    expect(seekSequence(lines, ["beta"], 0, false)).toBe(1);
    expect(seekSequence(lines, ["gamma"], 0, false)).toBe(2);
    expect(seekSequence(lines, ['"quoted" - dash'], 0, false)).toBe(3);
    expect(seekSequence(lines, ["nope"], 0, false)).toBeNull();
    expect(seekSequence(lines, ["alpha"], 1, false)).toBeNull();
  });
  test("eof prefers the end position; defensive cases", () => {
    expect(seekSequence(["x", "y", "x"], ["x"], 0, true)).toBe(2);
    expect(seekSequence(["x", "y", "x"], ["x"], 0, false)).toBe(0);
    expect(seekSequence(lines, [], 3, false)).toBe(3);
    expect(seekSequence(["a"], ["a", "b"], 0, false)).toBeNull();
  });
});

describe("SourceFile line endings", () => {
  test("keeps CRLF and inserts with the file's first ending", () => {
    const file = SourceFile.parse("one\r\ntwo\r\nthree\r\n");
    file.applyReplacements([[0, 1, ["ONE", "between"]]]);
    expect(file.contents()).toBe("ONE\r\nbetween\r\ntwo\r\nthree\r\n");
  });
  test("mixed endings survive and the last line gains a terminator", () => {
    const file = SourceFile.parse("a\r\nb\rc\nd");
    expect(file.lineTexts()).toEqual(["a", "b", "c", "d"]);
    file.applyReplacements([[2, 1, ["C"]]]);
    expect(file.contents()).toBe("a\r\nb\rC\r\nd\r\n");
  });
  test("no existing ending defaults to LF", () => {
    const file = SourceFile.parse("solo");
    file.applyReplacements([[1, 0, ["added"]]]);
    expect(file.contents()).toBe("solo\nadded\n");
  });
  test("CRLF preserved end to end through applyPatch", async () => {
    const fs = new MemoryFs({ "w.txt": "one\r\ntwo\r\n" });
    const result = await applyPatch(
      "*** Begin Patch\n*** Update File: w.txt\n@@\n one\n+mid\n two\n*** End Patch",
      fs,
    );
    expect(result.ok).toBe(true);
    expect(fs.files.get("w.txt")).toBe("one\r\nmid\r\ntwo\r\n");
  });
});

test("renderApplyPatchInstructions is short, MARS-authored text", () => {
  const text = renderApplyPatchInstructions();
  expect(text).toContain("*** Begin Patch");
  expect(text).toContain("*** Update File:");
  expect(text.length).toBeLessThan(2048);
});
