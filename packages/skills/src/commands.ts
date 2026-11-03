/**
 * Slash-command registry backed by `<root>/.mars/commands/*.md` and
 * `<root>/.claude/commands/*.md` (one level of `<dir>/<file>.md` namespacing,
 * named `dir:file`). `expandCommand` turns `/name args` into a prompt by
 * substituting `$ARGUMENTS` and `$1`…`$9`. Only the file layout, frontmatter
 * keys and placeholder names follow Claude Code's custom-command format; no
 * upstream source is used. Shell inclusion (`` !`cmd` ``) is never executed:
 * it is recorded as unsupported and left verbatim.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExpandedCommand, SlashCommand } from "./conventions-types";
import { parseFrontmatter } from "./frontmatter";

export type CommandSource = SlashCommand["source"];
export const COMMAND_SOURCES: readonly CommandSource[] = [
  ".mars/commands",
  ".claude/commands",
];
export const MAX_COMMANDS = 128;
export const MAX_COMMAND_BODY_BYTES = 16 * 1024;
export const MAX_EXPANDED_PROMPT_BYTES = 64 * 1024;
export const COMMAND_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const COMMAND_NAME_PATTERN =
  /^[a-z0-9][a-z0-9_-]{0,63}(?::[a-z0-9][a-z0-9_-]{0,63})?$/;

const FENCE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const SHELL_INCLUSION = /!`[^`\n]*`/g;
const PLACEHOLDER = /\$ARGUMENTS|\$[1-9]/g;

export class CommandError extends Error {
  readonly code: "too-large" | "invalid";
  constructor(code: "too-large" | "invalid", message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

/** `SlashCommand` plus the parsed frontmatter (e.g. `allowed-tools`, preserved but never enforced here). */
export interface LoadedSlashCommand extends SlashCommand {
  frontmatter: Record<string, string | undefined>;
}

export class CommandRegistry {
  private readonly byName: ReadonlyMap<string, LoadedSlashCommand>;
  readonly shadowed: ReadonlyArray<{
    name: string;
    path: string;
    shadowed_by: string;
  }>;
  readonly skipped: ReadonlyArray<{ path: string; reason: string }>;
  constructor(
    commands: readonly LoadedSlashCommand[],
    shadowed: ReadonlyArray<{
      name: string;
      path: string;
      shadowed_by: string;
    }> = [],
    skipped: ReadonlyArray<{ path: string; reason: string }> = [],
  ) {
    const map = new Map<string, LoadedSlashCommand>();
    for (const command of commands) {
      if (!COMMAND_NAME_PATTERN.test(command.name))
        throw new CommandError(
          "invalid",
          `invalid command name "${command.name}"`,
        );
      if (map.has(command.name))
        throw new CommandError(
          "invalid",
          `duplicate command "${command.name}"`,
        );
      map.set(command.name, structuredClone(command));
    }
    this.byName = map;
    this.shadowed = structuredClone([...shadowed]);
    this.skipped = structuredClone([...skipped]);
  }
  list(): LoadedSlashCommand[] {
    return [...this.byName.values()].map((command) => structuredClone(command));
  }
  get(name: string): LoadedSlashCommand | undefined {
    const command = this.byName.get(name);
    return command ? structuredClone(command) : undefined;
  }
  get size(): number {
    return this.byName.size;
  }
}

