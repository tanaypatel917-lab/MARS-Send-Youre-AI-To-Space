import { ResolveLimitsSchema } from "@mars/code-refs";
import {
  TEAM_MAX_BODY_CHARS,
  TEAM_MAX_CLIENT_MESSAGE_ID_CHARS,
  TEAM_MAX_REFERENCES,
  TEAM_MAX_TITLE_CHARS,
} from "@mars/contracts";
import { z } from "zod";

/**
 * Largest group any store may be configured for; `conversations.create_group`
 * accepts the same number of member ids, so a configured limit is always
 * reachable over RPC.
 */
export const TEAM_MAX_GROUP_SIZE = 32;
/** `references.search_paths` never returns more hits than this per call. */
export const TEAM_MAX_SEARCH_HITS = 50;
/** Preview caps reuse the `@mars/code-refs` resolver defaults (400 lines, 1 MiB). */
const CODE_REFS_DEFAULTS = ResolveLimitsSchema.parse({});
export const TEAM_MAX_PREVIEW_LINES = CODE_REFS_DEFAULTS.max_range_lines;
export const TEAM_MAX_PREVIEW_BLOB_BYTES = CODE_REFS_DEFAULTS.max_blob_bytes;

/** Server-side limits, in the style of `CollaborationLimitsSchema`. */
export const TeamLimitsSchema = z
  .object({
    max_body_bytes: z.number().int().positive().max(TEAM_MAX_BODY_CHARS),
    max_client_message_id_chars: z
      .number()
      .int()
      .positive()
      .max(TEAM_MAX_CLIENT_MESSAGE_ID_CHARS),
    max_title_chars: z.number().int().positive().max(TEAM_MAX_TITLE_CHARS),
    max_group_size: z.number().int().min(2).max(TEAM_MAX_GROUP_SIZE),
    page_limit: z.number().int().positive().max(200),
    max_page_bytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    max_cursors_per_poll: z.number().int().positive().max(50),
    max_poll_events: z.number().int().positive().max(1000),
    max_pending_idempotency_rows: z.number().int().positive().max(100_000),
    /** Concurrent `events.stream` connections per (team, user). */
    max_open_streams_per_user: z.number().int().positive().max(64),
    /** SSE heartbeat comment period; each heartbeat also re-polls the cursors. */
    stream_heartbeat_ms: z.number().int().min(50).max(120_000),
    /** Outbox rows pushed per stream pump; a longer backlog takes more pumps. */
    max_stream_batch_events: z.number().int().positive().max(1000),
    /** `messages.search` calls per (team, user) in a sliding minute. */
    max_search_per_minute: z.number().int().positive().max(10_000),
    /** Distinct reaction keys per message. */
    max_reactions_per_message: z.number().int().positive().max(256),
    /** Frame bytes a stream may hold for a consumer that is not reading. */
    max_stream_buffer_bytes: z
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024),
    /** Committed code references one message may carry. */
    max_references_per_message: z
      .number()
      .int()
      .positive()
      .max(TEAM_MAX_REFERENCES),
    /** `references.resolve` calls one user may make per sliding minute. */
    max_resolves_per_minute: z.number().int().positive().max(10_000),
    /** Lines a preview (or a stored range) may span; the code-refs `max_range_lines`. */
    max_preview_lines: z.number().int().positive().max(TEAM_MAX_PREVIEW_LINES),
    /** Largest blob a preview reads; the code-refs `max_blob_bytes`. */
    max_preview_blob_bytes: z
      .number()
      .int()
      .positive()
      .max(TEAM_MAX_PREVIEW_BLOB_BYTES),
    max_search_hits: z.number().int().positive().max(TEAM_MAX_SEARCH_HITS),
    /** Total bytes of message bodies and reference excerpts one @MARS request may freeze. */
    max_agent_context_bytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024),
    max_reference_excerpt_bytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024),
  })
  .strict();
export type TeamLimits = z.infer<typeof TeamLimitsSchema>;

export const DEFAULT_TEAM_LIMITS: TeamLimits = {
  max_body_bytes: TEAM_MAX_BODY_CHARS,
  max_client_message_id_chars: TEAM_MAX_CLIENT_MESSAGE_ID_CHARS,
  max_title_chars: TEAM_MAX_TITLE_CHARS,
  max_group_size: TEAM_MAX_GROUP_SIZE,
  page_limit: 200,
  max_page_bytes: 4 * 1024 * 1024,
  max_cursors_per_poll: 50,
  max_poll_events: 1000,
  max_pending_idempotency_rows: 10_000,
  max_open_streams_per_user: 4,
  stream_heartbeat_ms: 15_000,
  max_stream_batch_events: 200,
  max_search_per_minute: 60,
  max_reactions_per_message: 64,
  max_stream_buffer_bytes: 1024 * 1024,
  max_references_per_message: TEAM_MAX_REFERENCES,
  max_resolves_per_minute: 120,
  max_preview_lines: TEAM_MAX_PREVIEW_LINES,
  max_preview_blob_bytes: TEAM_MAX_PREVIEW_BLOB_BYTES,
  max_search_hits: TEAM_MAX_SEARCH_HITS,
  max_agent_context_bytes: 64 * 1024,
  max_reference_excerpt_bytes: 16 * 1024,
};
