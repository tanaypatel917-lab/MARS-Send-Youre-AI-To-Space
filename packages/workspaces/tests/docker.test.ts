import { expect, test } from "bun:test";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createDockerSandbox, type LocalWorkspaceProvider } from "../src";
import { artifactText, budget, context, first, makeFixture } from "./helpers";

const defaultImage =
  "mirror.gcr.io/library/busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec";
const image = process.env.MARS_WORKSPACES_TEST_IMAGE ?? defaultImage;

const dockerAvailable = await (async () => {
  try {
    await access("/usr/bin/docker", constants.X_OK);
    const child = Bun.spawn(["/usr/bin/docker", "image", "inspect", image], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent" },
    });
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 5000);
    try {
      return (await child.exited) === 0;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
})();

function budgetMs(milliseconds: number) {
  return { ...budget, max_duration_ms: milliseconds };
}

async function makeDockerFixture(options: { outputBytes?: number } = {}) {
  return makeFixture({
    runner: createDockerSandbox({
      image,
      pids: 128,
      maxFileBytes: 10 * 1024 * 1024,
    }),
    ...(options.outputBytes === undefined
      ? {}
      : { limits: { maxOutputBytes: options.outputBytes } }),
  });
}

async function execute(
  provider: LocalWorkspaceProvider,
  workspace: Awaited<ReturnType<typeof makeDockerFixture>>["workspace"],
  argv: readonly string[],
  durationMs = 5000,
) {
  return provider.execute(context, workspace, argv, budgetMs(durationMs));
}

async function dockerPs(workspaceId: string): Promise<string> {
  const child = Bun.spawn(
    [
      "/usr/bin/docker",
      "ps",
      "-a",
      "--filter",
      `label=mars.workspace=${workspaceId}`,
      "-q",
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent" },
    },
  );
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  if ((await child.exited) !== 0) throw new Error(`docker ps failed: ${error}`);
  return output.trim();
}

async function waitForContainer(workspaceId: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await dockerPs(workspaceId)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("No real workspace container became visible");
}

test.skipIf(!dockerAvailable)(
  "[real container] non-root user, read-only root, disabled network, and host environment isolation",
  async () => {
    const fixture = await makeDockerFixture();
    process.env.MARS_DUMMY_SECRET = "dummy-not-a-secret";
    try {
      const identity = await execute(fixture.provider, fixture.workspace, [
        "id",
        "-u",
      ]);
      expect(
        Number((await artifactText(fixture.artifacts, identity.stdout)).trim()),
      ).toBeGreaterThan(0);

      const readonly = await execute(fixture.provider, identity.workspace, [
        "touch",
        "/etc/x",
      ]);
      expect(readonly.exit_code).not.toBe(0);

      const network = await execute(fixture.provider, readonly.workspace, [
        "wget",
        "-T",
        "2",
        "-q",
        "-O-",
        "http://1.1.1.1",
      ]);
      expect(network.exit_code).not.toBe(0);

      const environment = await execute(fixture.provider, network.workspace, [
        "env",
      ]);
      expect(
        await artifactText(fixture.artifacts, environment.stdout),
      ).not.toContain("MARS_DUMMY_SECRET");
    } finally {
      delete process.env.MARS_DUMMY_SECRET;
      await fixture.close();
    }
  },
  30_000,
);

test.skipIf(!dockerAvailable)(
  "[real container] writable workspace bind mount, diff, and configured pids limit",
  async () => {
    const fixture = await makeDockerFixture();
    try {
      const baseline = first(
        await fixture.provider.checkpoints(context, fixture.workspace),
      );
      const wrote = await execute(fixture.provider, fixture.workspace, [
        "sh",
        "-c",
        "echo hi > made.txt",
      ]);
      const tree = join(
        fixture.rootDir,
        "workspaces",
        fixture.workspace.workspace_id,
        "tree",
      );
      expect(await Bun.file(join(tree, "made.txt")).text()).toBe("hi\n");
      const diff = await fixture.provider.diff(context, wrote.workspace, {
        base: baseline,
      });
      expect(
        diff.files.map(({ path, status }) => [path, status]),
      ).toContainEqual(["made.txt", "added"]);

      const pids = await execute(fixture.provider, wrote.workspace, [
        "cat",
        "/sys/fs/cgroup/pids.max",
      ]);
      expect((await artifactText(fixture.artifacts, pids.stdout)).trim()).toBe(
        "128",
      );
    } finally {
      await fixture.close();
    }
  },
  30_000,
);

test.skipIf(!dockerAvailable)(
  "[real container] timeout kills the container and returns within the bounded deadline",
  async () => {
    const fixture = await makeDockerFixture();
    try {
      const started = Date.now();
      const result = await execute(
        fixture.provider,
        fixture.workspace,
        ["sh", "-c", "sleep 100 & sleep 100"],
        1500,
      );
      expect(result.timed_out).toBe(true);
      expect(result.exit_code).toBe(124);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(await dockerPs(fixture.workspace.workspace_id)).toBe("");
    } finally {
      await fixture.close();
    }
  },
  30_000,
);

test.skipIf(!dockerAvailable)(
  "[real container] stop cancels a running container and waits for cleanup",
  async () => {
    const fixture = await makeDockerFixture();
    try {
      const execution = execute(
        fixture.provider,
        fixture.workspace,
        ["sleep", "100"],
        20_000,
      );
      await waitForContainer(fixture.workspace.workspace_id);
      await fixture.provider.stop(context, fixture.workspace);
      const result = await execution;
      expect(result.cancelled).toBe(true);
      expect(result.exit_code).toBe(130);
      expect(await dockerPs(fixture.workspace.workspace_id)).toBe("");
    } finally {
      await fixture.close();
    }
  },
  30_000,
);

test.skipIf(!dockerAvailable)(
  "[real container] stdout is drained but bounded and marked truncated",
  async () => {
    const fixture = await makeDockerFixture({ outputBytes: 1000 });
    try {
      const result = await execute(fixture.provider, fixture.workspace, [
        "sh",
        "-c",
        "yes | head -c 3000000",
      ]);
      expect(
        (await fixture.artifacts.get(context, result.stdout)).byteLength,
      ).toBe(1000);
      expect(result.stdout_truncated).toBe(true);
      expect(await dockerPs(fixture.workspace.workspace_id)).toBe("");
    } finally {
      await fixture.close();
    }
  },
  30_000,
);
