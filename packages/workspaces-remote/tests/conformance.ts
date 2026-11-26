import { describe, expect, test } from "bun:test";
import type { RequestContext, WorkspaceRef } from "@mars/contracts";
import type {
  ArtifactStore,
  LocalWorkspaceProvider,
  WorkspaceLimits,
} from "@mars/workspaces";

/**
 * The workspace provider contract, as executable assertions. The same suite
 * runs against the local provider and the remote provider (through the FAKE
 * Agent Server), so "same contract" is a test result, not a claim.
 */
export interface ConformanceFixture {
  provider: Omit<LocalWorkspaceProvider, "search">;
  artifacts: ArtifactStore;
  /** Change a file behind the provider's back (local tree or remote host). */
  tamper(
    context: RequestContext,
    workspace: WorkspaceRef,
    path: string,
    content: string,
  ): Promise<void>;
  close(): Promise<void>;
}

export type FixtureFactory = (options?: {
  limits?: Partial<WorkspaceLimits>;
}) => Promise<ConformanceFixture>;

export const SOURCE_FILES: Record<string, string> = {
  "README.md": "hello\n",
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": "export const b = 2;\n",
  ".env": "SECRET=do-not-copy\n",
};

export const context: RequestContext = {
  schema_version: 1,
  scope: { owner_id: "owner-conf", project_id: "project-conf" },
  request_id: "req-conf",
};
const otherOwner: RequestContext = {
  ...context,
  scope: { owner_id: "someone-else", project_id: "project-conf" },
};
const budget = (ms = 10_000) => ({
  max_tokens: 1,
  max_usd: 0,
  max_duration_ms: ms,
  max_depth: 1,
  max_concurrency: 1,
});
const text = (value: string) => new TextEncoder().encode(value);

async function readText(
  fx: ConformanceFixture,
  ws: WorkspaceRef,
  path: string,
): Promise<string> {
  const ref = await fx.provider.read(context, ws, path);
  return new TextDecoder().decode(await fx.artifacts.get(context, ref));
}

async function writeText(
  fx: ConformanceFixture,
  ws: WorkspaceRef,
  path: string,
  value: string,
  executable?: boolean,
) {
  const ref = await fx.artifacts.put(context, text(value), "text/plain");
  await fx.provider.write(
    context,
    ws,
    path,
    ref,
    executable === undefined ? undefined : { executable },
  );
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).name;
  }
  return "resolved";
}

