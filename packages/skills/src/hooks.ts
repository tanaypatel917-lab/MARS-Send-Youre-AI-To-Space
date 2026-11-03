/**
 * Hooks registry backed by `<root>/.mars/hooks.json`. The registry only
 * *describes* commands (argv arrays, matchers, timeouts); nothing here runs a
 * process. `runHooks` hands each argv to an executor injected by the host (the
 * approval-gated, sandboxed `WorkspaceHost.execute`), which may decline by
 * returning `{ skipped }`. Event names follow Claude Code's hook format
 * (`SessionStart` / `PreToolUse` / `PostToolUse` accepted as aliases of
 * `session-start` / `pre-tool` / `post-tool`); no upstream source is used.
 */
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type {
  HookEvent,
  HookExecution,
  HookExecutor,
  HookResult,
  HookSpec,
} from "./conventions-types";

export const HOOKS_FILE = ".mars/hooks.json";
export const HOOKS_SCHEMA_VERSION = 1;
export const MAX_HOOKS_PER_EVENT = 32;
export const MAX_HOOK_ARGV_TOKENS = 64;
export const MAX_HOOK_TOKEN_BYTES = 1024;
export const MIN_HOOK_TIMEOUT_MS = 1_000;
export const MAX_HOOK_TIMEOUT_MS = 300_000;
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
export const MAX_HOOKS_FILE_BYTES = 256 * 1024;
export const MAX_HOOK_OUTPUT_BYTES = 4 * 1024;
/** Claude Code semantics: a pre-tool hook exiting 2 blocks the tool call. */
export const HOOK_BLOCK_EXIT_CODE = 2;

export const HOOK_EVENTS: readonly HookEvent[] = [
  "session-start",
  "pre-tool",
  "post-tool",
];
/** Claude Code event names accepted on read. */
export const HOOK_EVENT_ALIASES: Readonly<Record<string, HookEvent>> = {
  SessionStart: "session-start",
  PreToolUse: "pre-tool",
  PostToolUse: "post-tool",
};

export class HooksError extends Error {
  readonly code: "invalid" | "unreadable";
  constructor(code: "invalid" | "unreadable", message: string) {
    super(message);
    this.name = "HooksError";
    this.code = code;
  }
}

const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MATCHER =
  /^(?:\*|[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}(?:\|[A-Za-z0-9][A-Za-z0-9_.:-]{0,127})*)$/;

/** Same shape the workspace provider accepts: relative, forward slashes, no `.`/`..`/empty segments, no control characters. */
const isWorkspaceRelativePath = (path: string) =>
  path.length > 0 &&
  !hasControlCharacter(path) &&
  !path.includes("\\") &&
  !path.startsWith("/") &&
  !/^[A-Za-z]:/.test(path) &&
  path
    .split("/")
    .every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );

const hasControlCharacter = (token: string) =>
  [...token].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

const TokenSchema = z
  .string()
  .min(1)
  .refine((token) => Buffer.byteLength(token, "utf8") <= MAX_HOOK_TOKEN_BYTES, {
    message: `argv tokens must be at most ${MAX_HOOK_TOKEN_BYTES} bytes`,
  })
  .refine((token) => !hasControlCharacter(token), {
    message: "argv tokens must not contain control characters",
  });

const HookEntrySchema = z
  .object({
    matcher: z.string().regex(MATCHER).optional(),
    command: z.array(TokenSchema).min(1).max(MAX_HOOK_ARGV_TOKENS),
    timeout_ms: z
      .number()
      .int()
      .min(MIN_HOOK_TIMEOUT_MS)
      .max(MAX_HOOK_TIMEOUT_MS)
      .default(DEFAULT_HOOK_TIMEOUT_MS),
  })
  .strict();

const EventListSchema = z.array(HookEntrySchema).max(MAX_HOOKS_PER_EVENT);

