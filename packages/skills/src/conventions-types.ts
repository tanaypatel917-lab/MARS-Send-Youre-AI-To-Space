/**
 * Shared contracts for repository conventions (skill folders, hooks, slash
 * commands). Formats follow Claude Code and Codex CLI conventions; no upstream
 * source is copied. Owned by the integration branch; add new types in your own
 * modules rather than changing these shapes.
 */

export type SkillSource =
  | "skills"
  | ".claude/skills"
  | ".codex/skills"
  | ".agents/skills";

export interface DiscoveredSkill {
  name: string;
  description: string;
  /** Posix path of the SKILL.md relative to the root. */
  path: string;
  source: SkillSource;
  content: string;
  bytes: number;
  frontmatter: Record<string, string | undefined>;
}

export interface SkillDiscoveryResult {
  skills: DiscoveredSkill[];
  /** Later copies of a name already taken by an earlier source. */
  shadowed: Array<{ name: string; path: string; shadowed_by: string }>;
  /** Files that were present but not loadable (oversize, bad frontmatter, symlink). */
  skipped: Array<{ path: string; reason: string }>;
}

export type HookEvent = "session-start" | "pre-tool" | "post-tool";

export interface HookSpec {
  event: HookEvent;
  /** `|`-separated exact tool names or `*`; absent for session-start. */
  matcher?: string;
  /** argv tokens; `{tool}` and `{path}` are substituted as whole tokens. */
  command: string[];
  timeout_ms: number;
}

export interface HookExecution {
  exit_code: number;
  stdout: string;
  stderr: string;
}

/** Injected by the host: the approval-gated, sandboxed workspace execute. */
export type HookExecutor = (
  argv: string[],
  timeoutMs: number,
) => Promise<HookExecution | { skipped: string }>;

export interface HookResult {
  event: HookEvent;
  tool?: string;
  argv: string[];
  outcome: "ran" | "skipped" | "timeout" | "error";
  exit_code?: number;
  stdout: string;
  stderr: string;
  /** pre-tool only: exit code 2 blocks the tool call. */
  blocked: boolean;
  reason?: string;
}

export interface SlashCommand {
  name: string;
  /** Posix path relative to the root. */
  path: string;
  source: ".mars/commands" | ".claude/commands";
  description?: string;
  argument_hint?: string;
  body: string;
  /** Unsupported constructs found in the body (for example shell inclusion). */
  unsupported: string[];
}

export interface ExpandedCommand {
  name: string;
  prompt: string;
  command: SlashCommand;
}
