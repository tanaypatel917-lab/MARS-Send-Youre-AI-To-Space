import { z } from "zod";

/**
 * Team Chat records (PR 1 contracts). These adapt the "Proposed records" of
 * the Team Chat plan to repository conventions: strict Zod objects, snake_case
 * wire fields, bounded strings, and immutable code locators. Nothing here is
 * stored durably yet; `FixtureTeamService` holds them in memory.
 */

export const TEAM_CHAT_SCHEMA_VERSION = 1;

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const label = z.string().min(1).max(200);
const timestamp = z.string().datetime({ offset: true });
const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const line = z.number().int().positive().max(10_000_000);

export const MAX_MESSAGE_CHARS = 4000;
export const MAX_REFERENCES_PER_MESSAGE = 8;
export const MAX_GROUP_MEMBERS = 12;
export const MAX_BLOB_BYTES = 256 * 1024;

export const RoleSchema = z.enum(["owner", "admin", "member"]);
export const MembershipStateSchema = z.enum(["active", "invited", "removed"]);

export const TeamSchema = z.object({ team_id: id, name: label }).strict();
export type Team = z.infer<typeof TeamSchema>;

export const UserSchema = z
  .object({
    user_id: id,
    handle: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    display_name: label,
  })
  .strict();
export type User = z.infer<typeof UserSchema>;

/** Roles govern team administration only; repo access is a separate grant. */
export const MembershipSchema = z
  .object({
    team_id: id,
    user_id: id,
    role: RoleSchema,
    state: MembershipStateSchema,
  })
  .strict();
export type Membership = z.infer<typeof MembershipSchema>;

export const ConversationKindSchema = z.enum(["dm", "group"]);

/** Canonical DM pair: both user ids sorted and joined so a pair has one DM. */
export function canonicalPair(a: string, b: string): string {
  return [a, b].sort().join("|");
}

export const ConversationSchema = z
  .object({
    conversation_id: id,
    team_id: id,
    kind: ConversationKindSchema,
    title: label.nullable(),
    /** `canonicalPair(a, b)` for DMs, null for groups. */
    canonical_pair: z
      .string()
      .regex(/^[A-Za-z0-9._:-]+\|[A-Za-z0-9._:-]+$/)
      .nullable(),
    created_at: timestamp,
  })
  .strict()
  .refine(
    (c) => (c.kind === "dm") === (c.canonical_pair !== null),
    "DMs carry a canonical pair and groups do not",
  );
export type Conversation = z.infer<typeof ConversationSchema>;

/** Per-member conversation settings. `read_cursor` is a server sequence (0 = nothing read). */
export const ParticipantSchema = z
  .object({
    conversation_id: id,
    user_id: id,
    pinned: z.boolean(),
    read_cursor: z.number().int().nonnegative(),
    /** Server sequence at which this member joined; history before it is hidden. */
    joined_at_sequence: z.number().int().nonnegative(),
  })
  .strict();
export type Participant = z.infer<typeof ParticipantSchema>;

export const MessageSchema = z
  .object({
    message_id: id,
    conversation_id: id,
    author_id: id,
    /** Server-assigned, dense within a conversation. */
    sequence,
    /** Client-generated; unique per author and conversation. */
    client_message_id: id,
    body: z.string().max(MAX_MESSAGE_CHARS),
    reply_to: id.nullable(),
    created_at: timestamp,
  })
  .strict();
export type Message = z.infer<typeof MessageSchema>;

export const ReactionEmojiSchema = z.enum(["👍", "✅", "👀", "🎉", "❓"]);
export type ReactionEmoji = z.infer<typeof ReactionEmojiSchema>;

/** Unique per (message, user, emoji). */
export const ReactionSchema = z
  .object({ message_id: id, user_id: id, emoji: ReactionEmojiSchema })
  .strict();
export type Reaction = z.infer<typeof ReactionSchema>;

export const ReferenceKindSchema = z.enum(["file", "range", "symbol"]);
export type ReferenceKind = z.infer<typeof ReferenceKindSchema>;

export const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

/** Repo-relative, `/`-separated, no empty, `.` or `..` segments, no backslash or NUL. */
export const RepoPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isNormalizedRepoPath, "path must be a normalized repo-relative path");

