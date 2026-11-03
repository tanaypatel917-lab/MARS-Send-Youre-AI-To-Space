import { afterEach, describe, expect, test } from "bun:test";
import {
  createOmniRouteProcess,
  OmniRouteProcessError,
  type SpawnedProcess,
  type SpawnRequest,
} from "./process";
import {
  type FakeOmniRoute,
  startFakeOmniRoute,
} from "./testing/fake-omniroute";

const fakes: FakeOmniRoute[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.stop()));
});

function fakeChild(onKill: (signal: string) => void): SpawnedProcess & {
  exit(code: number): void;
} {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  return {
    pid: 4242,
    exited,
    kill: onKill,
    exit: (code) => resolveExit(code),
  };
}

describe("omniroute process lifecycle", () => {
  test("attach mode uses a running instance and never spawns", async () => {
    const fake = await startFakeOmniRoute({ models: [] });
    fakes.push(fake);
    let spawned = 0;
    const proc = createOmniRouteProcess({
      mode: "attach",
      url: fake.url,
      env: {},
      spawn: () => {
        spawned += 1;
        throw new Error("unexpected spawn");
      },
    });
    expect(await proc.start()).toMatchObject({
      attached: true,
      spawned: false,
      running: true,
      pid: null,
    });
    await proc.stop();
    expect(proc.status().running).toBe(false);
    expect(spawned).toBe(0);
  });

  test("attach mode fails loudly when nothing answers", async () => {
    const proc = createOmniRouteProcess({
      mode: "attach",
      url: "http://127.0.0.1:1",
      env: {},
    });
    await expect(proc.start()).rejects.toBeInstanceOf(OmniRouteProcessError);
  });

  test("start mode refuses non-loopback URLs and version mismatches", async () => {
    const remote = createOmniRouteProcess({
      mode: "start",
      url: "http://omniroute.example:20128",
      env: {},
      fetch: async () => {
        throw new Error("offline");
      },
      spawn: () => {
        throw new Error("unexpected spawn");
      },
    });
    await expect(remote.start()).rejects.toThrow(/loopback/);
    const wrongVersion = createOmniRouteProcess({
      mode: "start",
      url: "http://127.0.0.1:1",
      env: {},
      run: async () => ({ code: 0, stdout: "omniroute 9.9.9\n" }),
      spawn: () => {
        throw new Error("unexpected spawn");
      },
    });
    await expect(wrongVersion.start()).rejects.toThrow(/3\.8\.52/);
  });

  test("start mode spawns on loopback with an allowlisted env, waits for readiness and stops gracefully", async () => {
    const requests: SpawnRequest[] = [];
    const kills: string[] = [];
    let fake: FakeOmniRoute | undefined;
    let child: ReturnType<typeof fakeChild> | undefined;
    const events: string[] = [];
    const proc = createOmniRouteProcess({
      mode: "start",
      url: "http://127.0.0.1:0",
      env: {
        PATH: "/usr/bin",
        HOME: "/home/op",
        OMNIROUTE_API_KEY: "gateway-secret",
        BRAVE_API_KEY: "mars-secret",
      },
      pollMs: 10,
      shutdownGraceMs: 50,
      run: async (request) => {
        requests.push(request);
        return { code: 0, stdout: "3.8.52\n" };
      },
      fetch: (input, init) =>
        fake
          ? fetch(input.replace("127.0.0.1:0", new URL(fake.url).host), init)
          : Promise.reject(new Error("not listening")),
      spawn: (request) => {
        requests.push(request);
        child = fakeChild((signal) => {
          kills.push(signal);
          if (signal === "SIGKILL") child?.exit(137);
        });
        void startFakeOmniRoute({ models: [] }).then((started) => {
          fakes.push(started);
          fake = started;
        });
        return child;
      },
      log: (event) => events.push(event.type),
    });
    const status = await proc.start();
    expect(status).toMatchObject({
      spawned: true,
      attached: false,
      running: true,
      pid: 4242,
    });
    expect(events).toEqual(["spawned", "ready"]);
    expect(requests[0]?.command).toEqual(["omniroute", "--version"]);
    expect(requests[1]?.command).toEqual(["omniroute"]);
    for (const request of requests) {
      expect(request.env).toEqual({
        PATH: "/usr/bin",
        HOME: "/home/op",
        PORT: "0",
        HOST: "127.0.0.1",
        HOSTNAME: "127.0.0.1",
      });
      expect(JSON.stringify(request.env)).not.toContain("secret");
    }
    await proc.stop();
    // SIGTERM was ignored by the fake child, so the grace period escalated.
    expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(proc.status().running).toBe(false);
    expect(events.at(-1)).toBe("stopped");
  });

  test("start mode reports a child that exits before answering", async () => {
    const proc = createOmniRouteProcess({
      mode: "start",
      url: "http://127.0.0.1:1",
      env: {},
      pollMs: 10,
      startupTimeoutMs: 500,
      run: async () => ({ code: 0, stdout: "3.8.52" }),
      spawn: () => {
        const child = fakeChild(() => {});
        child.exit(1);
        return child;
      },
    });
    await expect(proc.start()).rejects.toThrow(/exited during startup/);
  });
});
