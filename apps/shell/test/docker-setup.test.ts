import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { dockerPullOptions, ensureDockerImage } from "../src/main/docker-setup";

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
    const options = dockerPullOptions(
      join(directory, "docker"),
      undefined,
      "/home/user",
      { PATH: path },
    );
    expect(Bun.which(name, { PATH: options.env.PATH })).toBe(helper);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
