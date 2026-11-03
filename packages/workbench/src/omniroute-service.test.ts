import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelRegistry } from "@mars/providers";
import {
  type SpawnedProcess,
  startFakeOmniRoute,
} from "@mars/providers-omniroute";
import { createWorkbenchService } from "./service";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "mars-omniroute-service-"));
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const source = join(base, "source");
  const home = join(base, "home");
  await mkdir(source);
  await mkdir(join(home, ".mars"), { recursive: true });
  await writeFile(
    join(home, ".mars", "models.json"),
    JSON.stringify({ version: 1, providers: [], models: [] }),
  );
  const registry = await loadModelRegistry({ cwd: source, home, env: {} });
  return {
    source,
    state: join(base, "state"),
    registry,
    scope: { owner_id: "owner", project_id: "project" },
  };
}

test("mars serve attaches to a running OmniRoute, discovers with one GET and stops with the service", async () => {
  const fake = await startFakeOmniRoute({
    apiKey: "gateway-key",
    models: [{ id: "deepseek/deepseek-v4-pro", tool_calling: true }],
  });
  cleanup.push(() => fake.stop());
  const f = await fixture();
  const service = await createWorkbenchService({
    sourceRoot: f.source,
    stateRoot: f.state,
    scope: f.scope,
    registry: f.registry,
    port: 0,
    omniroute: {
      url: fake.url,
      env: { OMNIROUTE_API_KEY: "gateway-key" },
      spawn: () => {
        throw new Error("attach mode must not spawn");
      },
    },
  });
  expect(service.omniroute).toMatchObject({
    mode: "attach",
    attached: true,
    spawned: false,
    running: true,
  });
  expect(
    fake.requests.map((request) => `${request.method} ${request.path}`),
  ).toEqual(["GET /v1/models", "GET /v1/models"]);
  for (const request of fake.requests) {
    expect(request.headers["x-mars-paid-consent"]).toBe("absent");
    expect(request.headers.authorization).toBe("<redacted>");
  }
  expect(
    fake.requests.some((request) => request.path.startsWith("/api/")),
  ).toBe(false);
  await service.close();
});

test("mars serve --omniroute-start spawns the pinned gateway on loopback and kills it on close", async () => {
  const f = await fixture();
  let fakeUrl: string | undefined;
  const kills: string[] = [];
  let resolveExit!: (code: number) => void;
  const child: SpawnedProcess = {
    pid: 777,
    exited: new Promise<number>((resolve) => {
      resolveExit = resolve;
    }),
    kill: (signal) => {
      kills.push(signal);
      resolveExit(0);
    },
  };
  const spawned: string[][] = [];
  const service = await createWorkbenchService({
    sourceRoot: f.source,
    stateRoot: f.state,
    scope: f.scope,
    registry: f.registry,
    port: 0,
    omniroute: {
      url: "http://127.0.0.1:0",
      start: true,
      env: { PATH: "/usr/bin", HOME: "/home/op", SECRET: "mars-secret" },
      run: async () => ({ code: 0, stdout: "3.8.52\n" }),
      fetch: (input, init) =>
        fakeUrl
          ? fetch(input.replace("127.0.0.1:0", new URL(fakeUrl).host), init)
          : Promise.reject(new Error("not up")),
      spawn: (request) => {
        spawned.push(request.command);
        expect(request.env).toEqual({
          PATH: "/usr/bin",
          HOME: "/home/op",
          PORT: "0",
          HOST: "127.0.0.1",
          HOSTNAME: "127.0.0.1",
        });
        void startFakeOmniRoute({ models: [] }).then((fake) => {
          cleanup.push(() => fake.stop());
          fakeUrl = fake.url;
        });
        return child;
      },
    },
  });
  expect(spawned).toEqual([["omniroute"]]);
  expect(service.omniroute).toMatchObject({
    mode: "start",
    spawned: true,
    pid: 777,
    running: true,
  });
  await service.close();
  expect(kills).toEqual(["SIGTERM"]);
});

test("an unreachable OmniRoute in attach mode fails service startup cleanly", async () => {
  const f = await fixture();
  await expect(
    createWorkbenchService({
      sourceRoot: f.source,
      stateRoot: f.state,
      scope: f.scope,
      registry: f.registry,
      port: 0,
      omniroute: { url: "http://127.0.0.1:1", env: {} },
    }),
  ).rejects.toThrow(/No OmniRoute instance answers/);
});
