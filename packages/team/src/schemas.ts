import {
  TEAM_MAX_BODY_CHARS,
  TEAM_MAX_CLIENT_MESSAGE_ID_CHARS,
  TEAM_MAX_TITLE_CHARS,
} from "@mars/contracts";
import { z } from "zod";

/**
 * Largest group any store may be configured for; `conversations.create_group`
 * accepts the same number of member ids, so a configured limit is always
 * reachable over RPC.
 */
export const TEAM_MAX_GROUP_SIZE = 32;

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
};