const HooksFileSchema = z
  .object({
    schema_version: z.literal(HOOKS_SCHEMA_VERSION),
    hooks: z
      .object({
        "session-start": EventListSchema.optional(),
        "pre-tool": EventListSchema.optional(),
        "post-tool": EventListSchema.optional(),
        SessionStart: EventListSchema.optional(),
        PreToolUse: EventListSchema.optional(),
        PostToolUse: EventListSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type HooksFile = z.infer<typeof HooksFileSchema>;

export class HooksRegistry {
  private readonly byEvent: Readonly<Record<HookEvent, readonly HookSpec[]>>;
  constructor(hooks: readonly HookSpec[]) {
    const grouped: Record<HookEvent, HookSpec[]> = {
      "session-start": [],
      "pre-tool": [],
      "post-tool": [],
    };
    for (const spec of hooks) grouped[spec.event].push(structuredClone(spec));
    this.byEvent = grouped;
  }
  list(): HookSpec[] {
    return HOOK_EVENTS.flatMap((event) =>
      this.byEvent[event].map((spec) => structuredClone(spec)),
    );
  }
  get size(): number {
    return HOOK_EVENTS.reduce((n, event) => n + this.byEvent[event].length, 0);
  }
  /** Hooks for `event` whose matcher accepts `toolName` (session-start ignores the tool). */
  select(event: HookEvent, toolName?: string): HookSpec[] {
    return this.byEvent[event]
      .filter((spec) => matches(spec, event, toolName))
      .map((spec) => structuredClone(spec));
  }
}

function matches(spec: HookSpec, event: HookEvent, toolName?: string) {
  if (event === "session-start") return true;
  if (spec.matcher === undefined || spec.matcher === "*") return true;
  if (toolName === undefined) return false;
  return spec.matcher.split("|").includes(toolName);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

/** Validates already-parsed JSON (exported so hosts can validate configuration without touching the filesystem). */
export function parseHooksFile(data: unknown): HooksRegistry {
  const parsed = HooksFileSchema.safeParse(data);
  if (!parsed.success)
    throw new HooksError("invalid", formatIssues(parsed.error));
  const specs: HookSpec[] = [];
  const seen = new Set<HookEvent>();
  for (const [key, entries] of Object.entries(parsed.data.hooks)) {
    if (!entries) continue;
    const event = HOOK_EVENT_ALIASES[key] ?? (key as HookEvent);
    if (seen.has(event))
      throw new HooksError(
        "invalid",
        `event "${event}" is configured twice (alias and canonical name)`,
      );
    seen.add(event);
    for (const [index, entry] of entries.entries()) {
      if (event === "session-start" && entry.matcher !== undefined)
        throw new HooksError(
          "invalid",
          `hooks.${key}.${index}: session-start hooks take no matcher`,
        );
      const spec: HookSpec = {
        event,
        command: [...entry.command],
        timeout_ms: entry.timeout_ms,
      };
      if (entry.matcher !== undefined) spec.matcher = entry.matcher;
      specs.push(spec);
    }
  }
  return new HooksRegistry(specs);
}

/** Null when `<root>/.mars/hooks.json` does not exist; `HooksError` when it is unreadable or invalid. */
export async function loadHooks(root: string): Promise<HooksRegistry | null> {
  const path = join(resolve(root), ...HOOKS_FILE.split("/"));
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new HooksError("unreadable", `${HOOKS_FILE}: ${String(error)}`);
  }
  if (stats.isSymbolicLink())
    throw new HooksError("invalid", `${HOOKS_FILE} must not be a symlink`);
  if (!stats.isFile())
    throw new HooksError("invalid", `${HOOKS_FILE} is not a regular file`);
  if (stats.size > MAX_HOOKS_FILE_BYTES)
    throw new HooksError(
      "invalid",
      `${HOOKS_FILE} exceeds ${MAX_HOOKS_FILE_BYTES} bytes`,
    );
  let data: unknown;
  try {
    data = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await readFile(path),
      ),
    );
  } catch (error) {
    throw new HooksError("invalid", `${HOOKS_FILE}: ${String(error)}`);
  }
  return parseHooksFile(data);
}

export interface HookContext {
  tool?: string;
  /** Workspace-relative path of the file the tool touches, when known. */
  path?: string;
}

/** Substitutes `{tool}` / `{path}` tokens (whole tokens only); a placeholder with no value drops its token. */
export function renderHookArgv(spec: HookSpec, context: HookContext): string[] {
  const argv: string[] = [];
  for (const token of spec.command) {
    if (token === "{tool}") {
      if (context.tool !== undefined) argv.push(context.tool);
    } else if (token === "{path}") {
      if (context.path !== undefined) argv.push(context.path);
    } else argv.push(token);
  }
  return argv;
}

export function truncateOutput(
  text: string,
  maxBytes = MAX_HOOK_OUTPUT_BYTES,
): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let out = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += char;
  }
  return out;
}

