import { z } from "zod";
import { MAX_PATH_LENGTH } from "./path-rules";

export const REPO_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
export const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const RepoIdSchema = z.string().regex(REPO_ID_PATTERN);
export const CommitShaSchema = z.string().regex(COMMIT_SHA_PATTERN);
const positiveInt = z.number().int().positive();

/** What the host registers at startup; never accepted from a client. */
export const RepoRegistrationSchema = z
  .object({
    repo_id: RepoIdSchema,
    dir: z.string().min(1),
    label: z.string().min(1).max(200),
  })
  .strict();
export type RepoRegistration = z.infer<typeof RepoRegistrationSchema>;

export const RepoSummarySchema = z
  .object({ repo_id: RepoIdSchema, label: z.string().min(1).max(200) })
  .strict();
export type RepoSummary = z.infer<typeof RepoSummarySchema>;

/** Raw client input; `validateLocator` applies the path and range rules. */
export const LocatorInputSchema = z
  .object({
    repo_id: z.string(),
    commit_sha: z.string(),
    path: z.string().max(MAX_PATH_LENGTH * 4),
    line_start: z.number().optional(),
    line_end: z.number().optional(),
  })
  .strict();
export type LocatorInput = z.infer<typeof LocatorInputSchema>;

/** A validated locator: NFC path, both line bounds present or both absent. */
export const LocatorSchema = z
  .object({
    repo_id: RepoIdSchema,
    commit_sha: CommitShaSchema,
    path: z.string().min(1).max(MAX_PATH_LENGTH),
    line_start: positiveInt.nullable(),
    line_end: positiveInt.nullable(),
  })
  .strict();
export type Locator = z.infer<typeof LocatorSchema>;

export const ResolveLimitsSchema = z
  .object({
    max_blob_bytes: positiveInt.default(1024 * 1024),
    max_range_lines: positiveInt.max(10_000).default(400),
    timeout_ms: positiveInt.max(120_000).default(10_000),
  })
  .strict();
export type ResolveLimits = z.infer<typeof ResolveLimitsSchema>;
export type ResolveLimitsInput = z.input<typeof ResolveLimitsSchema>;

export const LocatorRejectReasonSchema = z.enum([
  "invalid_input",
  "invalid_repo_id",
  "invalid_commit_sha",
  "path_empty_or_too_long",
  "path_control_characters",
  "path_backslash",
  "path_scheme_or_drive",
  "path_not_relative",
  "path_bad_segment",
  "path_reserved_characters",
  "path_git_segment",
  "path_invisible_code_point",
  "invalid_range",
  "range_too_large",
]);
export type LocatorRejectReason = z.infer<typeof LocatorRejectReasonSchema>;

export const ResolveErrorReasonSchema = z.enum([
  "git_unavailable",
  "timeout",
  "git_error",
  "output_truncated",
]);
export type ResolveErrorReason = z.infer<typeof ResolveErrorReasonSchema>;

const gitVersion = z.string().max(200).nullable();
const located = {
  repo_id: RepoIdSchema,
  commit_sha: CommitShaSchema,
  path: z.string().min(1).max(MAX_PATH_LENGTH),
  git_version: gitVersion,
};

export const RESOLVED_STATES = [
  "ok",
  "invalid",
  "unknown_repo",
  "unavailable",
  "is_directory",
  "unsupported_symlink",
  "unsupported_submodule",
  "oversized",
  "binary",
  "range_out_of_bounds",
  "error",
] as const;

