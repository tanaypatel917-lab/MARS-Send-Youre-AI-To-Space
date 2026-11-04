import { z } from "zod";

const count = z.number().int().nonnegative();
const id = z.string().min(1).max(256);
export const WorkbenchUsageSchema = z
  .object({
    input_tokens: count,
    output_tokens: count,
    cost_usd: z.number().finite().nonnegative().nullable(),
  })
  .strict();
export const WorkbenchGraphSchema = z
  .object({
    state: z.enum([
      "not_built",
      "building",
      "ready",
      "stale",
      "unavailable",
      "failed",
    ]),
    revision: id.nullable(),
    built_at: z.string().datetime().nullable(),
    isolation: z.enum(["process_env", "os_wrapper"]).nullable(),
  })
  .strict();
export const WorkbenchVaultSchema = z
  .object({
    pending_proposals: count,
    last_export_at: z.string().datetime().nullable(),
  })
  .strict();
export const WorkbenchProviderSchema = z
  .object({
    id,
    kind: z.enum(["local", "omniroute", "direct"]),
    health: z.enum(["unknown", "available", "unavailable"]),
    catalog_stale: z.boolean(),
    policy_owner: z.literal("mars"),
  })
  .strict();
export const WorkbenchDescribeFields = {
  connectors: z.array(z.never()).max(0).optional(),
  image: z
    .object({ digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
    .strict()
    .nullable()
    .optional(),
  conventions: z
    .object({ instructions: count, hooks: count, commands: count })
    .strict()
    .optional(),
  policy: z
    .object({ allow_paid: z.boolean(), allow_screen_capture: z.boolean() })
    .strict()
    .optional(),
  graph: WorkbenchGraphSchema.nullable().optional(),
  vault: WorkbenchVaultSchema.nullable().optional(),
  providers: z.array(WorkbenchProviderSchema).max(1000).optional(),
};
export const WorkbenchInspectFields = {
  model_tier: z.enum(["free", "paid", "local"]).nullable().optional(),
  usage_totals: WorkbenchUsageSchema.optional(),
  pinned: z
    .array(
      z
        .object({
          path: z.string().min(1).max(4096),
          bytes: count,
          trust: z.literal("untrusted"),
        })
        .strict(),
    )
    .max(1000)
    .optional(),
  context_rows: z
    .array(
      z
        .object({
          source: z.string().min(1).max(256),
          tokens: count.nullable(),
          cost_usd: z.number().finite().nonnegative().nullable(),
          remedy: z.string().min(1).max(1024),
        })
        .strict(),
    )
    .max(1000)
    .optional(),
};
export const MAX_JOURNAL_ENTRY_IDS = 100;
export const JournalEntryIdsSchema = z.array(id).max(MAX_JOURNAL_ENTRY_IDS);
export const JournalResultSchema = z
  .array(
    z
      .object({
        entry_id: id,
        kind: z.enum([
          "user",
          "assistant",
          "reasoning",
          "tool_result",
          "compaction",
          "not_found",
        ]),
        text: z.string().max(128 * 1024),
        usage: WorkbenchUsageSchema.optional(),
      })
      .strict(),
  )
  .max(MAX_JOURNAL_ENTRY_IDS * 2);
export type JournalResult = z.infer<typeof JournalResultSchema>;
