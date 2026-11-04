import { realpath } from "node:fs/promises";
import {
  type CommandRegistry,
  discoverSkills,
  expandCommand,
  type HooksRegistry,
  loadCommands,
  loadHooks,
  runHooks,
  toSkillRecords,
} from "@mars/skills";
import type { WorkbenchConventions } from "./conventions-context";

export interface ConventionsLoadOptions {
  /** The trusted project checkout (`mars serve --source`), never a task workspace. */
  sourceRoot: string;
  /**
   * Whether the checkout is trusted (`--trust-project`). Instruction files and
   * hooks are loaded only from a trusted checkout, mirroring Codex, which
   * skips AGENTS.md for untrusted projects; skill folders and slash commands
   * are bounded text the user invokes or that is labelled untrusted, so they
   * load either way.
   */
  trustProject: boolean;
  /** Optional apply_patch applier (from @mars/codex-tools); absent means no mars_apply_patch tool. */
  applyPatch?: WorkbenchConventions["applyPatch"];
  /** Optional instruction-file loader (from @mars/codex-tools); absent means no repository instructions. */
  discoverInstructions?: (
    root: string,
  ) => Promise<WorkbenchConventions["instructions"]>;
}

export interface ConventionsReport {
  conventions: WorkbenchConventions;
  summary: {
    trusted: boolean;
    instruction_files: string[];
    skills: number;
    hooks: number;
    commands: string[];
    apply_patch: boolean;
  };
}

/**
 * Reads repository conventions from the trusted checkout once at startup.
 * Nothing here runs a command or calls a model: hooks are only parsed, and the
 * host executes them later through its approval-gated sandbox.
 */
export async function loadWorkbenchConventions(
  options: ConventionsLoadOptions,
): Promise<ConventionsReport> {
  const root = await realpath(options.sourceRoot);
  const conventions: WorkbenchConventions = {};
  const summary: ConventionsReport["summary"] = {
    trusted: options.trustProject,
    instruction_files: [],
    skills: 0,
    hooks: 0,
    commands: [],
    apply_patch: Boolean(options.applyPatch),
  };
  if (options.applyPatch) conventions.applyPatch = options.applyPatch;

  const discovered = await discoverSkills({ root });
  const repositorySkills = toSkillRecords(discovered);
  if (repositorySkills.length > 0) {
    conventions.repositorySkills = repositorySkills;
    summary.skills = repositorySkills.length;
  }

  const commands: CommandRegistry = await loadCommands(root);
  const names = commands.list().map((command) => command.name);
  if (names.length > 0) {
    conventions.commands = {
      expand: (input) => expandCommand(commands, input),
    };
    summary.commands = names;
  }

  if (options.trustProject) {
    const hooks: HooksRegistry | null = await loadHooks(root);
    if (hooks) {
      const count = hooks.size;
      if (count > 0) {
        conventions.hooks = {
          run: (event, context, executor) =>
            runHooks(hooks, event, context, executor),
        };
        summary.hooks = count;
      }
    }
    if (options.discoverInstructions) {
      const instructions = await options.discoverInstructions(root);
      if (instructions && instructions.files.length > 0) {
        conventions.instructions = instructions;
        summary.instruction_files = instructions.files.map((file) => file.path);
      }
    }
  }
  return { conventions, summary };
}
