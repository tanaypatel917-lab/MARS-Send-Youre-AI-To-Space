import { expect, test } from "bun:test";
import { resolveDockerHost } from "../src/main/docker-host";

test("explicit DOCKER_HOST wins over the user's Docker context", async () => {
  expect(
    await resolveDockerHost("/custom/docker", {
      env: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" },
      inspect: async () => {
        throw new Error("must not inspect");
      },
    }),
  ).toBe("unix:///run/user/1000/docker.sock");
});

test("Docker context inspection uses the resolved executable and accepts local endpoints", async () => {
  const paths: string[] = [];
  expect(
    await resolveDockerHost("/custom/docker", {
      env: {},
      inspect: async (path) => {
        paths.push(path);
        return "unix:///Users/user/.colima/default/docker.sock";
      },
    }),
  ).toBe("unix:///Users/user/.colima/default/docker.sock");
  expect(paths).toEqual(["/custom/docker"]);
});

test("no CLI or failed context inspection leaves the endpoint unset", async () => {
  expect(await resolveDockerHost(undefined, { env: {} })).toBeUndefined();
  expect(
    await resolveDockerHost("/custom/docker", {
      env: {},
      inspect: async () => {
        throw new Error("unavailable");
      },
    }),
  ).toBeUndefined();
});

test.each(["tcp://localhost:2375", "ssh://remote", "unix://relative", ""])(
  "desktop never forwards invalid Docker endpoint %s",
  async (host) => {
    expect(
      await resolveDockerHost("/custom/docker", { env: { DOCKER_HOST: host } }),
    ).toBeUndefined();
    expect(
      await resolveDockerHost("/custom/docker", {
        env: {},
        inspect: async () => host,
      }),
    ).toBeUndefined();
  },
);
