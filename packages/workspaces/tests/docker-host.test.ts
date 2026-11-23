import { expect, test } from "bun:test";
import { isLocalDockerHost } from "../src/docker-host";
import { resolveDockerConfig, sandboxEnvironment } from "../src/sandbox";

const image = `mirror.gcr.io/library/busybox@sha256:${"a".repeat(64)}`;
const user = { uid: 1000, gid: 1000 };

test.each([
  "unix:///var/run/docker.sock",
  "unix:///Users/user/.colima/default/docker.sock",
])("local Docker socket is validated and forwarded: %s", (dockerHost) => {
  const resolved = resolveDockerConfig({ image, user, dockerHost });
  expect(sandboxEnvironment(resolved)).toEqual({
    PATH: "/usr/bin:/bin",
    HOME: "/nonexistent",
    DOCKER_HOST: dockerHost,
  });
});

test.each([
  "",
  "tcp://localhost:2375",
  "https://docker.example",
  "ssh://user@localhost",
  "unix://relative/socket",
  "unix:///socket?remote=true",
  "unix:///socket\n",
  "unix:///socket\0",
])("non-local or malformed Docker endpoints are refused: %s", (dockerHost) => {
  expect(() => resolveDockerConfig({ image, user, dockerHost })).toThrow(
    "dockerHost must be a local unix socket or Windows named pipe",
  );
  expect(() => sandboxEnvironment({ dockerHost })).toThrow();
});

test("named pipes are accepted only on Windows", () => {
  const host = "npipe:////./pipe/docker_engine";
  expect(isLocalDockerHost(host, "win32")).toBe(true);
  expect(isLocalDockerHost(host, "darwin")).toBe(false);
  expect(isLocalDockerHost(host, "linux")).toBe(false);
  expect(isLocalDockerHost("npipe://remote/pipe/docker_engine", "win32")).toBe(
    false,
  );
});

test("sandbox Docker environment does not implicitly inherit the user's endpoint or home", () => {
  expect(sandboxEnvironment(resolveDockerConfig({ image, user }))).toEqual({
    PATH: "/usr/bin:/bin",
    HOME: "/nonexistent",
  });
});
