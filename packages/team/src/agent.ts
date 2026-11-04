import type { AgentCitation, AgentRequest, ArtifactRef } from "@mars/contracts";
import { z } from "zod";

/**
 * @MARS request plumbing that lives in the team service. The service queues a
 * request and stores an answer; it never calls a model. Oh My Pi, opened by the
 * workbench adapter (`@mars/team-agent`), is the only loop.
 */

const id = z.string().min(1).max(256);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** Fixed, log-safe reason codes; free text is never accepted. */
export const AGENT_REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Exact message versions plus participants and reference access as they were at request time. */
export const AgentFrozenMessageSchema = z
  .object({
    message_id: id,
    seq: z.number().int().positive(),
    author_id: id,
    created_at: z.string().datetime({ offset: true }),
    body: z.string(),
    body_sha256: sha256,
    /** Threat id from the host scanner, or null; flagged bodies never reach a prompt. */
    flagged: id.nullable(),
  })
  .strict();
export type AgentFrozenMessage = z.infer<typeof AgentFrozenMessageSchema>;

export const AgentFrozenReferenceSchema = z
  .object({
    reference_id: id,
    /** Host-rendered label (e.g. `repo_id path@sha:lines`); never an absolute path. */
    label: z.string().max(512),
    text: z.string(),
    bytes: z.number().int().nonnegative(),
    flagged: id.nullable(),
  })
  .strict();
export type AgentFrozenReference = z.infer<typeof AgentFrozenReferenceSchema>;

export const AgentFrozenInputSchema = z
  .object({
    messages: z.array(AgentFrozenMessageSchema),
    references: z.array(AgentFrozenReferenceSchema),
    /** Active participants at request time, sorted; the audience must be exactly this set at publish time. */
    participants: z.array(id).min(1),
    /** Digest of `{reference_id, readers}` rows at request time; re-derived before publish. */
    reference_access_sha256: sha256,
  })
  .strict();
export type AgentFrozenInput = z.infer<typeof AgentFrozenInputSchema>;

/** What the host (a reference resolver with authorization) says about one reference for a set of viewers. */
export interface TeamReferenceAccess {
  reference_id: string;
  label: string;
  text: string;
  /** Viewers (a subset of the asked set) who may read the reference. */
  readers: readonly string[];
}

/**
 * Host-supplied, synchronous so it runs inside the store transaction that
 * authorizes the request. Unknown ids are omitted; the store treats a missing
 * row as unreadable by everyone.
 */
export interface TeamReferencePort {
  describe(input: {
    team_id: string;
    reference_ids: readonly string[];
    viewers: readonly string[];
  }): TeamReferenceAccess[];
}

export interface TeamAgentOptions {
  /** Free-first model choice from MARS policy; recorded in the preview digest and the request. */
  model(): { model_id: string; tier: "free" };
  /** Threat scanner (`scanThreat` from `@mars/memory`); a hit flags the item in the preview and the frozen input. */
  scan?(text: string): string | undefined;
  references?: TeamReferencePort;
}

export interface ClaimedAgentRequest {
  request: AgentRequest;
  input: AgentFrozenInput;
  /** Aborted by `agent.cancel` while the request runs. */
  signal: AbortSignal;
}

export interface AgentCompletion {
  answer_body: string;
  citations: AgentCitation[];
  dropped_citations?: number;
  evidence?: ArtifactRef | null;
}

/**
 * Host-only driver of queued requests. Not reachable over RPC: the workbench
 * process that owns the Oh My Pi session calls it after running the request.
 */
export interface TeamAgentHostPort {
  claimNext(): ClaimedAgentRequest | null;
  /** Re-checks the audience; a changed audience stores the answer as `restricted` without posting it. */
  complete(requestId: string, completion: AgentCompletion): AgentRequest;
  fail(requestId: string, reasonCode: string): AgentRequest;
}

export const AGENT_PUBLISH_REASONS = [
  "audience_changed",
  "reference_access_changed",
  "answer_too_large",
  "cancelled",
] as const;
