/** Local-only setup record: nothing here is sent off this device. */
export const SETUP_MILESTONES = [
  "opened",
  "key_connected",
  "first_chat_reply",
  "first_task_created",
  "first_task_started",
  "first_verified_export",
] as const;
export type SetupMilestone = (typeof SETUP_MILESTONES)[number];

export const PROVIDER_ISSUES = [
  "rate_limited",
  "auth_failed",
  "credits",
  "unavailable",
  "network",
  "task_model_unavailable",
] as const;
export type ProviderIssue = (typeof PROVIDER_ISSUES)[number];

export type SetupSummary = {
  milestones: Partial<Record<SetupMilestone, string>>;
  issues: Partial<Record<ProviderIssue, number>>;
};

export type ModelHealthState =
  | "unchecked"
  | "ok"
  | Exclude<ProviderIssue, "task_model_unavailable">;

export type ModelHealth = {
  state: ModelHealthState;
  at?: string;
  retryAfterSeconds?: number;
};

export const MILESTONE_LABEL: Record<SetupMilestone, string> = {
  opened: "First opened MARS",
  key_connected: "Model key connected",
  first_chat_reply: "First chat reply",
  first_task_created: "First task created",
  first_task_started: "First task started",
  first_verified_export: "First verified patch exported",
};

export const ISSUE_LABEL: Record<ProviderIssue, string> = {
  rate_limited: "Chat rate-limited by provider",
  auth_failed: "Chat key rejected",
  credits: "Chat needed provider credits",
  unavailable: "Chat model unavailable",
  network: "Chat could not reach provider",
  task_model_unavailable: "Task start blocked by model setup",
};

export const HEALTH_LABEL: Record<ModelHealthState, string> = {
  unchecked: "Not checked yet",
  ok: "Responding",
  rate_limited: "Rate-limited",
  auth_failed: "Key rejected",
  credits: "Needs credits",
  unavailable: "Unavailable",
  network: "Unreachable",
};
