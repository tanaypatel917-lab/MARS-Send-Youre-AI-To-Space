import { z } from "zod";

/**
 * MARS Output Format: the structured model-to-UI contract parsed from agent
 * text. Everything here is untrusted model output; follow-ups, app triggers
 * and review links are proposals the host validates before acting.
 */
export const OUTPUT_FORMAT_VERSION = 1;

export const WRITING_BLOCK_ID_PATTERN = /^\d{5}$/;

export const WritingVariantSchema = z.enum([
  "email",
  "document",
  "post",
  "message",
  "note",
  "summary",
  "plan",
  "commit",
]);
export type WritingVariant = z.infer<typeof WritingVariantSchema>;

const line = z.number().int().positive();

export const SourceSpanSchema = z
  .object({ start_line: line, end_line: line })
  .strict();
export type SourceSpan = z.infer<typeof SourceSpanSchema>;

export const ToneSectionSchema = z
  .object({ tone: z.string().min(1), body: z.string() })
  .strict();
export type ToneSection = z.infer<typeof ToneSectionSchema>;

export const EmailHeaderSchema = z
  .object({
    subject: z.string().nullable(),
    recipient: z.array(z.string()),
    cc: z.array(z.string()),
    bcc: z.array(z.string()),
  })
  .strict();
export type EmailHeader = z.infer<typeof EmailHeaderSchema>;

export const WritingBlockSchema = z
  .object({
    kind: z.literal("writing"),
    id: z.string().regex(WRITING_BLOCK_ID_PATTERN),
    variant: WritingVariantSchema,
    attributes: z.record(z.string(), z.string()),
    email: EmailHeaderSchema.nullable(),
    tones: z.array(ToneSectionSchema),
    body: z.string(),
    span: SourceSpanSchema,
  })
  .strict();
export type WritingBlock = z.infer<typeof WritingBlockSchema>;

export const FollowUpSchema = z
  .object({
    kind: z.literal("follow_up"),
    label: z.string().min(1),
    prompt: z.string().min(1),
    tag: z.enum(["mars-followup", "codex-followup"]),
    span: SourceSpanSchema,
  })
  .strict();
export type FollowUp = z.infer<typeof FollowUpSchema>;

export const MarkdownSegmentSchema = z
  .object({
    kind: z.literal("markdown"),
    text: z.string(),
    span: SourceSpanSchema,
  })
  .strict();
export type MarkdownSegment = z.infer<typeof MarkdownSegmentSchema>;

export const OutputSegmentSchema = z.discriminatedUnion("kind", [
  MarkdownSegmentSchema,
  WritingBlockSchema,
  FollowUpSchema,
]);
export type OutputSegment = z.infer<typeof OutputSegmentSchema>;

export const LinkKindSchema = z.enum([
  "external",
  "local",
  "anchor",
  "app",
  "review",
  "other",
]);
export type LinkKind = z.infer<typeof LinkKindSchema>;

export const OutputLinkSchema = z
  .object({
    kind: LinkKindSchema,
    label: z.string(),
    target: z.string(),
    line,
    block_id: z.string().regex(WRITING_BLOCK_ID_PATTERN).nullable(),
  })
  .strict();
export type OutputLink = z.infer<typeof OutputLinkSchema>;

export const AppTriggerSchema = z
  .object({
    label: z.string(),
    connector_id: z.string().min(1),
    line,
  })
  .strict();
export type AppTrigger = z.infer<typeof AppTriggerSchema>;

export const ReviewLinkSchema = z
  .object({
    label: z.string(),
    scheme: z.enum(["mars", "codex"]),
    pr: z.string().url(),
    path: z.string().min(1),
    line_start: line,
    line_end: line,
    side: z.enum(["left", "right"]),
    line,
  })
  .strict();
export type ReviewLink = z.infer<typeof ReviewLinkSchema>;

export const OutputErrorCodeSchema = z.enum([
  "malformed_fence",
  "unclosed_fence",
  "nested_fence",
  "invalid_block_id",
  "duplicate_id",
  "unknown_variant",
  "malformed_link",
  "backtick_in_link",
  "forbidden_link_scheme",
  "unknown_connector",
  "malformed_review_link",
  "review_range_too_wide",
  "malformed_followup",
  "invented_address",
]);
export type OutputErrorCode = z.infer<typeof OutputErrorCodeSchema>;

export const OutputErrorSchema = z
  .object({
    code: OutputErrorCodeSchema,
    message: z.string().min(1),
    line,
    block_id: z.string().nullable(),
  })
  .strict();
export type OutputError = z.infer<typeof OutputErrorSchema>;

export const OutputDocumentSchema = z
  .object({
    format_version: z.literal(OUTPUT_FORMAT_VERSION),
    segments: z.array(OutputSegmentSchema),
    links: z.array(OutputLinkSchema),
    app_triggers: z.array(AppTriggerSchema),
    review_links: z.array(ReviewLinkSchema),
    errors: z.array(OutputErrorSchema),
  })
  .strict();
export type OutputDocument = z.infer<typeof OutputDocumentSchema>;

/** Host-supplied facts the validator checks model output against. */
export interface OutputValidationContext {
  /** Registered connector ids that `app://` triggers may name. */
  connector_ids: readonly string[];
  /** Email addresses the user supplied; any other address is invented. */
  allowed_addresses: readonly string[];
  /** Widest permitted `mars://review` line range (inclusive). Default 40. */
  max_review_lines?: number;
}
