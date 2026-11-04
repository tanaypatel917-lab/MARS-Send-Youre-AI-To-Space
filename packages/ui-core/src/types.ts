import {
  type JournalResult,
  JournalResultSchema,
  WorkbenchDescribeFields,
  WorkbenchInspectFields,
} from "@mars/contracts";
import { z } from "zod";

/** §8.3 `tasks.journal` reply rows, as the host declares them. Text is untrusted model output, rendered as data. */
export const JournalReplySchema = JournalResultSchema;
export type JournalEntry = JournalResult[number];

export type JournalState =
  | { status: "unknown" }
  | { status: "unavailable" }
  | { status: "available"; entries: ReadonlyMap<string, JournalEntry> };

/** §8.3 additive `workbench.describe` fields, exactly as the host declares them; each may be absent on older hosts. */
export const DescribeExtrasSchema = z.object(WorkbenchDescribeFields);
export type DescribeExtras = z.infer<typeof DescribeExtrasSchema>;
/** §8.3 additive `tasks.inspect` fields, exactly as the host declares them; each may be absent on older hosts. */
export const InspectExtrasSchema = z.object(WorkbenchInspectFields);
export type InspectExtras = z.infer<typeof InspectExtrasSchema>;
export type ContextRow = NonNullable<InspectExtras["context_rows"]>[number];
