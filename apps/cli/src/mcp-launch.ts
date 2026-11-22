import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stderr, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  resolveStdioExecutable,
  type StdioTransportConfig,
} from "@mars/mcp-client";
import { CliUsageError } from "./cli-errors";

type Layout = NonNullable<StdioTransportConfig["launch"]>;
export const LAUNCH_WARNING =
  "MARS protects the selected program files. Your data stays writable. System libraries, programs downloaded at startup, and code loaded from outside the selected folders are not protected.";

export function layout(
  config: StdioTransportConfig,
  kinds: string[],
  commandRoot?: string,
  pinCwd?: boolean,
): Layout {
  if (kinds.length !== config.args.length)
    throw new CliUsageError(
      "Choose --arg-kind once per --arg, in order: text, data, file, or folder:<program folder>.",
    );
  return {
    version: 1,
    ...(commandRoot ? { command_root: commandRoot } : {}),
    ...(pinCwd ? { pin_cwd: true } : {}),
    arguments: kinds.map((kind) => {
      if (kind === "text" || kind === "data") return kind;
      if (kind === "file") return { code: null };
      if (kind.startsWith("folder:") && kind.length > "folder:".length)
        return { code: kind.slice(7) };
      throw new CliUsageError(
        "Choose text, data, file, or folder:<program folder>.",
      );
    }),
  };
}

async function suggestedRoot(config: StdioTransportConfig) {
  const cmd = resolveStdioExecutable(config);
  const parent = dirname(dirname(cmd));
  if (await Bun.file(join(parent, "pyvenv.cfg")).exists()) return parent;
  const target = await realpath(cmd);
  if (basename(target) === "npx-cli.js") return dirname(dirname(target));
  return "";
}

export type Ask = (question: string) => Promise<string>;
async function withTerminal<T>(
  ask: Ask | undefined,
  run: (ask: Ask) => Promise<T>,
) {
  if (!ask && !stdin.isTTY)
    throw new CliUsageError(
      "Open a terminal and run this command again. Nothing has been started.",
    );
  const reader = ask
    ? undefined
    : createInterface({ input: stdin, output: stderr });
  const question = ask ?? reader?.question.bind(reader);
  if (!question)
    throw new CliUsageError(
      "A terminal is required. Nothing has been started.",
    );
  try {
    return await run(question);
  } finally {
    reader?.close();
  }
}

async function confirmDiscovery(ask: Ask) {
  if (
    (await ask("Start the selected copy now to review its tools? [yes/no] "))
      .trim()
      .toLowerCase() !== "yes"
  )
    throw new CliUsageError("Canceled. Your server remains paused.");
}

export const confirmMigrationRefresh = (ask?: Ask) =>
  withTerminal(ask, confirmDiscovery);

export async function migrationLayout(
  config: StdioTransportConfig,
  out: (s: string) => void,
  ask?: Ask,
) {
  return withTerminal(ask, async (question) => {
    out(`Program: ${JSON.stringify(config.command)}\n${LAUNCH_WARNING}`);
    const suggested = await suggestedRoot(config);
    const commandRoot =
      (
        await question(
          `Which folder contains this program and its supporting files? Press Enter for ${suggested || "the program file alone"}: `,
        )
      ).trim() || suggested;
    const kinds: string[] = [];
    for (const arg of config.args) {
      const role = (
        await question(
          `What is ${JSON.stringify(arg)}? Type program (code to run), data (a file it can change), or text (a setting): `,
        )
      )
        .trim()
        .toLowerCase();
      if (role === "program") {
        const folder = (
          await question(
            "Folder containing this file and any files it imports (Enter for this file alone): ",
          )
        ).trim();
        kinds.push(folder ? `folder:${folder}` : "file");
      } else kinds.push(role);
    }
    const pinCwd = config.cwd
      ? /^yes$/i.test(
          (
            await question(
              `Also protect the program files in its working folder ${JSON.stringify(config.cwd)}? [yes/no] `,
            )
          ).trim(),
        )
      : false;
    const plan = layout(config, kinds, commandRoot, pinCwd);
    await confirmDiscovery(question);
    return plan;
  });
}
