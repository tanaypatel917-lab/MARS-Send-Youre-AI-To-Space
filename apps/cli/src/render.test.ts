import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entrypoint = resolve(import.meta.dir, "main.ts");

const SAMPLE = `Here is the draft.

:::writing{id="48213" variant="email" subject="Launch timing" recipient="ada@example.com"}
::tone[Formal]
Dear Ada, the window opens Thursday.
::tone[Casual]
Hi Ada, Thursday it is.
:::

Notify with [$Crew](app://slack).

- :mars-followup[Send it]{prompt="Send writing block 48213 using the Formal tone"}
- :mars-followup[Shorten it]{prompt="Rewrite block 48213 in two sentences"}
`;

async function run(
  args: string[],
  stdin?: string,
): Promise<{ output: string; errors: string; exit: number }> {
  const child = Bun.spawn([process.execPath, entrypoint, "render", ...args], {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, errors, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { output, errors, exit };
}

async function withSampleFile<T>(
  body: (file: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "mars-cli-render-"));
  try {
    const file = join(directory, "output.md");
    await writeFile(file, SAMPLE);
    return await body(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("render reads a file and prints frames, follow-ups and proposals; exit 0 despite format errors", async () => {
  await withSampleFile(async (file) => {
    const { output, errors, exit } = await run([
      file,
      "--address",
      "ada@example.com",
    ]);
    expect(exit).toBe(0);
    expect(errors).toBe("");
    expect(output).toContain("Here is the draft.");
    expect(output).toContain("│ email #48213");
    expect(output).toContain("│ ── Formal ──");
    expect(output).toContain("│ ── Casual ──");
    expect(output).toContain(
      "Follow-ups\n  1. Send it\n     prompt: Send writing block 48213 using the Formal tone\n  2. Shorten it\n     prompt: Rewrite block 48213 in two sentences",
    );
    expect(output).toContain(
      'App trigger "$Crew": connector slack (line 10) — rejected (unknown_connector)',
    );
    expect(output).toContain("Format errors\n  - line 10 [unknown_connector]");
    expect(output).not.toContain("invented_address");
  });
}, 30_000);

test("render reads stdin and accepts registered connectors and addresses", async () => {
  const { output, errors, exit } = await run(
    ["--connectors", "slack,calendar", "--address", "ada@example.com"],
    SAMPLE,
  );
  expect(exit).toBe(0);
  expect(errors).toBe("");
  expect(output).toContain('App trigger "$Crew": connector slack (line 10)\n');
  expect(output).not.toContain("rejected");
  expect(output).not.toContain("Format errors");
}, 30_000);

test("render --json prints the processed document", async () => {
  const { output, errors, exit } = await run(["--json"], SAMPLE);
  expect(exit).toBe(0);
  expect(errors).toBe("");
  const processed = JSON.parse(output);
  expect(processed.ok).toBe(false);
  expect(processed.document.format_version).toBe(1);
  expect(processed.document.app_triggers).toEqual([
    { label: "$Crew", connector_id: "slack", line: 10 },
  ]);
  expect(processed.errors.map((error: { code: string }) => error.code)).toEqual(
    ["invented_address", "unknown_connector"],
  );
}, 30_000);

test("render --follow-up N prints only the hidden prompt", async () => {
  await withSampleFile(async (file) => {
    const { output, errors, exit } = await run([file, "--follow-up", "2"]);
    expect(exit).toBe(0);
    expect(errors).toBe("");
    expect(output).toBe("Rewrite block 48213 in two sentences\n");
  });
}, 30_000);

test("render --follow-up out of range fails with exit 1 and nothing on stdout", async () => {
  const { output, errors, exit } = await run(["--follow-up", "3"], SAMPLE);
  expect(exit).toBe(1);
  expect(output).toBe("");
  expect(errors).toContain("Follow-up 3 does not exist");
}, 30_000);

test("render rejects unknown flags and missing files with exit 1", async () => {
  const unknown = await run(["--bogus"], SAMPLE);
  expect(unknown.exit).toBe(1);
  expect(unknown.output).toBe("");
  expect(unknown.errors).toContain("--bogus");
  const missing = await run([join(tmpdir(), "mars-cli-render-missing.md")]);
  expect(missing.exit).toBe(1);
  expect(missing.output).toBe("");
  expect(missing.errors).toContain("Cannot read");
}, 30_000);
