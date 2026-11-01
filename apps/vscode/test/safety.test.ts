import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DiffOpenerHost,
  type DiffSide,
  matchWorkspaceFolder,
  openFileDiff,
} from "../src/diffOpener";
import { buildWebviewHtml, isValidNonce } from "../src/html";
import { WebviewMessageSchema } from "../src/messages";
import { patchStats, reconstructOriginal, removedText } from "../src/patch";
import { checkRelativePath, resolveInsideRoot } from "../src/pathSafety";
import { describeResult } from "./fixtures";

const base = mkdtempSync(join(tmpdir(), "mars-vscode-"));
const root = join(base, "demo");
const outside = join(base, "outside");
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(outside);
writeFileSync(join(root, "src", "a.ts"), "one\nTWO\nthree\n");
writeFileSync(join(root, "src", "base.ts"), "one\ntwo\nthree\n");
writeFileSync(join(root, "src", "dirty.ts"), "one\nlocal edit\nthree\n");
writeFileSync(join(outside, "secret.txt"), "secret\n");
symlinkSync(outside, join(root, "link"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const patch =
  "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";

describe("checkRelativePath", () => {
  test("accepts ordinary relative paths", () => {
    expect(checkRelativePath("src/a.ts")).toEqual({
      ok: true,
      segments: ["src", "a.ts"],
    });
  });
  test("rejects traversal, absolute, URI, command and control-character paths", () => {
    for (const path of [
      "",
      "../etc/passwd",
      "src/../../x",
      "/etc/passwd",
      "C:/Windows/x",
      "src\\a.ts",
      "~/x",
      "file:///etc/passwd",
      "command:workbench.action.terminal.new",
      "vscode:extension/x",
      "src//a.ts",
      "./a.ts",
      "a\u0000b",
      "a\nb",
      ".git/config",
      "src/.git/hooks/pre-commit",
      "a<b>.ts",
      "x".repeat(5000),
    ])
      expect(checkRelativePath(path).ok).toBe(false);
  });
});

describe("resolveInsideRoot", () => {
  test("resolves real files and missing files inside the root", async () => {
    expect(await resolveInsideRoot(root, ["src", "a.ts"], realpath)).toEqual({
      ok: true,
      fsPath: join(realpathSync(root), "src", "a.ts"),
      exists: true,
    });
    expect(
      await resolveInsideRoot(root, ["src", "new.ts"], realpath),
    ).toMatchObject({ ok: true, exists: false });
  });
  test("root-level names starting with '..' are inside the workspace", async () => {
    expect(checkRelativePath("..config").ok).toBe(true);
    expect(await resolveInsideRoot(root, ["..config"], realpath)).toMatchObject(
      { ok: true, exists: false },
    );
  });
  test("rejects symlinks escaping the workspace", async () => {
    expect(
      (await resolveInsideRoot(root, ["link", "secret.txt"], realpath)).ok,
    ).toBe(false);
    expect(
      (await resolveInsideRoot(root, ["link", "new.txt"], realpath)).ok,
    ).toBe(false);
  });
});

describe("patch helpers", () => {
  test("stats and reverse application", () => {
    expect(patchStats(patch)).toEqual({ additions: 1, deletions: 1 });
    expect(reconstructOriginal("one\nTWO\nthree\n", patch)).toBe(
      "one\ntwo\nthree\n",
    );
    expect(reconstructOriginal("changed locally\n", patch)).toBeNull();
    expect(
      removedText("--- a/x\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n"),
    ).toBe("a\nb\n");
  });
});

function host(folders = [{ name: "demo", fsPath: root }]) {
  const diffs: Array<{ left: DiffSide; right: DiffSide }> = [];
  const patches: string[] = [];
  const h: DiffOpenerHost = {
    folders: () => folders,
    realpath,
    readText: (path) => readFile(path, "utf8"),
    showDiff: async (left, right) => {
      diffs.push({ left, right });
    },
    showPatch: async (text) => {
      patches.push(text);
    },
  };
  return { h, diffs, patches };
}

describe("openFileDiff", () => {
  test("opens a native diff for a validated file in the matching workspace", async () => {
    const { h, diffs } = host();
    expect(
      await openFileDiff(h, describeResult, {
        path: "src/a.ts",
        status: "modified",
        patch,
      }),
    ).toEqual({ mode: "diff", basis: "local-after" });
    expect(diffs[0]?.left).toEqual({
      kind: "text",
      text: "one\ntwo\nthree\n",
      label: "before-a.ts",
    });
    expect(diffs[0]?.right).toEqual({
      kind: "file",
      fsPath: join(realpathSync(root), "src", "a.ts"),
    });
  });

  test("refuses unsafe paths without touching the host", async () => {
    const { h, diffs, patches } = host();
    for (const path of [
      "../outside/secret.txt",
      "link/secret.txt",
      "command:evil",
      "/etc/passwd",
    ]) {
      const outcome = await openFileDiff(h, describeResult, {
        path,
        status: "modified",
        patch,
      });
      expect(outcome.mode).toBe("rejected");
    }
    expect(diffs).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });

  test("falls back to a read-only patch when the workspace does not match or the file drifted", async () => {
    const other = host([{ name: "other", fsPath: root }]);
    expect(
      (
        await openFileDiff(other.h, describeResult, {
          path: "src/a.ts",
          status: "modified",
          patch,
        })
      ).mode,
    ).toBe("patch");
    expect(other.patches).toEqual([patch]);
    const dup = host([
      { name: "demo", fsPath: root },
      { name: "demo", fsPath: outside },
    ]);
    expect(
      matchWorkspaceFolder(dup.h.folders(), describeResult),
    ).toHaveProperty("reason");
    const drift = host();
    const drifted =
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-zzz\n+yyy\n";
    expect(
      (
        await openFileDiff(drift.h, describeResult, {
          path: "src/a.ts",
          status: "modified",
          patch: drifted,
        })
      ).mode,
    ).toBe("patch");
  });
});

describe("openFileDiff in an isolated task workspace", () => {
  const modify = (path: string, body: string) =>
    `--- a/${path}\n+++ b/${path}\n${body}`;
  const addPatch =
    "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+export const x = 1;\n+// <script>\n";

  function tracked(folders = [{ name: "demo", fsPath: root }]) {
    const base = host(folders);
    const reads: string[] = [];
    const readText = base.h.readText;
    base.h.readText = (path) => {
      reads.push(path);
      return readText(path);
    };
    return { ...base, reads };
  }

  test("before-only modified file: applies the patch forward into a virtual task buffer", async () => {
    const { h, diffs, patches } = tracked();
    const outcome = await openFileDiff(h, describeResult, {
      path: "src/base.ts",
      status: "modified",
      patch: modify(
        "src/base.ts",
        "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n",
      ),
    });
    expect(outcome).toEqual({ mode: "diff", basis: "local-before" });
    expect(patches).toHaveLength(0);
    expect(diffs[0]).toEqual({
      left: { kind: "text", text: "one\ntwo\nthree\n", label: "local-base.ts" },
      right: { kind: "text", text: "one\nTWO\nthree\n", label: "task-base.ts" },
    });
    expect(readFileSync(join(root, "src", "base.ts"), "utf8")).toBe(
      "one\ntwo\nthree\n",
    );
  });

  test("task-only added file: derives full content from the add patch without a local file", async () => {
    for (const folders of [[{ name: "demo", fsPath: root }], []]) {
      const { h, diffs, reads } = tracked(folders);
      const outcome = await openFileDiff(h, describeResult, {
        path: "src/new.ts",
        status: "added",
        patch: addPatch,
      });
      expect(outcome).toEqual({ mode: "diff", basis: "task-only" });
      expect(reads).toHaveLength(0);
      expect(diffs[0]).toEqual({
        left: { kind: "text", text: "", label: "empty-new.ts" },
        right: {
          kind: "text",
          text: "export const x = 1;\n// <script>\n",
          label: "task-new.ts",
        },
      });
    }
    expect(existsSync(join(root, "src", "new.ts"))).toBe(false);
  });

  test("added patch with context lines or wrong origin is not treated as complete content", async () => {
    const { h, diffs, patches } = tracked();
    for (const patch of [
      "@@ -1,1 +1,2 @@\n keep\n+added\n",
      "@@ -0,0 +2,1 @@\n+added\n",
    ]) {
      const outcome = await openFileDiff(h, describeResult, {
        path: "src/new.ts",
        status: "added",
        patch,
      });
      expect(outcome.mode).toBe("patch");
    }
    expect(diffs).toHaveLength(0);
    expect(patches).toHaveLength(2);
  });

  test("deleted file is derived from a pure removal patch", async () => {
    const { h, diffs } = tracked();
    expect(
      await openFileDiff(h, describeResult, {
        path: "src/gone.ts",
        status: "deleted",
        patch: "--- a/src/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n",
      }),
    ).toEqual({ mode: "diff", basis: "task-only" });
    expect(diffs[0]?.left).toEqual({
      kind: "text",
      text: "a\nb\n",
      label: "before-gone.ts",
    });
  });

  test("mismatched/dirty local baseline falls back to the read-only patch", async () => {
    const { h, diffs, patches } = tracked();
    const patch = modify(
      "src/dirty.ts",
      "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n",
    );
    const outcome = await openFileDiff(h, describeResult, {
      path: "src/dirty.ts",
      status: "modified",
      patch,
    });
    expect(outcome.mode).toBe("patch");
    expect(diffs).toHaveLength(0);
    expect(patches).toEqual([patch]);
    const missing = await openFileDiff(h, describeResult, {
      path: "src/missing.ts",
      status: "modified",
      patch,
    });
    expect(missing.mode).toBe("patch");
  });

  test("binary and malformed patches are refused without opening anything", async () => {
    const { h, diffs, patches, reads } = tracked();
    for (const patch of [
      "diff --git a/src/base.ts b/src/base.ts\nBinary files a/src/base.ts and b/src/base.ts differ\n",
      "diff --git a/x b/x\nGIT binary patch\nliteral 4\nLcmZ?d00001\n",
      "@@ -1,1 +1,1 @@\n-two\u0000\n+TWO\n",
      "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n",
      "@@ -1,1 +1,1 @@\n-two\n+TWO\n+extra\n",
      "@@ -1 +1 @@\n*two\n",
      "@@ garbage @@\n-two\n",
      "just text, no hunks\n",
      "@@ -1 +1 @@\n-a\n+b\ndiff --git a/other b/other\n@@ -1 +1 @@\n-c\n+d\n",
    ]) {
      for (const status of ["added", "modified", "deleted"] as const) {
        const outcome = await openFileDiff(h, describeResult, {
          path: "src/base.ts",
          status,
          patch,
        });
        expect(outcome.mode).toBe("rejected");
      }
    }
    expect(diffs).toHaveLength(0);
    expect(patches).toHaveLength(0);
    expect(reads).toHaveLength(0);
  });

  test("unsafe paths are refused for added files too", async () => {
    const { h, diffs } = tracked();
    for (const path of ["../x.ts", "command:evil", ".git/config"]) {
      expect(
        (
          await openFileDiff(h, describeResult, {
            path,
            status: "added",
            patch: addPatch,
          })
        ).mode,
      ).toBe("rejected");
    }
    expect(diffs).toHaveLength(0);
  });
});

describe("webview boundary", () => {
  test("strict nonce CSP without network, frames or inline script", () => {
    const nonce = "abcdefghijklmnopqrstuvwxyz012345";
    const raw = buildWebviewHtml({
      cspSource: "vscode-webview://x",
      nonce,
      scriptUri: 'vscode-webview://x/webview.js"><script>alert(1)</script>',
      styleUri: "vscode-webview://x/workbench.css",
    });
    const html = raw.replaceAll("&#39;", "'");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`script-src 'nonce-${nonce}'`);
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("frame-src 'none'");
    expect(html).not.toContain("unsafe-inline");
    expect(html).not.toContain("unsafe-eval");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(isValidNonce("short")).toBe(false);
    expect(() =>
      buildWebviewHtml({
        cspSource: "x",
        nonce: "bad'nonce",
        scriptUri: "a",
        styleUri: "b",
      }),
    ).toThrow();
  });

  test("webview messages are strictly validated and cannot carry tokens or commands", () => {
    expect(WebviewMessageSchema.safeParse({ type: "ready" }).success).toBe(
      true,
    );
    for (const bad of [
      { type: "ready", token: "x" },
      { type: "runShell", command: "rm -rf /" },
      { type: "setToken", token: "secret" },
      { type: "openDiff", taskId: "t", index: -1 },
      { type: "openDiff", taskId: "t", index: 1.5 },
      {
        type: "startTask",
        taskId: "t",
        approvals: { read: true, write: true },
      },
      { type: "selectTask", taskId: "" },
      null,
      "ready",
    ])
      expect(WebviewMessageSchema.safeParse(bad).success).toBe(false);
  });
});
