import { expect, test } from "bun:test";
import { dockerPullOptions, ensureDockerImage } from "../src/main/docker-setup";

test("a pull loads the user's Docker configuration but pins the daemon to the resolved local endpoint", () => {
  const options = dockerPullOptions("unix:///run/docker.sock", "/home/user", {
    DOCKER_CONFIG: "/home/user/custom-docker",
    DOCKER_CONTEXT: "remote",
    DOCKER_HOST: "ssh://remote",
    PATH: "/usr/bin",
  });
  expect(options).toEqual({
    args: ["--host", "unix:///run/docker.sock"],
    env: {
      DOCKER_CONFIG: "/home/user/custom-docker",
      PATH: "/usr/bin",
      HOME: "/home/user",
    },
  });
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
