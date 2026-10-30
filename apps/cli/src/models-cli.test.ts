import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entrypoint = resolve(import.meta.dir, "main.ts");

async function runCli(args: string[], marsHome: string) {
  const child = Bun.spawn([process.execPath, entrypoint, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      MARS_HOME: marsHome,
      CLI_TEST_SECRET: "never-output-this",
    },
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
    );
    expect(addModel.exit).toBe(0);
    expect(addModel.errors).toBe("");
    expect(addModel.output).toContain('"added": "custom/example"');

    const list = await runCli(["models", "list", "--free"], marsHome);
    expect(list.exit).toBe(0);
    expect(list.errors).toBe("");
    expect(list.output).toContain('"id": "custom/example"');
    expect(list.output).not.toContain("never-output-this");

    const providers = await runCli(["models", "providers"], marsHome);
    expect(providers.exit).toBe(0);
    expect(providers.output).toContain('"apiKeyEnv": "CLI_TEST_SECRET"');
    expect(providers.output).not.toContain("never-output-this");

    const stored = await readFile(join(marsHome, "models.json"), "utf8");
    expect(stored).toContain('"apiKeyEnv": "CLI_TEST_SECRET"');
    expect(stored).not.toContain("never-output-this");
  } finally {
    await rm(marsHome, { recursive: true, force: true });
  }
}, 30_000);
