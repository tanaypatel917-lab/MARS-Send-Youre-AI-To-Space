import { VERIFICATION_STATE_LABEL } from "@mars/contracts";

/** Which staged UI PR (§8.2) makes a command do something in the terminal client. */
export type CommandStage = 1 | 2 | 3;

export interface SlashCommand {
  name: string;
  args?: string;
  help: string;
  stage: CommandStage;
}

/** Every command in §5.2. Stage-1 commands are read-only views; later stages answer with `notYet`. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", help: "Keybindings and commands.", stage: 1 },
  {
    name: "permissions",
    help: "The four modes (ask, plan, auto-edit, sandbox) and what each allows. Alias /mode.",
    stage: 2,
  },
  {
    name: "context",
    help: "Context rows: tokens · $ · source · remedy, from tasks.inspect.",
    stage: 1,
  },
  { name: "tasks", help: "Tasks in this workbench project.", stage: 1 },
  { name: "new", args: "[request]", help: "Draft a new task.", stage: 2 },
  {
    name: "resume",
    args: "[id]",
    help: "Show a task's frozen launch settings (view only in this client).",
    stage: 1,
  },
  { name: "cancel", help: "Cancel the running task.", stage: 2 },
  {
    name: "model",
    help: "Model rows from workbench.describe: free · local · paid (view only).",
    stage: 1,
  },
  { name: "approve", help: "Reopen the approvals card.", stage: 2 },
  { name: "diff", args: "[path]", help: "Open the diff viewer.", stage: 3 },
  {
    name: "review",
    args: "<path>:<line>[-<end>]",
    help: "Draft a review-link steer.",
    stage: 3,
  },
  { name: "children", help: "Child sessions of this task.", stage: 2 },
  { name: "research", help: "Research findings for this task.", stage: 2 },
  {
    name: "evidence",
    help: "Watch evidence and verification records.",
    stage: 2,
  },
  {
    name: "proposals",
    help: "Memory, skill and vault proposals with the operator command (view only).",
    stage: 1,
  },
  {
    name: "graph",
    help: "Knowledge-graph state and records from workbench.describe (view only).",
    stage: 1,
  },
  {
    name: "queue",
    args: "<text>",
    help: "Queue text for the next turn.",
    stage: 2,
  },
  {
    name: "drop",
    args: "<path>",
    help: "Ask the runtime to unpin a file.",
    stage: 2,
  },
  {
    name: "undo",
    help: "Restore the checkpoint before the last MARS edit turn.",
    stage: 3,
  },
  { name: "cost", help: "Token and cost totals for the task.", stage: 2 },
  {
    name: "status",
    help: "workbench.describe summary and connection file.",
    stage: 2,
  },
  { name: "theme", help: "Switch between mars-dark and mars-light.", stage: 2 },
  { name: "symbols", help: "Switch glyphs: unicode, nerd, ascii.", stage: 2 },
  { name: "settings", help: "Local client settings.", stage: 2 },
  {
    name: "commands",
    help: "Repository commands with their expansion preview.",
    stage: 2,
  },
  {
    name: "export",
    args: "[file]",
    help: "Write the projection as Markdown; nothing is executed.",
    stage: 1,
  },
  { name: "compact", help: "Compaction is disabled by the host.", stage: 1 },
  { name: "quit", help: "Quit the client; tasks keep running.", stage: 1 },
];

export const STRINGS = {
  readOnly: "read-only session",
  readOnlyComposer:
    "read-only session · type / for commands · start, steer and cancel are not in this client yet",
  notYet: (name: string) =>
    `/${name} is not available in this read-only client yet · it arrives in a later UI stage`,
  unknownCommand: (name: string) =>
    `unknown command /${name} · type /help for the list`,
  compactionDisabled: "compaction is disabled by the host",
  turnMarker: "assistant turn",
  journalUnavailable: "text arrives with the final artifact",
  finalArtifact: "final artifact",
  untrusted: "untrusted",
  completedNotVerified: "completed · not verified",
  expandHint: (lines: number, key: string) =>
    `… +${lines} lines (${key} to expand)`,
  loadEarlier: (count: number, key: string) =>
    `${count} earlier entries · ${key} to load`,
  resize: "resize to at least 60×16",
  quitHint: "press Ctrl+C again to quit (tasks keep running)",
  verification: VERIFICATION_STATE_LABEL,
  frozenSettings:
    "Launch settings are frozen at start: tasks.resume cannot change model, budget or approvals.",
  noTasks: "No tasks yet · start one with mars task or the VS Code extension",
} as const;

/** §5.4 error lines: `what happened · why · what to do`. */
export const ERROR_LINES: Readonly<
  Record<string, { what: string; why: string; action: string }>
> = {
  unreachable: {
    what: "Workbench unreachable",
    why: "no answer on the loopback RPC",
    action: "run mars serve",
  },
  unauthorized: {
    what: "token rejected",
    why: "the connection file token does not match the running workbench",
    action: "restart mars session to re-read the connection file",
  },
  forbidden: {
    what: "request refused",
    why: "scope does not match this workbench",
    action: "check --connection",
  },
  not_found: {
    what: "task not found",
    why: "the task id is not in this project",
    action: "/tasks",
  },
  conflict: {
    what: "conflict",
    why: "the task changed on the host",
    action: "the projection refreshes; no retry",
  },
  model_unavailable: {
    what: "model unavailable",
    why: "the selected model cannot serve requests",
    action: "/model to pick another free model",
  },
  budget: {
    what: "budget exhausted",
    why: "the task reached its cap",
    action: "/new with a larger budget",
  },
  unavailable: {
    what: "workbench unavailable",
    why: "the host refused the request for now",
    action: "the client retries",
  },
  too_large: {
    what: "response too large",
    why: "the host cap was reached",
    action: "the client pages again",
  },
  invalid_request: {
    what: "request rejected",
    why: "the host did not accept the request",
    action: "update mars",
  },
  protocol: {
    what: "unexpected reply",
    why: "the workbench answered outside the protocol",
    action: "update mars",
  },
  internal_error: {
    what: "workbench error",
    why: "the host failed",
    action: "see the mars serve log",
  },
  graph_stale: {
    what: "graph stale",
    why: "the workspace moved past the built revision",
    action: "ask the coordinator to rebuild the knowledge graph",
  },
  format: {
    what: "format errors in output",
    why: "the reply did not follow MARS Output Format",
    action: "Ctrl+O lists codes",
  },
};

export function errorLine(code: string): string {
  const line = ERROR_LINES[code] ?? ERROR_LINES.internal_error;
  return line ? `${line.what} · ${line.why} · ${line.action}` : code;
}
