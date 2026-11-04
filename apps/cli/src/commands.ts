import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { expandCommand, loadCommands } from "@mars/skills";

const USAGE = [
  "Usage: mars commands [--source DIR] list",
  '       mars commands [--source DIR] expand "/name arguments..."',
  "Slash commands are Markdown files in .mars/commands/*.md or .claude/commands/*.md (Claude Code format: optional frontmatter with description and argument-hint; $ARGUMENTS and $1..$9 placeholders).",
  "expand prints the prompt the workbench would send for that request; nothing is executed and no model is called.",
].join("\n");

export class CommandsUsageError extends Error {}

/** `mars commands`: list the repository's slash commands or expand one to its prompt. */
export async function runCommands(
  args: string[],
  out: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: { source: { type: "string" }, help: { type: "boolean" } },
  });
  const subcommand = positionals[0];
  if (values.help || !subcommand || subcommand === "help") {
    out(USAGE);
    return;
  }
  const root = await realpath(resolve(values.source ?? process.cwd()));
  const registry = await loadCommands(root);
  if (subcommand === "list") {
    const commands = registry.list();
    if (commands.length === 0) {
      out("No slash commands found.");
      return;
    }
    for (const command of commands)
      out(
        `/${command.name}\t${command.source}/${command.path.split("/").slice(-1)[0]}${command.description ? `\t${command.description}` : ""}`,
      );
    for (const shadowed of registry.shadowed)
      out(`# shadowed: ${shadowed.path} (by ${shadowed.shadowed_by})`);
    for (const skipped of registry.skipped)
      out(`# skipped: ${skipped.path} (${skipped.reason})`);
    return;
  }
  if (subcommand === "expand") {
    const input = positionals.slice(1).join(" ").trim();
    if (!input.startsWith("/"))
      throw new CommandsUsageError(
        'expand needs a request starting with "/", for example: mars commands expand "/review src/app.ts"',
      );
    const expanded = expandCommand(registry, input);
    if (!expanded)
      throw new CommandsUsageError(
        `Unknown slash command in "${input.split(/\s+/)[0]}"; run mars commands list.`,
      );
    out(expanded.prompt);
    return;
  }
  throw new CommandsUsageError(
    `Unknown commands subcommand "${subcommand}".\n${USAGE}`,
  );
}
