import { z } from "zod";

/**
 * Redacted operational counters. Every counter name is a fixed identifier from
 * the allowlist below and every value is an integer, so a snapshot can never
 * carry a message body, a path, a SHA, a token or any user-supplied text.
 * Counters are durable rows in the store (`metrics` table, migration
 * `0005_metrics`) so `mars team stats` in another process reads the same
 * numbers the serving process wrote.
 */

/** Error codes a denied read or an RPC can answer with (the frozen workbench vocabulary). */
export const METRIC_ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "unavailable",
  "too_large",
  "internal_error",
] as const;
export const METRIC_AGENT_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "restricted",
] as const;

export const TEAM_METRIC_COUNTERS = [
  "sends",
  "send_replays",
  "conflicts",
  "stream_connects",
  "stream_disconnects",
  "backfill_pages",
  "links",
  "shares",
  "rate_limit_hits",
  "disabled_refusals",
  ...METRIC_ERROR_CODES.map((code) => `denied_reads.${code}` as const),
  ...METRIC_AGENT_STATUSES.map((status) => `agent_requests.${status}` as const),
  ...METRIC_ERROR_CODES.map((code) => `rpc_errors.${code}` as const),
] as const;
export type TeamMetricCounter = (typeof TEAM_METRIC_COUNTERS)[number];
const COUNTER_SET: ReadonlySet<string> = new Set(TEAM_METRIC_COUNTERS);
export const isTeamMetricCounter = (name: string): name is TeamMetricCounter =>
  COUNTER_SET.has(name);

const count = z.number().int().nonnegative();
const byCode = z
  .object(
    Object.fromEntries(
      METRIC_ERROR_CODES.map((code) => [code, count]),
    ) as Record<(typeof METRIC_ERROR_CODES)[number], typeof count>,
  )
  .strict();
const byStatus = z
  .object(
    Object.fromEntries(
      METRIC_AGENT_STATUSES.map((status) => [status, count]),
    ) as Record<(typeof METRIC_AGENT_STATUSES)[number], typeof count>,
  )
  .strict();

/** `team.metrics` result and `mars team stats` output: integers under fixed keys only. */
export const TeamMetricsSchema = z
  .object({
    schema_version: z.literal(1),
    sends: count,
    send_replays: count,
    conflicts: count,
    stream_connects: count,
    stream_disconnects: count,
    backfill_pages: count,
    links: count,
    shares: count,
    rate_limit_hits: count,
    disabled_refusals: count,
    denied_reads: byCode,
    agent_requests: byStatus,
    rpc_errors: byCode,
  })
  .strict();
export type TeamMetricsSnapshot = z.infer<typeof TeamMetricsSchema>;

export interface TeamMetrics {
  /** Adds one (or `by`) to a fixed counter; unknown names are a programming error and throw. */
  increment(name: TeamMetricCounter, by?: number): void;
  snapshot(): TeamMetricsSnapshot;
}

/** Builds the nested snapshot from flat `name → value` rows; missing counters read 0. */
export function metricsSnapshot(
  rows: ReadonlyArray<{ name: string; value: number }>,
): TeamMetricsSnapshot {
  const flat = new Map<string, number>();
  for (const row of rows)
    if (isTeamMetricCounter(row.name)) flat.set(row.name, row.value);
  const get = (name: TeamMetricCounter) => flat.get(name) ?? 0;
  const group = <K extends string>(prefix: string, keys: readonly K[]) =>
    Object.fromEntries(
      keys.map((key) => [key, get(`${prefix}.${key}` as TeamMetricCounter)]),
    ) as Record<K, number>;
  return TeamMetricsSchema.parse({
    schema_version: 1,
    sends: get("sends"),
    send_replays: get("send_replays"),
    conflicts: get("conflicts"),
    stream_connects: get("stream_connects"),
    stream_disconnects: get("stream_disconnects"),
    backfill_pages: get("backfill_pages"),
    links: get("links"),
    shares: get("shares"),
    rate_limit_hits: get("rate_limit_hits"),
    disabled_refusals: get("disabled_refusals"),
    denied_reads: group("denied_reads", METRIC_ERROR_CODES),
    agent_requests: group("agent_requests", METRIC_AGENT_STATUSES),
    rpc_errors: group("rpc_errors", METRIC_ERROR_CODES),
  });
}
