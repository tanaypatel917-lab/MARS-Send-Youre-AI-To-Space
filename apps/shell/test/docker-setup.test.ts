import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { VERIFICATION_SANDBOX_SETUP } from "@mars/contracts";
import { resolveDockerPath } from "../src/main/docker-path";
import {
  dockerPullOptions,
  ensureDockerImage,
  sandboxRefreshState,
} from "../src/main/docker-setup";
import { loadFixtureData } from "./test-utils";

test("a pull loads the user's Docker configuration but pins the daemon to the resolved local endpoint", () => {
  const options = dockerPullOptions(
    "/usr/bin/docker",
    "unix:///run/docker.sock",
    "/home/user",
    {
      DOCKER_CONFIG: "/home/user/custom-docker",
      DOCKER_CONTEXT: "remote",
      DOCKER_HOST: "ssh://remote",
      PATH: "/usr/bin",
    },
  );
  expect(options).toMatchObject({
    args: ["--host", "unix:///run/docker.sock"],
    env: {
      DOCKER_CONFIG: "/home/user/custom-docker",
      HOME: "/home/user",
    },
  });
  expect(Object.keys(options.env).sort()).toEqual([
    "DOCKER_CONFIG",
    "HOME",
    "PATH",
  ]);
  expect(options.env.PATH.split(delimiter)).toContain("/opt/homebrew/bin");
});

test("a desktop pull can find a credential helper beside the resolved Docker executable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-docker-helper-"));
  try {
    const name = "docker-credential-mars-test";
    const helper = join(directory, name);
    await writeFile(helper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const path = "/usr/bin:/bin";
    expect(Bun.which(name, { PATH: path })).toBeNull();
    const docker = join(directory, "docker");
    await writeFile(docker, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const desktopPath = [directory, path].join(delimiter);
    const executable = resolveDockerPath({ path: desktopPath });
    expect(executable).toBe(docker);
    if (!executable) throw new Error("Docker not found");
    const options = dockerPullOptions(executable, undefined, "/home/user", {
      PATH: path,
    });
    expect(Bun.which(name, { PATH: options.env.PATH })).toBe(helper);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a desktop launch without Docker on PATH adds the Docker Desktop fallback helper directory", () => {
  const path = "/usr/bin:/bin";
  const fallback = "/Applications/Docker.app/Contents/Resources/bin";
  const executable = resolveDockerPath({
    path,
    isExecutable: (candidate) => candidate === join(fallback, "docker"),
  });
  expect(executable).toBe(join(fallback, "docker"));
  if (!executable) throw new Error("Docker not found");
  expect(path.split(delimiter)).not.toContain(fallback);
  expect(
    dockerPullOptions(executable, undefined, "/home/user", {
      PATH: path,
    }).env.PATH.split(delimiter),
  ).toContain(fallback);
});

test("an already downloaded sandbox does not prompt or download again", async () => {
  const calls: string[][] = [];
  const status = await ensureDockerImage(
    "example@sha256:digest",
    async (args) => {
      calls.push(args);
      return true;
    },
    async () => {
      throw new Error("An installed image should not prompt");
    },
  );
  expect(status).toBe("present");
  expect(calls).toEqual([["image", "inspect", "example@sha256:digest"]]);
});

test("only stale sandbox readiness with no running tasks can be refreshed", async () => {
  const fixture = await loadFixtureData();
  const task = fixture.tasks[0];
  if (!task) throw new Error("Missing fixture task");
  const calls: unknown[] = [];
  const setup = VERIFICATION_SANDBOX_SETUP;
  const check = (
    status: "ready" | "unavailable",
    taskStatus: "running" | "completed",
    dockerChanged = false,
  ) =>
    sandboxRefreshState(
      {
        async call(method) {
          calls.push(method);
          return {
            ok: true,
            result:
              method === "workbench.describe"
                ? {
                    ...fixture.describe,
                    verification_readiness: {
                      status,
                      reason: "Fixture",
                      setup,
                    },
                  }
                : [{ ...task, status: taskStatus }],
          };
        },
      },
      dockerChanged,
    );
  expect(await check("ready", "running")).toBe("ready");
  expect(calls.splice(0)).toEqual(["workbench.describe"]);
  expect(await check("unavailable", "running")).toBe("busy");
  expect(calls.splice(0)).toEqual(["workbench.describe", "tasks.list"]);
  expect(await check("unavailable", "completed")).toBe("idle");
  expect(await check("ready", "running", true)).toBe("busy");
  expect(await check("ready", "completed", true)).toBe("idle");
});
