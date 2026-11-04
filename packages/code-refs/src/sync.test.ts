import { describe, expect, test } from "bun:test";
import { checkRelativePath } from "../../../apps/vscode/src/pathSafety";
import { INVISIBLE_CODE_POINT_RANGES as MEMORY_RANGES } from "../../memory/src/threats";
import {
  checkLocatorPath,
  INVISIBLE_CODE_POINT_RANGES,
  MAX_PATH_LENGTH,
} from "./path-rules";

const CORPUS = [
  "src/app.ts",
  "a/b/c.txt",
  "README",
  "",
  "/etc/passwd",
  "~/x",
  "~root/x",
  "C:/x",
  "c:x",
  "file:///x",
  "http://host/x",
  "a\\b",
  "a/../b",
  "./a",
  "../a",
  "a/./b",
  "a//b",
  "a/",
  "/a",
  ".git/config",
  "a/.GIT/HEAD",
  "a/.gitignore",
  "a<b",
  "a>b",
  "a:b",
  'a"b',
  "a|b",
  "a?b",
  "a*b",
  "a\u0000b",
  "a\u001fb",
  "a\u007fb",
  "a\tb",
  "a\nb",
  "x".repeat(1024),
  "x".repeat(1025),
  "a b/c d.txt",
  "ünïcödé/файл.txt",
  "日本語/ファイル.md",
  "a[b]/c{d}.e",
  "a;b&c$(d)",
  "a'b",
  "a`b",
  "-a/--b",
  "a:/b",
  "mailto:x",
  "1:2",
];

describe("path rules stay in sync with apps/vscode/src/pathSafety.ts", () => {
  test("same length limit", () => {
    expect(MAX_PATH_LENGTH).toBe(1024);
  });

  test("identical accept/reject verdicts over the corpus", () => {
    for (const path of CORPUS) {
      const reference = checkRelativePath(path);
      const local = checkLocatorPath(path);
      expect([path, local.ok]).toEqual([path, reference.ok]);
      if (reference.ok && local.ok)
        expect(local.segments).toEqual(reference.segments);
    }
  });
});

describe("invisible code points stay in sync with packages/memory/src/threats.ts", () => {
  test("identical denylist", () => {
    expect(INVISIBLE_CODE_POINT_RANGES).toEqual(MEMORY_RANGES);
  });
});
