import { parseArgs } from "node:util";
import { followUps, processOutput, renderTerminal } from "@mars/output-format";

const USAGE =
  "Usage: mars render [file] [--connectors id1,id2] [--address a@b.com]... [--follow-up N] [--json] [--width N] [--color]\nReads MARS Output Format text from FILE or stdin and prints it for a terminal. Nothing is executed: follow-ups, app triggers and review links are listed as proposals. --follow-up N prints only the hidden prompt of follow-up N.";

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed < 1)
    throw new Error(`--${name} must be a positive integer.`);
  return parsed;
}

async function readInput(file: string | undefined): Promise<string> {
  if (file !== undefined) {
    const source = Bun.file(file);
    if (!(await source.exists())) throw new Error(`Cannot read "${file}".`);
    return source.text();
  }
  if (process.stdin.isTTY)
    throw new Error("No input: pass a file or pipe model output on stdin.");
  return Bun.stdin.text();
}

export async function runRender(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      connectors: { type: "string" },
      address: { type: "string", multiple: true },
      "follow-up": { type: "string" },
      json: { type: "boolean" },
      width: { type: "string" },
      color: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length > 1)
    throw new Error(`Pass at most one input file.\n${USAGE}`);
  const text = await readInput(positionals[0]);
  const processed = processOutput(text, {
    connector_ids: (values.connectors ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
    allowed_addresses: values.address ?? [],
  });
  if (values["follow-up"] !== undefined) {
    const index = positiveInteger(values["follow-up"], "follow-up");
    const choices = followUps(processed.document);
    const chosen = choices[index - 1];
    if (!chosen)
      throw new Error(
        `Follow-up ${index} does not exist; the output has ${choices.length} follow-up(s).`,
      );
    console.log(chosen.prompt);
    return;
  }
  if (values.json) {
    console.log(JSON.stringify(processed, null, 2));
    return;
  }
  process.stdout.write(
    renderTerminal(processed.document, {
      errors: processed.errors,
      ...(values.width !== undefined
        ? { width: positiveInteger(values.width, "width") }
        : {}),
      ...(values.color ? { color: true } : {}),
    }),
  );
}