const TIMEOUT = Symbol("timeout");

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMEOUT>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(TIMEOUT), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Runs the hooks selected for `event` in order through the injected executor.
 * Never calls a model and never spawns anything itself. For `pre-tool`, an exit
 * code of 2 marks the result `blocked` and stops the remaining pre-tool hooks;
 * other non-zero exits are recorded only. A missing executor result (`skipped`),
 * an exceeded `timeout_ms` or a thrown error are recorded as such outcomes.
 * A `path` that is not workspace-relative (absolute, `..`, backslashes,
 * control characters) is refused before any hook runs, so a hook can never be
 * pointed outside the task workspace by the tool call it wraps.
 */
export async function runHooks(
  registry: HooksRegistry,
  event: HookEvent,
  context: HookContext,
  executor: HookExecutor,
): Promise<HookResult[]> {
  if (context.tool !== undefined && !TOOL_NAME.test(context.tool))
    throw new HooksError("invalid", `invalid tool name "${context.tool}"`);
  if (context.path !== undefined && !isWorkspaceRelativePath(context.path))
    throw new HooksError(
      "invalid",
      `hook path must be workspace-relative: "${context.path}"`,
    );
  const results: HookResult[] = [];
  for (const spec of registry.select(event, context.tool)) {
    const argv = renderHookArgv(spec, context);
    const base: HookResult = {
      event,
      argv,
      outcome: "ran",
      stdout: "",
      stderr: "",
      blocked: false,
    };
    if (context.tool !== undefined) base.tool = context.tool;
    if (argv.length === 0) {
      results.push({
        ...base,
        outcome: "skipped",
        reason: "empty argv after placeholder substitution",
      });
      continue;
    }
    let outcome: HookExecution | { skipped: string } | typeof TIMEOUT;
    try {
      outcome = await withTimeout(
        executor(argv, spec.timeout_ms),
        spec.timeout_ms,
      );
    } catch (error) {
      results.push({
        ...base,
        outcome: "error",
        reason: truncateOutput(
          error instanceof Error ? error.message : String(error),
        ),
      });
      continue;
    }
    if (outcome === TIMEOUT) {
      results.push({
        ...base,
        outcome: "timeout",
        reason: `exceeded ${spec.timeout_ms} ms`,
      });
      continue;
    }
    if ("skipped" in outcome) {
      results.push({
        ...base,
        outcome: "skipped",
        reason: truncateOutput(outcome.skipped),
      });
      continue;
    }
    const blocked =
      event === "pre-tool" && outcome.exit_code === HOOK_BLOCK_EXIT_CODE;
    results.push({
      ...base,
      outcome: "ran",
      exit_code: outcome.exit_code,
      stdout: truncateOutput(outcome.stdout),
      stderr: truncateOutput(outcome.stderr),
      blocked,
    });
    if (blocked) break;
  }
  return results;
}

export const isBlocked = (results: readonly HookResult[]) =>
  results.some((result) => result.blocked);
