import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadModelRegistry, ModelRouter } from "@mars/providers";

const entrypoint = resolve(import.meta.dir, "main.ts");

async function runCli(args: string[], marsHome: string, cwd?: string) {
  const child = Bun.spawn([process.execPath, entrypoint, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      MARS_HOME: marsHome,
      MARS_TRUST_PROJECT_CONFIG: "0",
      CLI_TEST_SECRET: "never-output-this",
    },
    ...(cwd ? { cwd } : {}),
  });
  const [output, errors, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { output, errors, exit };
}

test("CLI adds a provider and model, then lists them without printing key values", async () => {
  const marsHome = await mkdtemp(join(tmpdir(), "mars-cli-models-"));
  const projectDirectory = await mkdtemp(join(tmpdir(), "mars-cli-project-"));
  try {
    const addProvider = await runCli(
      [
        "models",
        "add-provider",
        "--id",
        "custom",
        "--base-url",
        "https://models.example/v1",
        "--api-key-env",
        "CLI_TEST_SECRET",
      ],
      marsHome,
      projectDirectory,
    );
    expect(addProvider.exit).toBe(0);
    expect(addProvider.errors).toBe("");
    expect(addProvider.output).toContain('"added": "custom"');

    const addModel = await runCli(
      [
        "models",
        "add",
        "--provider",
        "custom",
        "--model",
        "example-model",
        "--id",
        "custom/example",
        "--tools",
        "--context",
        "32768",
      ],
      marsHome,
      projectDirectory,
    );
    expect(addModel.exit).toBe(0);
    expect(addModel.errors).toBe("");
    expect(addModel.output).toContain('"added": "custom/example"');

    const registry = await loadModelRegistry({
      cwd: projectDirectory,
      env: { MARS_HOME: marsHome },
    });
    expect(registry.getModel("custom/example")?.pricing.free).toBe(false);
    await expect(
      new ModelRouter(registry).complete(
        { messages: [{ role: "user", content: "Hello" }] },
        { model: "custom/example" },
      ),
    ).rejects.toMatchObject({
      name: "NoModelAvailableError",
      message: expect.stringContaining("allowPaid=false"),
    });

    const paidOnlyList = await runCli(
      ["models", "list", "--free"],
      marsHome,
      projectDirectory,
    );
    expect(paidOnlyList.exit).toBe(0);
    expect(paidOnlyList.output).not.toContain('"id": "custom/example"');

    const attestFree = await runCli(
      [
        "models",
        "add",
        "--provider",
        "custom",
        "--model",
        "example-model",
        "--id",
        "custom/example",
        "--tools",
        "--context",
        "32768",
        "--free",
        "--force",
      ],
      marsHome,
      projectDirectory,
    );
    expect(attestFree.exit).toBe(0);

    const list = await runCli(
      ["models", "list", "--free"],
      marsHome,
      projectDirectory,
    );
    expect(list.exit).toBe(0);
    expect(list.errors).toBe("");
    expect(list.output).toContain('"id": "custom/example"');
    expect(list.output).not.toContain("never-output-this");

    const providers = await runCli(
      ["models", "providers"],
      marsHome,
      projectDirectory,
    );
    expect(providers.exit).toBe(0);
    expect(providers.output).toContain('"apiKeyEnv": "CLI_TEST_SECRET"');
    expect(providers.output).not.toContain("never-output-this");

    const stored = await readFile(join(marsHome, "models.json"), "utf8");
    expect(stored).toContain('"apiKeyEnv": "CLI_TEST_SECRET"');
    expect(stored).not.toContain("never-output-this");
  } finally {
    await rm(marsHome, { recursive: true, force: true });
    await rm(projectDirectory, { recursive: true, force: true });
  }
}, 30_000);

test("CLI warns when an untrusted project model file is ignored", async () => {
  const marsHome = await mkdtemp(join(tmpdir(), "mars-cli-home-"));
  const projectDirectory = await mkdtemp(join(tmpdir(), "mars-cli-project-"));
  try {
    const projectConfig = join(projectDirectory, ".mars");
    await mkdir(projectConfig, { recursive: true });
    await writeFile(
      join(projectConfig, "models.json"),
      JSON.stringify({
        version: 1,
        providers: [],
        models: [],
        policy: { allowPaid: true },
      }),
    );
    const result = await runCli(["models", "list"], marsHome, projectDirectory);
    expect(result.exit).toBe(0);
    expect(result.errors).toContain("Ignoring untrusted project model config");
    expect(result.errors).toContain("--trust-project");
    expect(result.output).not.toContain('"id": "project/model"');

    const trusted = await runCli(
      ["models", "--trust-project", "list"],
      marsHome,
      projectDirectory,
    );
    expect(trusted.exit).toBe(0);
    expect(trusted.errors).not.toContain(
      "Ignoring untrusted project model config",
    );
    expect(trusted.errors).toContain(
      "Notice: Ignored project policy.allowPaid",
    );

    const help = await runCli(["models", "help"], marsHome, projectDirectory);
    expect(help.output).toContain("--trust-project");
    expect(help.output).toContain("[--free]");
  } finally {
    await rm(marsHome, { recursive: true, force: true });
    await rm(projectDirectory, { recursive: true, force: true });
  }
});