export const ResolvedReferenceSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("ok"),
      ...located,
      blob_sha: CommitShaSchema,
      line_start: positiveInt,
      line_end: positiveInt,
      total_lines: z.number().int().nonnegative(),
      text: z.string(),
      text_sha256: z.string().regex(SHA256_PATTERN),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({ state: z.literal("invalid"), reason: LocatorRejectReasonSchema })
    .strict(),
  z
    .object({
      state: z.literal("unknown_repo"),
      repo_id: RepoIdSchema,
      commit_sha: CommitShaSchema,
      path: z.string().min(1).max(MAX_PATH_LENGTH),
    })
    .strict(),
  z.object({ state: z.literal("unavailable"), ...located }).strict(),
  z.object({ state: z.literal("is_directory"), ...located }).strict(),
  z.object({ state: z.literal("unsupported_symlink"), ...located }).strict(),
  z.object({ state: z.literal("unsupported_submodule"), ...located }).strict(),
  z
    .object({
      state: z.literal("oversized"),
      ...located,
      blob_sha: CommitShaSchema,
      size_bytes: z.number().int().nonnegative(),
      max_blob_bytes: positiveInt,
    })
    .strict(),
  z
    .object({
      state: z.literal("binary"),
      ...located,
      blob_sha: CommitShaSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("range_out_of_bounds"),
      ...located,
      blob_sha: CommitShaSchema,
      total_lines: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      state: z.literal("error"),
      ...located,
      reason: ResolveErrorReasonSchema,
    })
    .strict(),
]);
export type ResolvedReference = z.infer<typeof ResolvedReferenceSchema>;

export const SEARCH_MAX_LIMIT = 100;
export const SEARCH_MAX_QUERY_LENGTH = 256;

export const SearchPathsInputSchema = z
  .object({
    repo_id: z.string(),
    commit_sha: z.string(),
    query: z.string().max(SEARCH_MAX_QUERY_LENGTH * 4),
    limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).default(20),
  })
  .strict();
export type SearchPathsInput = z.input<typeof SearchPathsInputSchema>;

export const SearchLimitsSchema = z
  .object({
    /** Tree entries read before the listing is cut off. */
    max_entries: positiveInt.max(1_000_000).default(50_000),
    timeout_ms: positiveInt.max(120_000).default(10_000),
  })
  .strict();
export type SearchLimits = z.infer<typeof SearchLimitsSchema>;
export type SearchLimitsInput = z.input<typeof SearchLimitsSchema>;

export const PathMatchSchema = z
  .object({
    path: z.string().min(1).max(MAX_PATH_LENGTH),
    /** 0 = exact file name, 1 = file name prefix, 2 = path prefix, 3 = file name substring, 4 = path substring. */
    rank: z.number().int().min(0).max(4),
  })
  .strict();
export type PathMatch = z.infer<typeof PathMatchSchema>;

export const SearchRejectReasonSchema = z.enum([
  "invalid_input",
  "invalid_repo_id",
  "invalid_commit_sha",
  "invalid_query",
]);

export const SearchPathsResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("ok"),
      repo_id: RepoIdSchema,
      commit_sha: CommitShaSchema,
      matches: z.array(PathMatchSchema).max(SEARCH_MAX_LIMIT),
      /** Tree entries examined (unsafe paths are skipped, not listed). */
      scanned: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      truncated: z.boolean(),
      git_version: gitVersion,
    })
    .strict(),
  z
    .object({ state: z.literal("invalid"), reason: SearchRejectReasonSchema })
    .strict(),
  z
    .object({
      state: z.literal("unknown_repo"),
      repo_id: RepoIdSchema,
      commit_sha: CommitShaSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("unavailable"),
      repo_id: RepoIdSchema,
      commit_sha: CommitShaSchema,
      git_version: gitVersion,
    })
    .strict(),
  z
    .object({
      state: z.literal("error"),
      repo_id: RepoIdSchema,
      commit_sha: CommitShaSchema,
      reason: ResolveErrorReasonSchema,
      git_version: gitVersion,
    })
    .strict(),
]);
export type SearchPathsResult = z.infer<typeof SearchPathsResultSchema>;

/**
 * Shape of a stored `git_range` reference (TEAM_CHAT_DISCOVERY.md section 4.1).
 * Defined once in `packages/contracts/src/team.ts`; re-exported here so the
 * resolver and the chat service share the same runtime schema.
 */
export {
  type GitRangeReference,
  GitRangeReferenceSchema,
} from "@mars/contracts";
