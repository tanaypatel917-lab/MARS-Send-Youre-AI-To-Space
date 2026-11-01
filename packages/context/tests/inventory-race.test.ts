import { expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContextConfinementUnavailableError,
  createRepositoryMapProvider,
} from "../src";
import { inventory, inventoryWithProcFdRootForTest } from "../src/inventory";
import { DEFAULT_REPOSITORY_MAP_LIMITS } from "../src/provider";
import { context, workspace } from "./helpers";

const source = "export function InsideOnly() {}\n";
const outsideSource = "export function OutsideSentinel() {}\n";
const request = { workspace, max_output_tokens: 1_000 };

test("provider stays contained when a directory is swapped at any now callback", async () => {
  const base = await mkdtemp(join(tmpdir(), "mars-context-race-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  const sourceDirectory = join(root, "src");
  const outsideFile = join(outside, "sentinel.ts");
  const setup = async (movedPath: string) => {
    await rm(sourceDirectory, { recursive: true, force: true });
    await rm(movedPath, { recursive: true, force: true });
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(join(sourceDirectory, "inside.ts"), source);
  };
  try {
    mkdirSync(sourceDirectory, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(sourceDirectory, "inside.ts"), source);
    writeFileSync(outsideFile, outsideSource);

    let dryRunCalls = 0;
    const dryRunProvider = createRepositoryMapProvider({
      resolveRoot: async () => ({ root, revision: workspace.revision }),
      now: () => {
        dryRunCalls += 1;
        return 0;
      },
    });
    await dryRunProvider.map(context, request);
    await dryRunProvider.close();
    expect(dryRunCalls).toBeGreaterThan(0);

    for (let swapAt = 1; swapAt <= dryRunCalls; swapAt += 1) {
      const movedPath = join(base, `moved-now-${swapAt}`);
      await setup(movedPath);
      let calls = 0;
      let swapped = false;
      const provider = createRepositoryMapProvider({
        resolveRoot: async () => ({ root, revision: workspace.revision }),
        now: () => {
          calls += 1;
          if (calls === swapAt && !swapped) {
            swapped = true;
            renameSync(sourceDirectory, movedPath);
            symlinkSync(outside, sourceDirectory);
          }
          return 0;
        },
      });
      let result: Awaited<ReturnType<typeof provider.map>> | undefined;
      let failure: unknown;
      try {
        result = await provider.map(context, request);
      } catch (error) {
        failure = error;
      } finally {
        await provider.close();
      }
      expect(swapped).toBe(true);
      if (result) {
        const serialized = JSON.stringify(result);
        expect(
          !serialized.includes("OutsideSentinel") &&
            !serialized.includes("sentinel.ts") &&
            !serialized.includes(outside) &&
            !serialized.includes(root),
        ).toBe(true);
      } else {
        const message = failure instanceof Error ? failure.message : "";
        expect(
          !message.includes("OutsideSentinel") &&
            !message.includes("sentinel.ts") &&
            !message.includes(outside) &&
            !message.includes(root),
        ).toBe(true);
      }
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);

test("inventory stays contained when a directory is swapped at any check callback", async () => {
  const base = await mkdtemp(join(tmpdir(), "mars-context-check-race-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  const sourceDirectory = join(root, "src");
  const setup = async (movedPath: string) => {
    await rm(sourceDirectory, { recursive: true, force: true });
    await rm(movedPath, { recursive: true, force: true });
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(join(sourceDirectory, "inside.ts"), source);
  };
  const options = (check: () => void) => ({
    root,
    confinement: "anchored" as const,
    limits: DEFAULT_REPOSITORY_MAP_LIMITS,
    previous: new Map(),
    check,
  });
  try {
    mkdirSync(sourceDirectory, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(sourceDirectory, "inside.ts"), source);
    writeFileSync(join(outside, "sentinel.ts"), outsideSource);
    let dryRunCalls = 0;
    await inventory(
      options(() => {
        dryRunCalls += 1;
      }),
    );
    expect(dryRunCalls).toBeGreaterThan(0);

    for (let swapAt = 1; swapAt <= dryRunCalls; swapAt += 1) {
      const movedPath = join(base, `moved-check-${swapAt}`);
      await setup(movedPath);
      let calls = 0;
      let swapped = false;
      const outcome = await inventory(
        options(() => {
          calls += 1;
          if (calls === swapAt && !swapped) {
            swapped = true;
            renameSync(sourceDirectory, movedPath);
            symlinkSync(outside, sourceDirectory);
          }
        }),
      ).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      expect(swapped).toBe(true);
      if ("result" in outcome) {
        const serialized = JSON.stringify(outcome.result.files);
        expect(
          !serialized.includes("OutsideSentinel") &&
            !serialized.includes("sentinel.ts") &&
            !serialized.includes(outside) &&
            !serialized.includes(root),
        ).toBe(true);
      } else {
        const message =
          outcome.error instanceof Error ? outcome.error.message : "";
        expect(
          !message.includes("OutsideSentinel") &&
            !message.includes("sentinel.ts") &&
            !message.includes(outside) &&
            !message.includes(root),
        ).toBe(true);
      }
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);

test("rejects a fake proc-fd root before traversal", async () => {
  const base = await mkdtemp(join(tmpdir(), "mars-context-no-proc-"));
  const root = join(base, "root");
  const fakeProcFdRoot = join(base, "fake-fd");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(fakeProcFdRoot);
    writeFileSync(join(root, "src", "inside.ts"), source);
    let checks = 0;
    let fakeFdLinkIsSymlink = false;
    const error = await inventoryWithProcFdRootForTest(
      {
        root,
        confinement: "anchored",
        limits: DEFAULT_REPOSITORY_MAP_LIMITS,
        previous: new Map(),
        check: () => {
          checks += 1;
        },
      },
      (rootFd) => {
        const fakeFdLink = join(fakeProcFdRoot, String(rootFd));
        symlinkSync(root, fakeFdLink);
        fakeFdLinkIsSymlink = lstatSync(fakeFdLink).isSymbolicLink();
        return fakeProcFdRoot;
      },
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ContextConfinementUnavailableError);
    expect(fakeFdLinkIsSymlink).toBe(true);
    expect(checks).toBe(0);
    const message = error instanceof Error ? error.message : "";
    expect(!message.includes("InsideOnly") && !message.includes(root)).toBe(
      true,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("best-effort confinement maps a normal workspace", async () => {
  const base = await mkdtemp(join(tmpdir(), "mars-context-best-effort-"));
  const root = join(base, "root");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "inside.ts"), source);
    const provider = createRepositoryMapProvider({
      resolveRoot: async () => ({ root, revision: workspace.revision }),
      confinement: "best-effort",
    });
    try {
      const result = await provider.map(context, request);
      expect(result.text).toContain("InsideOnly");
      expect(result.stats.skipped.symlink).toBe(0);
    } finally {
      await provider.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