async function entryKind(
  path: string,
): Promise<"file" | "directory" | "symlink" | "other" | null> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function sortedEntries(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

interface Candidate {
  name: string;
  relative: string;
  absolute: string;
  kind: Awaited<ReturnType<typeof entryKind>>;
}

async function candidates(
  root: string,
  source: CommandSource,
): Promise<Candidate[]> {
  const base = join(root, ...source.split("/"));
  if ((await entryKind(base)) !== "directory") return [];
  const out: Candidate[] = [];
  const visit = async (
    dir: string,
    relativeDir: string,
    namespace?: string,
  ) => {
    for (const entry of await sortedEntries(dir)) {
      if (entry.startsWith(".")) continue;
      const absolute = join(dir, entry);
      const relative = `${relativeDir}/${entry}`;
      const kind = await entryKind(absolute);
      if (kind === "directory") {
        if (namespace === undefined) await visit(absolute, relative, entry);
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      const stem = entry.slice(0, -3);
      const name = namespace === undefined ? stem : `${namespace}:${stem}`;
      out.push({ name, relative, absolute, kind });
    }
  };
  await visit(base, source);
  return out;
}

export async function loadCommands(root: string): Promise<CommandRegistry> {
  const absoluteRoot = resolve(root);
  const commands: LoadedSlashCommand[] = [];
  const shadowed: Array<{ name: string; path: string; shadowed_by: string }> =
    [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const byName = new Map<string, LoadedSlashCommand>();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const source of COMMAND_SOURCES) {
    for (const candidate of await candidates(absoluteRoot, source)) {
      const { name, relative: path, absolute, kind } = candidate;
      if (kind !== "file") {
        skipped.push({ path, reason: kind ?? "missing" });
        continue;
      }
      if (!COMMAND_NAME_PATTERN.test(name)) {
        skipped.push({ path, reason: "invalid-name" });
        continue;
      }
      if (commands.length >= MAX_COMMANDS) {
        skipped.push({ path, reason: "limit" });
        continue;
      }
      const stats = await lstat(absolute);
      if (stats.size > MAX_COMMAND_BODY_BYTES) {
        skipped.push({ path, reason: "oversize" });
        continue;
      }
      let text: string;
      try {
        text = decoder.decode(await readFile(absolute));
      } catch {
        skipped.push({ path, reason: "encoding" });
        continue;
      }
      let frontmatter: Record<string, string | undefined> = {};
      let body = text;
      if (text.startsWith("---")) {
        const parsed = parseFrontmatter(text);
        if (!parsed) {
          skipped.push({ path, reason: "frontmatter" });
          continue;
        }
        frontmatter = { ...parsed };
        body = text.replace(FENCE, "");
      }
      const existing = byName.get(name);
      if (existing) {
        shadowed.push({ name, path, shadowed_by: existing.path });
        continue;
      }
      const command: LoadedSlashCommand = {
        name,
        path,
        source,
        body,
        unsupported: findUnsupported(body),
        frontmatter,
      };
      const description = frontmatter.description?.trim();
      if (description) command.description = description;
      const hint = frontmatter["argument-hint"]?.trim();
      if (hint) command.argument_hint = hint;
      byName.set(name, command);
      commands.push(command);
    }
  }
  return new CommandRegistry(commands, shadowed, skipped);
}

/** Constructs this registry will not honour; the text is left as written. */
export function findUnsupported(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(SHELL_INCLUSION))
    found.push(`shell inclusion is not executed: ${match[0]}`);
  return found;
}

export interface ParsedSlashInput {
  name: string;
  /** Raw text after the command name (`$ARGUMENTS`). */
  argumentsText: string;
  /** Whitespace-split positional arguments (`$1`…`$9`); quotes are not interpreted. */
  positional: string[];
}

/** `/name rest` → parts; null when the input is not a slash command. */
export function parseSlashInput(input: string): ParsedSlashInput | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/(\S+)([\s\S]*)$/.exec(trimmed);
  if (!match || match[1] === undefined) return null;
  const name = match[1];
  if (!COMMAND_NAME_PATTERN.test(name)) return null;
  const argumentsText = (match[2] ?? "").trim();
  const positional = argumentsText ? argumentsText.split(/\s+/) : [];
  return { name, argumentsText, positional };
}

/** Substitutes `$ARGUMENTS` and `$1`…`$9` in one pass (argument text is never re-scanned). */
export function substitutePlaceholders(
  body: string,
  argumentsText: string,
  positional: readonly string[],
): { prompt: string; substituted: boolean } {
  let substituted = false;
  const prompt = body.replace(PLACEHOLDER, (token) => {
    substituted = true;
    if (token === "$ARGUMENTS") return argumentsText;
    return positional[Number(token.slice(1)) - 1] ?? "";
  });
  return { prompt, substituted };
}

/**
 * Expands `/name args` into a prompt. Null when the input is not a slash
 * command or the name is unknown. When the body uses no placeholder, the
 * argument text is appended after a blank line so it is never dropped.
 */
export function expandCommand(
  registry: CommandRegistry,
  input: string,
): ExpandedCommand | null {
  const parsed = parseSlashInput(input);
  if (!parsed) return null;
  const command = registry.get(parsed.name);
  if (!command) return null;
  const { prompt: expanded, substituted } = substitutePlaceholders(
    command.body,
    parsed.argumentsText,
    parsed.positional,
  );
  const prompt =
    !substituted && parsed.argumentsText
      ? `${expanded.replace(/\s+$/, "")}\n\n${parsed.argumentsText}\n`
      : expanded;
  if (Buffer.byteLength(prompt, "utf8") > MAX_EXPANDED_PROMPT_BYTES)
    throw new CommandError(
      "too-large",
      `expanded prompt for /${parsed.name} exceeds ${MAX_EXPANDED_PROMPT_BYTES} bytes`,
    );
  return { name: parsed.name, prompt, command };
}
