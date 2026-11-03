// Maps Codex CLI sandbox/approval settings (codex-rs/protocol/src/protocol.rs
// `SandboxPolicy` / `AskForApproval`, names only) onto MARS task approvals.
// Pure: no I/O, never widens what the host granted.

import type {
  CodexApprovalMode,
  CodexSandboxMode,
  PolicyMapping,
  WorkbenchApprovals,
} from "./types";

export const DANGER_FULL_ACCESS_REFUSAL =
  "MARS has no unsandboxed mode; use workspace-write";

const SANDBOX_NOTE =
  "execute runs only inside the MARS workspace sandbox (Docker); there is no host shell";
const NEVER_NOTE =
  "MARS never prompts mid-task: approvals are fixed at launch, so 'never' behaves like 'on-request'";
const UNTRUSTED_NOTE =
  "'untrusted' keeps reads only; writes and execution need an explicit approval change at launch";

export interface PolicyHost {
  canExecute: boolean;
}

function sandboxApprovals(
  sandbox: CodexSandboxMode,
  host: PolicyHost,
): WorkbenchApprovals {
  switch (sandbox) {
    case "read-only":
      return { read: true, write: false, execute: false };
    case "workspace-write":
    case "danger-full-access":
      return { read: true, write: true, execute: host.canExecute };
    default: {
      const exhaustive: never = sandbox;
      throw new Error(`unknown sandbox mode ${String(exhaustive)}`);
    }
  }
}

/**
 * Translates a Codex `(sandbox, approval)` pair into MARS approvals.
 * `danger-full-access` is refused and mapped to `workspace-write`; `untrusted`
 * strips write/execute; `never` equals `on-request` because MARS cannot ask.
 */
export function mapCodexPolicy(
  sandbox: CodexSandboxMode,
  approval: CodexApprovalMode,
  host: PolicyHost,
): PolicyMapping {
  const notes: string[] = [];
  let approvals = sandboxApprovals(sandbox, host);
  let refused: string | undefined;
  if (sandbox === "danger-full-access") {
    refused = DANGER_FULL_ACCESS_REFUSAL;
    notes.push(
      "danger-full-access refused; applied workspace-write approvals instead",
    );
  }
  if (approvals.write || approvals.execute) {
    notes.push(SANDBOX_NOTE);
  }
  if (sandbox !== "read-only" && !host.canExecute) {
    notes.push("host has canExecute=false, so execute stays disabled");
  }
  switch (approval) {
    case "untrusted":
      approvals = { read: approvals.read, write: false, execute: false };
      notes.push(UNTRUSTED_NOTE);
      break;
    case "on-request":
      break;
    case "never":
      notes.push(NEVER_NOTE);
      break;
    default: {
      const exhaustive: never = approval;
      throw new Error(`unknown approval mode ${String(exhaustive)}`);
    }
  }
  const mapping: PolicyMapping = {
    sandbox,
    approval,
    approvals,
    execute_requires_sandbox: true,
    notes,
  };
  if (refused !== undefined) {
    mapping.refused = refused;
  }
  return mapping;
}

/** Elementwise AND: a requested approval only survives when it was also granted. */
export function clampApprovals(
  requested: WorkbenchApprovals,
  granted: WorkbenchApprovals,
): WorkbenchApprovals {
  return {
    read: requested.read && granted.read,
    write: requested.write && granted.write,
    execute: requested.execute && granted.execute,
  };
}
