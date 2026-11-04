import { createHash } from "node:crypto";
import type {
  ApplyPatchResult,
  DiscoveredInstructions,
  PatchFileSystem,
} from "@mars/codex-tools";
import type { SkillRecord } from "@mars/contracts";
import { MAX_RUNTIME_INSTRUCTION_LENGTH } from "@mars/execution";
import type {
  ExpandedCommand,
  HookEvent,
  HookExecutor,
  HookResult,
} from "@mars/skills";
import { z } from "zod";
import { serializedBytes } from "./memory-context";
import type { WorkbenchSkills } from "./skills-context";

/**
 * Repository conventions the host applies around a session: instruction files
 * from the trusted checkout, skill folders, hooks, slash commands and the
 * apply_patch applier. Everything here is host-owned; the model only ever sees
 * bounded rendered text and host-bound tools.
 */
export interface WorkbenchHooks {
  /** Runs the hooks registered for `event` through the injected executor; never calls a model. */
  run(
    event: HookEvent,
    context: { tool?: string; path?: string },
    executor: HookExecutor,
  ): Promise<HookResult[]>;
}

export interface WorkbenchCommands {
  /** `/name args` → expanded prompt, or null when the input is not a known command. */
  expand(input: string): ExpandedCommand | null;
}

/** Parses and applies one patch, writing only through the given filesystem seam. */
export type WorkbenchPatchApplier = (
  patch: string,
  files: PatchFileSystem,
) => Promise<ApplyPatchResult>;

export interface WorkbenchConventions {
  /** Discovered AGENTS.md / CLAUDE.md text (already rendered and bounded by the loader). */
  instructions?: DiscoveredInstructions;
  /** Skill folders discovered in the checkout; frozen with learned skills as untrusted evidence. */
  repositorySkills?: readonly SkillRecord[];
  hooks?: WorkbenchHooks;
  commands?: WorkbenchCommands;
  /** Enables the host-bound `mars_apply_patch` tool for write-approved sessions. */
  applyPatch?: WorkbenchPatchApplier;
}

export const MAX_INSTRUCTIONS_CONTEXT_LENGTH = 32 * 1024;
const INSTRUCTIONS_SEPARATOR = "\n\n";
const MAX_INSTRUCTION_FILES = 64;

export const FrozenInstructionsSchema = z
  .object({
    text: z.string().min(1).max(MAX_INSTRUCTIONS_CONTEXT_LENGTH),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.array(z.string().min(1).max(1024)).max(MAX_INSTRUCTION_FILES),
    omitted: z.number().int().nonnegative(),
  })
  .strict();
export type FrozenInstructions = z.infer<typeof FrozenInstructionsSchema>;

/**
 * Freezes the discovered instruction text whole or not at all: a truncated
 * convention file would silently change its meaning, so the block is omitted
 * when it does not fit the remaining runtime and model-context capacity.
 */
export function freezeInstructions(
  found: DiscoveredInstructions,
  instruction: string,
  capacityBytes: number,
): FrozenInstructions | undefined {
  const text = found.text;
  if (!text.trim() || found.files.length === 0) return undefined;
  // Discovery may cut the file that crosses its byte budget; a partial rule
  // can invert its meaning, so such a snapshot is omitted entirely.
  if (found.files.some((file) => file.truncated)) return undefined;
  if (
    text.length > MAX_INSTRUCTIONS_CONTEXT_LENGTH ||
    instruction.length + INSTRUCTIONS_SEPARATOR.length + text.length >
      MAX_RUNTIME_INSTRUCTION_LENGTH ||
    serializedBytes(INSTRUCTIONS_SEPARATOR + text) > capacityBytes ||
    found.files.length > MAX_INSTRUCTION_FILES
  )
    return undefined;
  return FrozenInstructionsSchema.parse({
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
    files: found.files.map((file) => file.path),
    omitted: found.omitted,
  });
}

export function withFrozenInstructions(
  instruction: string,
  frozen: FrozenInstructions | undefined,
): string {
  return frozen
    ? `${instruction}${INSTRUCTIONS_SEPARATOR}${frozen.text}`
    : instruction;
}

