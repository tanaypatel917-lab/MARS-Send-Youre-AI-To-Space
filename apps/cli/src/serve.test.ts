import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entrypoint = join(import.meta.dir, "main.ts");
test("mars serve starts without model credentials, keeps its token private and closes cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-cli-serve-"));
  const source = join(root, "source");
  const state = join(root, "state");
  await mkdir(source);
  const child = Bun.spawn(
    [
      process.execPath,
      entrypoint,
      "serve",
      "--source",
      source,
      "--state",
      state,
      "--port",
      "0",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: {
        PATH: process.env.PATH,
        HOME: root,
        MARS_HOME: join(root, "models"),
      },
    },
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = child.stdout.getReader();
    let output = "";
    const ready = (async () => {
      while (!output.includes("\n")) {
        const part = await reader.read();
        if (part.done) throw new Error("CLI exited before ready");
        output += new TextDecoder().decode(part.value);
        if (output.length > 16384) throw new Error("Unexpected startup output");
      }
    })();
    await Promise.race([
      ready,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("CLI did not start")),
          20000,
        );
      }),
    ]);
    const report = JSON.parse(output);
    expect(report.status).toBe("listening");
    expect(report.execute_enabled).toBe(false);
    expect(report.connection_file).toBe(join(state, "connection.json"));
    const connection = JSON.parse(
      await readFile(report.connection_file, "utf8"),
    );
    expect(/^[A-Za-z0-9_-]{43}$/.test(connection.token)).toBe(true);
    expect(output.includes(connection.token)).toBe(false);
    expect((await stat(report.connection_file)).mode & 0o777).toBe(0o600);
    const response = await fetch(`${report.url}/v1/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "workbench.describe", params: {} }),
    });
    expect(response.status).toBe(200);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(
      await Bun.file(join(state, "workspaces", "provider.lock")).exists(),
    ).toBe(false);
  } finally {
    if (timeout) clearTimeout(timeout);
    child.kill("SIGKILL");
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("mars serve sanitizes startup errors without echoing host paths", async () => {
  const privatePath = join(
    tmpdir(),
    `missing-private-source-${crypto.randomUUID()}`,
  );
  const child = Bun.spawn(
    [process.execPath, entrypoint, "serve", "--source", privatePath],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const [output, error, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(1);
  expect(output).toBe("");
  expect(error).toContain("could not start or stop safely");
  expect(error).not.toContain(privatePath);
}, 30000);

test("mars serve --research-search refuses to start without the named credential and names only the variable", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-cli-research-"));
  const source = join(root, "source");
  await mkdir(source);
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        entrypoint,
        "serve",
        "--source",
        source,
        "--state",
        join(root, "state"),
        "--port",
        "0",
        "--research-search",
        "brave",
        "--research-api-key-env",
        "MARS_TEST_SEARCH_KEY",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: {
          PATH: process.env.PATH,
          HOME: root,
          MARS_HOME: join(root, "models"),
        },
      },
    );
    const [output, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).toBe(1);
    expect(output).toBe("");
    expect(error).toContain("MARS_TEST_SEARCH_KEY");
    expect(error).not.toContain(root);
    expect(await Bun.file(join(root, "state", "research")).exists()).toBe(
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("mars serve --research-search starts the research worker with a configured free model and shuts down cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-cli-research-"));
  const source = join(root, "source");
  const state = join(root, "state");
  const marsHome = join(root, "models");
  await mkdir(source);
  await mkdir(marsHome);
  await Bun.write(
    join(marsHome, "models.json"),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
        },
      ],
      models: [
        {
          id: "fixture/free",
          providerId: "fixture",
          model: "stub",
          capabilities: { tools: true, vision: false, contextWindow: 32768 },
          pricing: { free: true },
        },
      ],
      routes: { default: ["fixture/free"] },
    }),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      entrypoint,
      "serve",
      "--source",
      source,
      "--state",
      state,
      "--port",
      "0",
      "--research-search",
      "brave",
      "--research-deny-host",
      "*.internal.example",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: {
        PATH: process.env.PATH,
        HOME: root,
        MARS_HOME: marsHome,
        BRAVE_SEARCH_API_KEY: "dummy-not-live",
      },
    },
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = child.stdout.getReader();
    let output = "";
    const ready = (async () => {
      while (!output.includes("\n")) {
        const part = await reader.read();
        if (part.done) throw new Error("CLI exited before ready");
        output += new TextDecoder().decode(part.value);
        if (output.length > 16384) throw new Error("Unexpected startup output");
      }
    })();
    await Promise.race([
      ready,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("CLI did not start")),
          20000,
        );
      }),
    ]);
    const report = JSON.parse(output);
    expect(report.status).toBe("listening");
    expect(report.research).toEqual({ search: "brave", live: true });
    expect(output.includes("dummy-not-live")).toBe(false);
    expect((await stat(join(state, "research"))).mode & 0o077).toBe(0);
    expect(
      await Bun.file(join(state, "research", "research.sqlite")).exists(),
    ).toBe(true);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(await new Response(child.stderr).text()).toBe("");
  } finally {
    if (timeout) clearTimeout(timeout);
    child.kill("SIGKILL");
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("mars serve --help documents the research flags without making requests", async () => {
  const child = Bun.spawn([process.execPath, entrypoint, "serve", "--help"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [output, error, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(0);
  expect(error).toBe("");
  expect(output).toContain("--research-search brave|searxng|tavily");
  expect(output).toContain("BRAVE_SEARCH_API_KEY");
}, 30000);
