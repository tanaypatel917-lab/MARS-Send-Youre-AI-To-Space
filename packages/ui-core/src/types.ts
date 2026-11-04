import { z } from "zod";

/** §8.3 `tasks.journal` reply rows. Text is untrusted model output, rendered as data. */
export const JournalEntrySchema = z
  .object({
    entry_id: z.string().min(1).max(256),
    kind: z.string().min(1).max(128),
    text: z.string().max(1_048_576),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        cost_usd: z.number().finite().nonnegative().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type JournalEntry = z.infer<typeof JournalEntrySchema>;
export const JournalReplySchema = z.array(JournalEntrySchema).max(1_000);

export type JournalState =
  | { status: "unknown" }
  | { status: "unavailable" }
  | { status: "available"; entries: ReadonlyMap<string, JournalEntry> };

const GraphStateSchema = z.enum([
  "not_built",
  "ready",
  "stale",
  "unavailable",
  "failed",
]);

/** §8.3 optional `workbench.describe` fields; every one may be absent on today's host. */
export const DescribeExtrasSchema = z
  .object({
    connectors: z.array(z.unknown()).optional(),
    image: z.object({ digest: z.string() }).passthrough().nullable().optional(),
    conventions: z
      .object({
        instructions: z.unknown().optional(),
        hooks: z.unknown().optional(),
        commands: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    policy: z
      .object({
        allow_paid: z.boolean().optional(),
        allow_screen_capture: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    graph: z
      .object({
        state: GraphStateSchema,
        revision: z.string().nullable().optional(),
        built_at: z.string().nullable().optional(),
        isolation: z.string().nullable().optional(),
        workspace_revision: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    vault: z
      .object({
        pending_proposals: z.number().int().nonnegative().optional(),
        last_export_at: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    providers: z
      .array(
        z
          .object({
            id: z.string(),
            kind: z.enum(["local", "omniroute", "direct"]),
            health: z.string().optional(),
            catalog_stale: z.boolean().optional(),
            policy_owner: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type DescribeExtras = z.infer<typeof DescribeExtrasSchema>;

export const ContextRowSchema = z
  .object({
    item: z.string(),
    tokens: z.number().int().nonnegative(),
    cost_usd: z.number().finite().nonnegative().nullable().optional(),
    source: z.string(),
    remedy: z.string().nullable().optional(),
    trust: z.string().optional(),
  })
  .passthrough();
export type ContextRow = z.infer<typeof ContextRowSchema>;

/** §8.3 optional `tasks.inspect` fields. */
export const InspectExtrasSchema = z
  .object({
    model_tier: z
      .object({
        model_id: z.string(),
        tier: z.enum(["free", "local", "paid"]),
        input_usd_per_million: z.number().nullable().optional(),
        output_usd_per_million: z.number().nullable().optional(),
        route: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    usage_totals: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        cost_usd: z.number().nullable().optional(),
        context_tokens: z.number().int().nonnegative().optional(),
        context_window: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
    pinned: z
      .array(
        z
          .object({ path: z.string(), bytes: z.number(), trust: z.string() })
          .passthrough(),
      )
      .optional(),
    context_rows: z.array(ContextRowSchema).optional(),
    approvals: z
      .object({ read: z.boolean(), write: z.boolean(), execute: z.boolean() })
      .optional(),
    mode: z.string().optional(),
  })
  .passthrough();
export type InspectExtras = z.infer<typeof InspectExtrasSchema>;

/** Field-by-field lenient read: a malformed optional field is dropped, never fatal. */
export function readExtras<T extends z.ZodRawShape>(
  schema: z.ZodObject<T, "passthrough">,
  value: unknown,
): Partial<z.infer<z.ZodObject<T>>> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const raw = (value as Record<string, unknown>)[key];
    if (raw === undefined) continue;
    const parsed = (field as z.ZodTypeAny).safeParse(raw);
    if (parsed.success) result[key] = parsed.data;
  }
  return result as Partial<z.infer<z.ZodObject<T>>>;
}
