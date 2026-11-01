import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestContext } from "@mars/contracts";
import {
  ContextCancelledError,
  ContextClosedError,
  ContextIoError,
  ContextLimitError,
  ContextPolicyError,
  ContextRevisionError,
  conservativeTokenCounter,
  createRepositoryMapProvider,
} from "../src";
import { context, providerFor, putFile, tempRoot, workspace } from "./helpers";

const extraRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    extraRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("repository map provider", () => {
  test("cold and warm maps are cached while every file is reread", async () => {
    const root = await tempRoot();
    await putFile(root, "a.ts", "export function one() { return 1; }\n");
    await putFile(
      root,
      "b.ts",
      "import { one } from './a'; export const two = one();\n",
    );
    let tokenCountCalls = 0;
    const provider = providerFor(root, {
      tokenCounter: {
        id: "tracked-token-counter",
        count(text) {
          tokenCountCalls += 1;
          return conservativeTokenCounter.count(text);
        },
      },
    });
    const cold = await provider.map(context, {
      workspace,
      max_output_tokens: 200,
    });
    const coldCountCalls = tokenCountCalls;
    const warm = await provider.map(context, {
      workspace,
      max_output_tokens: 200,
    });
    expect(tokenCountCalls).toBe(coldCountCalls);
    const changedQuery = await provider.map(context, {
      workspace,
      query: "two",
      max_output_tokens: 200,
    });
    expect(cold.stats.files_parsed).toBe(2);
    expect(cold.stats.map_cache_hit).toBe(false);
    expect(warm.stats.map_cache_hit).toBe(true);
    expect(warm.stats.files_parsed).toBe(0);
    expect(warm.stats.files_reused).toBe(2);
    expect(changedQuery.stats.map_cache_hit).toBe(false);
    expect(changedQuery.stats.files_reused).toBe(2);
  });

  test("map cache hits refresh inventory-derived fields", async () => {
    const root = await tempRoot();
    await putFile(root, ".gitignore", "ignored.ts\n");
    await putFile(root, "a.ts", "export function one() { return 1; }\n");
    const provider = providerFor(root);
    const request = { workspace, max_output_tokens: 200 };
    const first = await provider.map(context, request);
    expect(first.stats.skipped.gitignored).toBe(0);

    await putFile(
      root,
      "ignored.ts",
      "export function hidden() { return 2; }\n",
    );
    const second = await provider.map(context, request);

    expect(second.stats.map_cache_hit).toBe(true);
    expect(second.stats.skipped.gitignored).toBe(1);
    expect(second.stats.files_inventoried).toBe(1);
    expect(second.stats.files_parsed).toBe(0);
    expect(second.stats.files_reused).toBe(1);
    expect(second.complete).toBe(first.complete);
  });

  test("packs 1,500 TypeScript files with five exported functions within budget", async () => {
    const root = await tempRoot();
    await Promise.all(
      Array.from({ length: 1_500 }, (_, index) =>
        writeFile(
          join(root, `module-${String(index).padStart(4, "0")}.ts`),
          Array.from(
            { length: 5 },
            (_, functionIndex) =>
              `export function module${index}Function${functionIndex}(value: number) { return value + ${index + functionIndex}; }`,
          ).join("\n"),
        ),
      ),
    );
    const result = await providerFor(root).map(context, {
      workspace,
      max_output_tokens: 65_536,
    });
    expect(result.token_count).toBeLessThanOrEqual(65_536);
    expect(result.stats.files_inventoried).toBe(1_500);
  }, 30_000);

  test("detects same-size content edits and add/delete invalidation", async () => {
    const root = await tempRoot();
    const file = join(root, "a.ts");
    await putFile(root, "a.ts", "export const firstName = 1;\n");
    const provider = providerFor(root);
    const before = await provider.map(context, {
      workspace,
      max_output_tokens: 300,
    });
    const oldStat = await (await import("node:fs/promises")).stat(file);
    await writeFile(file, "export const otherName = 1;\n");
    await utimes(file, oldStat.atime, oldStat.mtime);
    const edited = await provider.map(context, {
      workspace,
      max_output_tokens: 300,
    });
    expect(edited.content_digest).not.toBe(before.content_digest);
    expect(edited.stats.files_parsed).toBe(1);
    expect(edited.text).toContain("otherName");
    await putFile(root, "b.ts", "export function addedSymbol() {}\n");
    const added = await provider.map(context, {
      workspace,
      max_output_tokens: 500,
    });
    expect(added.text).toContain("addedSymbol");
    await (await import("node:fs/promises")).rm(join(root, "b.ts"));
    const deleted = await provider.map(context, {
      workspace,
      max_output_tokens: 500,
    });
    expect(deleted.text).not.toContain("addedSymbol");
    expect(deleted.stats.files_inventoried).toBe(1);
  });

  test("scopes invalidation to owner and project", async () => {
    const root = await tempRoot();
    await putFile(root, "a.ts", "export const retainedSymbol = 1;\n");
    const provider = providerFor(root);
    const otherContext: RequestContext = {
      ...context,
      scope: {
        owner_id: "owner-2",
        project_id: "project-1",
        workspace_id: "ws-1",
      },
    };
    await provider.map(context, { workspace, max_output_tokens: 200 });
    await provider.map(otherContext, { workspace, max_output_tokens: 200 });
    await provider.invalidate(
      context,
      { workspace_id: workspace.workspace_id },
      ["a.ts"],
    );
    const unaffected = await provider.map(otherContext, {
      workspace,
      max_output_tokens: 200,
    });
    expect(unaffected.stats.map_cache_hit).toBe(true);
    const invalidated = await provider.map(context, {
      workspace,
      max_output_tokens: 200,
    });
    expect(invalidated.stats.map_cache_hit).toBe(false);
    expect(invalidated.stats.files_parsed).toBe(1);
    await provider.invalidate(context, {
      workspace_id: workspace.workspace_id,
    });
    const otherWarm = await provider.map(otherContext, {
      workspace,
      max_output_tokens: 200,
    });
    const ownerCold = await provider.map(context, {
      workspace,
      max_output_tokens: 200,
    });
    expect(otherWarm.stats.map_cache_hit).toBe(true);
    expect(ownerCold.stats.map_cache_hit).toBe(false);
    expect(ownerCold.stats.files_parsed).toBe(1);
  });

  test("invalidates descendants when a directory path is supplied", async () => {
    const root = await tempRoot();
    await putFile(root, "src/a.ts", "export const firstSymbol = 1;\n");
    await putFile(root, "src/nested/b.ts", "export const secondSymbol = 2;\n");
    const provider = providerFor(root);
    await provider.map(context, { workspace, max_output_tokens: 300 });
    await provider.invalidate(
      context,
      { workspace_id: workspace.workspace_id },
      ["src"],
    );
    const result = await provider.map(context, {
      workspace,
      query: "changed map key",
      max_output_tokens: 300,
    });
    expect(result.stats.files_parsed).toBe(2);
  });

  test("rejects invalid paths, scope mismatch, resolver rejection, and revision mismatch without leaks", async () => {
    const root = await tempRoot();
    const rootRealPath = await realpath(root);
    const provider = providerFor(root);
    const errors: Error[] = [];
    for (const path of [
      "../x",
      "/etc/passwd",
      "a\\b",
      "C:/x",
      "a/./b",
      `bad${String.fromCharCode(1)}name`,
    ]) {
      const error = (await provider
        .map(context, {
          workspace,
          mentioned_files: [path],
          max_output_tokens: 20,
        })
        .catch((caught: Error) => caught)) as Error;
      expect(error).toBeInstanceOf(ContextPolicyError);
      errors.push(error);
    }
    const wrongScope = {
      ...context,
      scope: { ...context.scope, workspace_id: "different" },
    };
    const wrongScopeError = (await provider
      .map(wrongScope, { workspace, max_output_tokens: 20 })
      .catch((caught: Error) => caught)) as Error;
    expect(wrongScopeError).toBeInstanceOf(ContextPolicyError);
    errors.push(wrongScopeError);
    const rejectProvider = createRepositoryMapProvider({
      resolveRoot: async () => {
        throw new Error(root);
      },
    });
    const rejected = (await rejectProvider
      .map(context, { workspace, max_output_tokens: 20 })
      .catch((error: Error) => error)) as Error;
    expect(rejected).toBeInstanceOf(ContextPolicyError);
    errors.push(rejected);
    const revisionProvider = createRepositoryMapProvider({
      resolveRoot: async () => ({ root, revision: "wrong-revision" }),
    });
    const revisionError = (await revisionProvider
      .map(context, { workspace, max_output_tokens: 20 })
      .catch((caught: Error) => caught)) as Error;
    expect(revisionError).toBeInstanceOf(ContextRevisionError);
    errors.push(revisionError);
    const ioProvider = createRepositoryMapProvider({
      resolveRoot: async () => ({
        root: join(root, "missing-root"),
        revision: workspace.revision,
      }),
    });
    const ioError = (await ioProvider
      .map(context, { workspace, max_output_tokens: 20 })
      .catch((caught: Error) => caught)) as Error;
    expect(ioError).toBeInstanceOf(ContextIoError);
    errors.push(ioError);
    for (const error of errors) {
      expect(error.message).not.toContain(root);
      expect(JSON.stringify(error)).not.toContain(rootRealPath);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  test("does not expose private, ignored, generated, binary, large, or symlinked code", async () => {
    const root = await tempRoot();
    const outside = await mkdtemp(join(tmpdir(), "mars-context-outside-"));
    extraRoots.push(outside);
    await putFile(root, ".env", "export const envSentinel = 1;\n");
    await putFile(root, "id_rsa.ts", "export const keySentinel = 1;\n");
    await putFile(root, ".ssh/x.ts", "export const sshSentinel = 1;\n");
    await putFile(
      root,
      "node_modules/x.ts",
      "export const dependencySentinel = 1;\n",
    );
    await putFile(
      root,
      ".mars/x.ts",
      "export const privateStateSentinel = 1;\n",
    );
    await putFile(root, ".omp/x.ts", "export const ompSentinel = 1;\n");
    await putFile(root, "dist/x.ts", "export const distSentinel = 1;\n");
    await putFile(root, "x.min.js", "export const minifiedSentinel = 1;\n");
    await putFile(
      root,
      "generated.ts",
      "/* @generated */\nexport const generatedSentinel = 1;\n",
    );
    await putFile(
      root,
      "secret.ts",
      "-----BEGIN PRIVATE KEY-----\nexport const privateKeySentinel = 1;\n",
    );
    await putFile(
      root,
      "nul.ts",
      new Uint8Array([0, 101, 120, 112, 111, 114, 116]),
    );
    await putFile(root, "large.ts", "x".repeat(160));
    await putFile(outside, "outside.ts", "export const outsideSentinel = 1;\n");
    await symlink(join(outside, "outside.ts"), join(root, "symlink.ts"));
    await symlink(outside, join(root, "linked-dir"));
    const provider = providerFor(root, {
      limits: { maxFileBytes: 128 },
    });
    const result = await provider.map(context, {
      workspace,
      max_output_tokens: 300,
    });
    for (const sentinel of [
      "envSentinel",
      "keySentinel",
      "sshSentinel",
      "dependencySentinel",
      "privateStateSentinel",
      "ompSentinel",
      "distSentinel",
      "minifiedSentinel",
      "generatedSentinel",
      "privateKeySentinel",
      "outsideSentinel",
    ]) {
      expect(result.text).not.toContain(sentinel);
    }
    expect(result.stats.skipped.secret).toBeGreaterThanOrEqual(3);
    expect(result.stats.skipped.symlink).toBe(2);
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain(outside);
  });

  test("honors inventory limits, cancellation, timeout, and close", async () => {
    const root = await tempRoot();
    await putFile(root, "a.ts", "export const alpha = 1;\n");
    await putFile(root, "b.ts", "export const bravo = 1;\n");
    const limited = providerFor(root, { limits: { maxFiles: 1 } });
    const first = await limited.map(context, {
      workspace,
      max_output_tokens: 500,
    });
    expect(first.complete).toBe(false);
    expect(first.stats.skipped.limit).toBe(1);
    const byteLimited = providerFor(root, { limits: { maxTotalBytes: 1 } });
    const byteResult = await byteLimited.map(context, {
      workspace,
      max_output_tokens: 500,
    });
    expect(byteResult.complete).toBe(false);
    expect(byteResult.stats.skipped.limit).toBe(1);
    const entryLimited = providerFor(root, {
      limits: { maxDirectoryEntries: 1 },
    });
    const entryResult = await entryLimited.map(context, {
      workspace,
      max_output_tokens: 500,
    });
    expect(entryResult.complete).toBe(false);
    expect(entryResult.stats.skipped.limit).toBe(1);
    const controller = new AbortController();
    controller.abort();
    const cancelled = (await limited
      .map(
        context,
        { workspace, max_output_tokens: 500 },
        { signal: controller.signal },
      )
      .catch((error: Error) => error)) as Error;
    expect(cancelled).toBeInstanceOf(ContextCancelledError);

    let clock = 0;
    const timeout = providerFor(root, {
      now: () => clock++,
      limits: { timeoutMs: 1 },
    });
    const timedOut = (await timeout
      .map(context, { workspace, max_output_tokens: 500 })
      .catch((error: Error) => error)) as Error;
    expect(timedOut).toBeInstanceOf(ContextLimitError);
    await limited.close();
    const closed = (await limited
      .map(context, { workspace, max_output_tokens: 500 })
      .catch((error: Error) => error)) as Error;
    expect(closed).toBeInstanceOf(ContextClosedError);
    for (const error of [cancelled, timedOut, closed]) {
      expect(error.message).not.toContain(root);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  test("does not poison cache after a cancellation during walking", async () => {
    const root = await tempRoot();
    await putFile(root, "a.ts", "export const alpha = 1;\n");
    await putFile(root, "b.ts", "export const bravo = 1;\n");
    const controller = new AbortController();
    let calls = 0;
    const provider = providerFor(root, {
      limits: { timeoutMs: 100_000 },
      now: () => {
        calls += 1;
        if (calls === 5) controller.abort();
        return 0;
      },
    });
    await expect(
      provider.map(
        context,
        { workspace, max_output_tokens: 500 },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(ContextCancelledError);
    const recovered = await provider.map(context, {
      workspace,
      max_output_tokens: 500,
    });
    expect(recovered.stats.files_parsed).toBe(2);
  });

  test("does not cache scans whose workspace revision changes before return", async () => {
    const root = await tempRoot();
    await putFile(root, "a.ts", "export function alpha() { return 1; }\n");
    let resolveCalls = 0;
    const provider = createRepositoryMapProvider({
      resolveRoot: async () => {
        resolveCalls += 1;
        return {
          root,
          revision: resolveCalls === 2 ? "revision-b" : "revision-a",
        };
      },
    });
    const request = {
      workspace: { ...workspace, revision: "revision-a" },
      max_output_tokens: 500,
    };
    await expect(provider.map(context, request)).rejects.toBeInstanceOf(
      ContextRevisionError,
    );
    const recovered = await provider.map(context, request);
    expect(recovered.stats.map_cache_hit).toBe(false);
    expect(recovered.stats.files_parsed).toBe(1);
  });

  test("token count and returned tree never disclose local paths", async () => {
    const root = await tempRoot();
    await putFile(
      root,
      "example.ts",
      "export function sample() { return true; }\n",
    );
    const provider = providerFor(root);
    const result = await provider.map(context, {
      workspace,
      max_output_tokens: 200,
    });
    expect(result.token_count).toBe(
      conservativeTokenCounter.count(result.text),
    );
    expect(JSON.stringify(result)).not.toContain(root);
  });
});