/**
 * Combines the learned-skill store with skill folders discovered in the
 * checkout so both freeze through the same bounded, labelled path. Store
 * skills win on a name clash; the revision covers both sources.
 */
export function repositorySkillsSource(
  store: WorkbenchSkills | undefined,
  repository: readonly SkillRecord[] | undefined,
): WorkbenchSkills | undefined {
  if (!repository || repository.length === 0) return store;
  const digest = createHash("sha256")
    .update(
      JSON.stringify(
        repository.map((skill) => [skill.name, skill.content]).sort(),
      ),
    )
    .digest("hex");
  return {
    async list() {
      const learned = store ? await store.list() : [];
      const names = new Set(learned.map((skill) => skill.name));
      return [
        ...learned,
        ...repository.filter((skill) => !names.has(skill.name)),
      ];
    },
    async getRevision() {
      return store
        ? `${await store.getRevision()}+repo:${digest}`
        : `repo:${digest}`;
    },
  };
}

const MAX_PATCH_PATHS_LISTED = 200;

/** Renders an apply_patch outcome for the model: a summary or the failing hunk, nothing else. */
export function renderPatchResult(result: ApplyPatchResult): string {
  const list = (label: string, paths: readonly string[]) =>
    paths.length === 0
      ? []
      : paths
          .slice(0, MAX_PATCH_PATHS_LISTED)
          .map((path) => `${label} ${path}`);
  const applied = [
    ...list("A", result.applied.added),
    ...list("M", result.applied.modified),
    ...list("D", result.applied.deleted),
  ];
  if (result.ok) return result.summary;
  const header =
    result.failed_hunk === null
      ? `apply_patch failed: ${result.error}`
      : `apply_patch failed at hunk ${result.failed_hunk + 1}: ${result.error}`;
  return applied.length === 0
    ? `${header}\nNo files were changed.`
    : `${header}\nHunks before it were applied:\n${applied.join("\n")}`;
}

export const HookResultRecordSchema = z
  .object({
    event: z.enum(["session-start", "pre-tool", "post-tool"]),
    tool: z.string().min(1).max(128).optional(),
    argv: z.array(z.string().max(1024)).max(64),
    outcome: z.enum(["ran", "skipped", "timeout", "error"]),
    exit_code: z.number().int().optional(),
    stdout_bytes: z.number().int().nonnegative(),
    stderr_bytes: z.number().int().nonnegative(),
    blocked: z.boolean(),
    reason: z.string().max(1024).optional(),
  })
  .strict();

/**
 * Bounds a hook result before it is stored as task evidence. Command output
 * stays out of the task's events, like `mars_execute` output: hooks run
 * arbitrary repository commands whose stdout/stderr may carry credentials,
 * and the public events API filters host-private paths, not secrets. Only the
 * output sizes are recorded; a blocking hook's stderr still reaches the model
 * through the tool error.
 */
export function hookResultRecord(
  result: HookResult,
): z.infer<typeof HookResultRecordSchema> {
  return HookResultRecordSchema.parse({
    event: result.event,
    ...(result.tool !== undefined ? { tool: result.tool } : {}),
    argv: result.argv.slice(0, 64).map((token) => token.slice(0, 1024)),
    outcome: result.outcome,
    ...(result.exit_code !== undefined ? { exit_code: result.exit_code } : {}),
    stdout_bytes: Buffer.byteLength(result.stdout, "utf8"),
    stderr_bytes: Buffer.byteLength(result.stderr, "utf8"),
    blocked: result.blocked,
    ...(result.reason !== undefined
      ? { reason: result.reason.slice(0, 1024) }
      : {}),
  });
}

/** The message a model sees when a pre-tool hook blocks the call. */
export function hookBlockMessage(results: readonly HookResult[]): string {
  const blocking = results.find((result) => result.blocked);
  if (!blocking) return "Blocked by a pre-tool hook.";
  const reason = blocking.stderr.trim() || blocking.stdout.trim();
  return reason
    ? `Blocked by pre-tool hook (${blocking.argv[0] ?? "hook"}): ${reason.slice(0, 1024)}`
    : `Blocked by pre-tool hook (${blocking.argv[0] ?? "hook"}): exit code 2.`;
}