export function defineProviderConformance(
  name: string,
  factory: FixtureFactory,
): void {
  const withFixture =
    (
      fn: (fx: ConformanceFixture) => Promise<void>,
      limits?: Partial<WorkspaceLimits>,
    ) =>
    async () => {
      const fx = await factory(limits ? { limits } : undefined);
      try {
        await fn(fx);
      } finally {
        await fx.close();
      }
    };
  const T = 30_000;

  describe(`workspace provider conformance: ${name}`, () => {
    test(
      "prepare is idempotent per task, scoped, and revisioned",
      withFixture(async (fx) => {
        const first = await fx.provider.prepare(context, "task-a");
        const again = await fx.provider.prepare(context, "task-a");
        const other = await fx.provider.prepare(context, "task-b");
        expect(again).toEqual(first);
        expect(other.workspace_id).not.toBe(first.workspace_id);
        expect(first.provider).toBe(fx.provider.providerId);
        expect(first.revision).toMatch(/^0\.[a-f0-9]{16}$/);
        expect(await fx.provider.discover(context, "task-a")).toEqual(first);
        expect(await fx.provider.discover(context, "task-missing")).toBeNull();
        expect(
          await code(fx.provider.inspect(otherOwner, first.workspace_id)),
        ).toBe("not_found");
        expect(
          await code(fx.provider.read(otherOwner, first, "README.md")),
        ).toBe("not_found");
        expect(await code(fx.provider.prepare(context, "../bad"))).toBe(
          "policy",
        );
      }),
      T,
    );

    test(
      "secrets never enter the workspace; reads enforce path policy",
      withFixture(async (fx) => {
        const ws = await fx.provider.prepare(context, "task-read");
        expect(await readText(fx, ws, "src/a.ts")).toBe(
          SOURCE_FILES["src/a.ts"] ?? "",
        );
        expect(await code(fx.provider.read(context, ws, "missing.txt"))).toBe(
          "not_found",
        );
        expect(await code(fx.provider.read(context, ws, "../outside"))).toBe(
          "policy",
        );
        expect(await code(fx.provider.read(context, ws, "/etc/passwd"))).toBe(
          "policy",
        );
        expect(await code(fx.provider.read(context, ws, ".env"))).toBe(
          "policy",
        );
        expect(await code(fx.provider.read(context, ws, "src"))).toBe("policy");
        expect(await fx.provider.skipped(context, ws)).toContainEqual({
          path: ".env",
          reason: "ignored-secret",
        });
      }),
      T,
    );

    test(
      "write and remove advance the revision and show in the diff",
      withFixture(async (fx) => {
        const ws = await fx.provider.prepare(context, "task-write");
        await writeText(fx, ws, "src/new/c.sh", "echo c\n", true);
        await writeText(fx, ws, "README.md", "changed\n");
        await fx.provider.remove(context, ws, "src/b.ts");
        const after = await fx.provider.inspect(context, ws.workspace_id);
        expect(after.revision).toMatch(/^3\./);
        expect(await readText(fx, after, "README.md")).toBe("changed\n");
        const diff = await fx.provider.diff(context, after);
        expect(diff.files.map((file) => [file.path, file.status])).toEqual([
          ["README.md", "modified"],
          ["src/b.ts", "deleted"],
          ["src/new/c.sh", "added"],
        ]);
        expect(diff.files[2]?.patch).toContain("new file mode 100755");
        expect(await code(fx.provider.remove(context, after, "src/b.ts"))).toBe(
          "not_found",
        );
        expect(await code(fx.provider.remove(context, after, "src"))).toBe(
          "policy",
        );
        expect(await code(writeText(fx, after, ".env", "x"))).toBe("policy");
        expect(await code(writeText(fx, after, "../escape", "x"))).toBe(
          "policy",
        );
        expect(await code(writeText(fx, after, "src/a.ts/child", "x"))).toBe(
          "policy",
        );
      }),
      T,
    );

    test(
      "write enforces size limits",
      withFixture(
        async (fx) => {
          const ws = await fx.provider.prepare(context, "task-limit");
          expect(await code(writeText(fx, ws, "big.txt", "x".repeat(65)))).toBe(
            "limit_exceeded",
          );
        },
        { maxFileBytes: 64 },
      ),
      T,
    );

    test(
      "execute runs argv in the workspace and reconciles changes",
      withFixture(async (fx) => {
        const ws = await fx.provider.prepare(context, "task-exec");
        const result = await fx.provider.execute(
          context,
          ws,
          [
            "sh",
            "-c",
            "printf out; printf err >&2; echo made > made.txt; cat src/a.ts >/dev/null; exit 3",
          ],
          budget(),
        );
        expect(result.exit_code).toBe(3);
        expect(
          new TextDecoder().decode(
            await fx.artifacts.get(context, result.stdout),
          ),
        ).toBe("out");
        expect(
          new TextDecoder().decode(
            await fx.artifacts.get(context, result.stderr),
          ),
        ).toBe("err");
        expect(result.timed_out).toBe(false);
        expect(result.cancelled).toBe(false);
        expect(result.workspace.revision).toMatch(/^1\./);
        expect(await readText(fx, result.workspace, "made.txt")).toBe("made\n");
        expect(await code(fx.provider.execute(context, ws, [], budget()))).toBe(
          "policy",
        );
        const quoted = await fx.provider.execute(
          context,
          result.workspace,
          ["printf", "%s", "a'b $(x) `y`"],
          budget(),
        );
        expect(
          new TextDecoder().decode(
            await fx.artifacts.get(context, quoted.stdout),
          ),
        ).toBe("a'b $(x) `y`");
      }),
      T,
    );

    test(
      "execute output is bounded and marked truncated",
      withFixture(
        async (fx) => {
          const ws = await fx.provider.prepare(context, "task-bound");
          const result = await fx.provider.execute(
            context,
            ws,
            ["sh", "-c", "head -c 5000 /dev/zero | tr '\\0' a"],
            budget(),
          );
          expect(result.stdout.byte_length).toBe(1024);
          expect(result.stdout_truncated).toBe(true);
        },
        { maxOutputBytes: 1024 },
      ),
      T,
    );

    test(
      "execute times out with 124 and cancels with 130",
      withFixture(async (fx) => {
        const ws = await fx.provider.prepare(context, "task-time");
        const timed = await fx.provider.execute(
          context,
          ws,
          ["sleep", "20"],
          budget(300),
        );
        expect(timed.exit_code).toBe(124);
        expect(timed.timed_out).toBe(true);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 200);
        const cancelled = await fx.provider.execute(
          context,
          timed.workspace,
          ["sleep", "20"],
          budget(),
          {
            signal: controller.signal,
          },
        );
        expect(cancelled.exit_code).toBe(130);
        expect(cancelled.cancelled).toBe(true);
        const running = fx.provider.execute(
          context,
          cancelled.workspace,
          ["sleep", "20"],
          budget(),
        );
        await Bun.sleep(300);
        await fx.provider.stop(context, cancelled.workspace);
        const stopped = await running;
        expect(stopped.cancelled).toBe(true);
      }),
      T,
    );

    test(
      "checkpoint and restore are revision fenced and exact",
      withFixture(async (fx) => {
        const ws = await fx.provider.prepare(context, "task-ckpt");
        await writeText(fx, ws, "README.md", "v1\n");
        const v1 = await fx.provider.inspect(context, ws.workspace_id);
        const checkpoint = await fx.provider.checkpoint(context, v1);
        expect(checkpoint.workspace).toEqual(v1);
        await writeText(fx, v1, "README.md", "v2\n");
        await writeText(fx, v1, "extra/file.txt", "x\n");
        const v2 = await fx.provider.inspect(context, ws.workspace_id);
        expect(
          await code(fx.provider.restore(context, checkpoint, v1.revision)),
        ).toBe("revision_conflict");
        const restored = await fx.provider.restore(
          context,
          checkpoint,
          v2.revision,
        );
        expect(restored.revision.split(".")[1]).toBe(v1.revision.split(".")[1]);
        expect(Number(restored.revision.split(".")[0])).toBeGreaterThan(
          Number(v2.revision.split(".")[0]),
        );
        expect(await readText(fx, restored, "README.md")).toBe("v1\n");
        expect(
          await code(fx.provider.read(context, restored, "extra/file.txt")),
        ).toBe("not_found");
        const list = await fx.provider.checkpoints(context, restored);
        expect(list.map((entry) => entry.checkpoint_id)).toContain(
          checkpoint.checkpoint_id,
        );
        expect(list.length).toBe(2);
        const baseline = list[0];
        if (!baseline) throw new Error("no baseline");
        const back = await fx.provider.restore(
          context,
          baseline,
          restored.revision,
        );
        expect((await fx.provider.diff(context, back)).files).toEqual([]);
      }),
      T,
    );

    test(
      "runCheck runs on a disposable copy of the exact candidate",
      withFixture(async (fx) => {
        const ws = await fx.provider.prepare(context, "task-check");
        await writeText(fx, ws, "src/a.ts", "export const a = 42;\n");
        const candidate = await fx.provider.inspect(context, ws.workspace_id);
        const result = await fx.provider.runCheck(context, candidate, {
          argv: [
            "sh",
            "-c",
            "cat src/a.ts; cat check.sh; test ! -e src/b.ts && echo excluded; echo junk > junk.txt",
          ],
          overlay: [{ path: "check.sh", data: text("protected\n") }],
          exclude: ["src/b.ts"],
          timeoutMs: 10_000,
        });
        expect(result.exit_code).toBe(0);
        expect(new TextDecoder().decode(result.stdout)).toBe(
          "export const a = 42;\nprotected\nexcluded\n",
        );
        expect(result.output_truncated).toBe(false);
        expect(result.workspace).toEqual(candidate);
        expect(await fx.provider.inspect(context, ws.workspace_id)).toEqual(
          candidate,
        );
        expect(
          await code(fx.provider.read(context, candidate, "junk.txt")),
        ).toBe("not_found");
        expect(
          await code(
            fx.provider.runCheck(context, ws, {
              argv: ["true"],
              overlay: [],
              timeoutMs: 1000,
            }),
          ),
        ).toBe("revision_conflict");
      }),
      T,
    );

    test(
      "runCheck marks bounded stderr as truncated",
      withFixture(
        async (fx) => {
          const ws = await fx.provider.prepare(context, "task-bound-check");
          const result = await fx.provider.runCheck(context, ws, {
            argv: ["sh", "-c", "head -c 5000 /dev/zero | tr '\\0' a >&2"],
            overlay: [],
            timeoutMs: 10_000,
          });
          expect(result.exit_code).toBe(0);
          expect(result.stderr.byteLength).toBe(1024);
          expect(result.output_truncated).toBe(true);
        },
        { maxOutputBytes: 1024 },
      ),
      T,
    );

    test(
      "exportPatch reproduces the exact tested candidate",
      withFixture(async (fx) => {
        const ws = await fx.provider.prepare(context, "task-export");
        await writeText(fx, ws, "src/a.ts", "export const a = 7;\n");
        await writeText(fx, ws, "docs/new.md", "# new\n");
        const candidate = await fx.provider.inspect(context, ws.workspace_id);
        const exported = await fx.provider.exportPatch(context, candidate);
        expect(exported.workspace).toEqual(candidate);
        expect(exported.files).toBe(2);
        expect(exported.round_trip).toEqual({ status: "passed", reason: null });
        expect(new TextDecoder().decode(exported.patch)).toContain(
          "+export const a = 7;",
        );
        expect(await code(fx.provider.exportPatch(context, ws))).toBe(
          "revision_conflict",
        );
        const collected = await fx.provider.collect(context, candidate);
        expect(collected[0]?.media_type).toBe("text/x-diff; charset=utf-8");
        expect(collected[0]?.sha256).toBe(
          new Bun.CryptoHasher("sha256").update(exported.patch).digest("hex"),
        );
        expect(collected.length).toBe(3);
      }),
      T,
    );

    test(
      "out-of-band changes are detected, never silently exported",
      withFixture(async (fx) => {
        const ws = await fx.provider.prepare(context, "task-tamper");
        await fx.tamper(context, ws, "README.md", "tampered\n");
        expect(await code(fx.provider.exportPatch(context, ws))).toBe(
          "workspace_modified",
        );
        expect(
          await code(
            fx.provider.runCheck(context, ws, {
              argv: ["true"],
              overlay: [],
              timeoutMs: 1000,
            }),
          ),
        ).toBe("workspace_modified");
      }),
      T,
    );

    test(
      "symlinks created by commands are skipped and never followed",
      withFixture(async (fx) => {
        const ws = await fx.provider.prepare(context, "task-link");
        const result = await fx.provider.execute(
          context,
          ws,
          ["ln", "-s", "/etc", "link"],
          budget(),
        );
        expect(
          await code(fx.provider.read(context, result.workspace, "link")),
        ).toBe("policy");
        expect(
          await code(
            fx.provider.read(context, result.workspace, "link/passwd"),
          ),
        ).toBe("policy");
        expect(await code(writeText(fx, result.workspace, "link/x", "x"))).toBe(
          "policy",
        );
      }),
      T,
    );

    test(
      "a closed provider fails closed",
      withFixture(async (fx) => {
        const ws = await fx.provider.prepare(context, "task-closed");
        await fx.provider.close();
        expect(await code(fx.provider.read(context, ws, "README.md"))).toBe(
          "sandbox_unavailable",
        );
      }),
      T,
    );
  });
}