export function isNormalizedRepoPath(path: string): boolean {
  if (path.startsWith("/") || path.endsWith("/")) return false;
  if (/[\\\0]/.test(path)) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Who may see the reference: the team it was shared in and the trusted repo. */
export const AccessScopeSchema = z
  .object({ team_id: id, repo_id: id })
  .strict();

/**
 * A committed code locator. A repo is identified by a trusted id (never a
 * folder path or a display name) and the revision is a full commit SHA, so a
 * later branch move or rename does not change what the reference points to.
 */
export const ReferenceSchema = z
  .object({
    reference_id: id,
    kind: ReferenceKindSchema,
    repo_id: id,
    commit_sha: CommitShaSchema,
    path: RepoPathSchema,
    line_start: line.nullable(),
    line_end: line.nullable(),
    symbol: z.string().min(1).max(200).nullable(),
    access_scope: AccessScopeSchema,
  })
  .strict()
  .refine(
    (r) => (r.line_start === null) === (r.line_end === null),
    "a range needs both ends",
  )
  .refine(
    (r) =>
      r.line_start === null ||
      r.line_end === null ||
      r.line_start <= r.line_end,
    "line_start must not exceed line_end",
  )
  .refine(
    (r) => r.kind !== "range" || r.line_start !== null,
    "range references need lines",
  )
  .refine(
    (r) => r.kind !== "symbol" || r.symbol !== null,
    "symbol references name the symbol",
  );
export type Reference = z.infer<typeof ReferenceSchema>;

/** Links a message to a reference it shares. */
export const ShareSchema = z
  .object({ message_id: id, reference_id: id })
  .strict();
export type Share = z.infer<typeof ShareSchema>;

/** A trusted repo mapping. Display names are labels, never identifiers. */
export const RepoSchema = z
  .object({ repo_id: id, name: label, default_branch: label })
  .strict();
export type Repo = z.infer<typeof RepoSchema>;

/** Per-user repo access; the sender's access never authorizes a viewer. */
export const RepoAccessSchema = z.object({ user_id: id, repo_id: id }).strict();
export type RepoAccess = z.infer<typeof RepoAccessSchema>;

/** A committed blob the fixture resolver can serve at an exact revision. */
export const BlobSchema = z
  .object({
    repo_id: id,
    commit_sha: CommitShaSchema,
    path: RepoPathSchema,
    text: z.string().max(MAX_BLOB_BYTES),
    symbols: z
      .array(z.object({ name: z.string().min(1).max(200), line }).strict())
      .max(500),
  })
  .strict();
export type Blob = z.infer<typeof BlobSchema>;

export const FixtureDatasetSchema = z
  .object({
    schema_version: z.literal(TEAM_CHAT_SCHEMA_VERSION),
    label: z.literal("FIXTURE"),
    team: TeamSchema,
    users: z.array(UserSchema).min(1).max(50),
    memberships: z.array(MembershipSchema).max(50),
    repos: z.array(RepoSchema).max(20),
    repo_access: z.array(RepoAccessSchema).max(200),
    blobs: z.array(BlobSchema).max(50),
    conversations: z.array(ConversationSchema).max(50),
    participants: z.array(ParticipantSchema).max(200),
    messages: z.array(MessageSchema).max(2000),
    reactions: z.array(ReactionSchema).max(2000),
    references: z.array(ReferenceSchema).max(500),
    shares: z.array(ShareSchema).max(1000),
  })
  .strict()
  .superRefine((data, ctx) => {
    const pairs = new Set<string>();
    for (const conversation of data.conversations) {
      const members = data.participants
        .filter((p) => p.conversation_id === conversation.conversation_id)
        .map((p) => p.user_id);
      if (conversation.kind !== "dm") {
        if (members.length < 2)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `group ${conversation.conversation_id} needs at least two participants`,
          });
        continue;
      }
      const [a, b] = members;
      if (
        members.length !== 2 ||
        a === undefined ||
        b === undefined ||
        a === b
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `DM ${conversation.conversation_id} needs exactly two distinct participants`,
        });
        continue;
      }
      if (conversation.canonical_pair !== canonicalPair(a, b))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `DM ${conversation.conversation_id} canonical_pair does not match its participants`,
        });
      const key = `${conversation.team_id}|${conversation.canonical_pair}`;
      if (pairs.has(key))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate DM for pair ${conversation.canonical_pair} in team ${conversation.team_id}`,
        });
      pairs.add(key);
    }
  });
export type FixtureDataset = z.infer<typeof FixtureDatasetSchema>;

// ---------------------------------------------------------------- operations

/** A reference as attached by the composer; the service assigns the id and access scope. */
export const ReferenceInputSchema = z
  .object({
    kind: ReferenceKindSchema,
    repo_id: id,
    commit_sha: CommitShaSchema,
    path: RepoPathSchema,
    line_start: line.nullable(),
    line_end: line.nullable(),
    symbol: z.string().min(1).max(200).nullable(),
  })
  .strict()
  .refine(
    (r) => (r.line_start === null) === (r.line_end === null),
    "a range needs both ends",
  )
  .refine(
    (r) =>
      r.line_start === null ||
      r.line_end === null ||
      r.line_start <= r.line_end,
    "line_start must not exceed line_end",
  );
export type ReferenceInput = z.infer<typeof ReferenceInputSchema>;

/** `sendMessage` input: everything the client decides, nothing the server assigns. */
export const SendMessageInputSchema = z
  .object({
    conversation_id: id,
    client_message_id: id,
    body: z.string().max(MAX_MESSAGE_CHARS),
    reply_to: id.nullable(),
    references: z.array(ReferenceInputSchema).max(MAX_REFERENCES_PER_MESSAGE),
  })
  .strict();
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export const TeamErrorCodeSchema = z.enum([
  "not_found",
  "forbidden",
  "invalid",
  "client_message_id_reused",
  "reply_outside_conversation",
  "reference_not_attachable",
  "too_many_references",
  "empty_message",
  /** The same `client_message_id` was committed with a different body: edit and resend. */
  "conflict",
  /** The service could not be reached or rejected the credential; fixed text only. */
  "unavailable",
  "unauthorized",
]);
export type TeamErrorCode = z.infer<typeof TeamErrorCodeSchema>;

export type TeamResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: TeamErrorCode };

export function fail<T = never>(code: TeamErrorCode): TeamResult<T> {
  return { ok: false, code };
}

export function succeed<T>(value: T): TeamResult<T> {
  return { ok: true, value };
}
