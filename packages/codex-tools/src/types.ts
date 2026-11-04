/**
 * Shared contracts of @mars/codex-tools. Owned by the integration branch; add
 * new types in your own modules rather than changing these shapes.
 */

/** Filesystem seam the apply_patch applier writes through; the host binds it to the workspace provider. */
export interface PatchFileSystem {
  /** UTF-8 text of a regular file, or null when it does not exist. */
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<"file" | "directory" | null>;
}

export interface UpdateFileChunk {
  change_context: string | null;
  old_lines: string[];
  new_lines: string[];
  /** Pairs of (old index, new index) for lines parsed as context rather than inferred equal. */
  context_line_indices: Array<[number, number]>;
  is_end_of_file: boolean;
}

export type PatchHunk =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | {
      kind: "update";
      path: string;
      move_path: string | null;
      chunks: UpdateFileChunk[];
    };

export interface ParsedPatch {
  hunks: PatchHunk[];
  /** Patch text without a lenient heredoc wrapper, trimmed. */
  patch: string;
  environment_id: string | null;
}

export interface AppliedPaths {
  added: string[];
  modified: string[];
  deleted: string[];
}

export type ApplyPatchResult =
  | { ok: true; applied: AppliedPaths; summary: string }
  | {
      ok: false;
      /** Hunks applied before the failure stay applied (upstream semantics). */
      applied: AppliedPaths;
      failed_hunk: number | null;
      error: string;
    };

export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";
export type CodexApprovalMode = "untrusted" | "on-request" | "never";

export interface WorkbenchApprovals {
  read: boolean;
  write: boolean;
  execute: boolean;
}

export interface PolicyMapping {
  sandbox: CodexSandboxMode;
  approval: CodexApprovalMode;
  approvals: WorkbenchApprovals;
  /** MARS executes only inside the workspace sandbox; there is no host shell. */
  execute_requires_sandbox: true;
  notes: string[];
  refused?: string;
}

export type InstructionFileKind =
  | "AGENTS.override.md"
  | "AGENTS.md"
  | "CLAUDE.md";

export interface InstructionFile {
  /** Posix path relative to the discovery root. */
  path: string;
  kind: InstructionFileKind;
  bytes: number;
  truncated: boolean;
  text: string;
}

export interface DiscoveredInstructions {
  files: InstructionFile[];
  total_bytes: number;
  /** Files found but dropped because the byte budget was exhausted. */
  omitted: number;
  /** Rendered, labelled text ready to append to a runtime instruction. */
  text: string;
  sha256: string;
}
