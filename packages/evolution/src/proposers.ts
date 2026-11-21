import type { ChatRequest, ChatResponse } from "@mars/contracts";
import { EvolutionError, fail } from "./errors";
import {
  type AgentManifest,
  type MutationProposal,
  MutationProposalSchema,
} from "./schemas";
import type { SelfImproveEntry } from "./selection";
import {
  enforcePathPolicy,
  matchesAny,
  parsePatch,
  snapshotDirectory,
} from "./tree";
import { bounded, scrubSecrets } from "./util";

export interface ArchiveSummaryEntry {
  candidate_id: string;
  parent_id: string | null;
  generation: number;
  depth: number;
  selection_score: number;
  eligible: boolean;
  unresolved: string[];
  unstable: string[];
}

export interface LineageEntry {
  candidate_id: string;
  parent_id: string | null;
  generation: number;
  depth: number;
  selection_score: number | null;
  hypothesis: string;
  changed_paths: string[];
}

export interface FailureTrace {
  source: "selection_eval" | "rejected_child";
  candidate_id: string;
  stage?: string;
  task_id?: string;
  rewards?: (number | null)[];
  notes: string[];
  reason?: string;
}

export interface HarnessPolicySummary {
  mutable_paths: string[];
  protected_paths: string[];
  max_patch_bytes: number;
}

/** What a proposer sees. Selection-split feedback only; the final test set is never included. */
export interface ProposalContext {
  run_id: string;
  generation: number;
  child_index: number;
  parent: {
    candidate_id: string;
    manifest: AgentManifest;
    selection_score: number;
    per_task: { task_id: string; mean: number }[];
  };
  entry: SelfImproveEntry;
  /** Scratch copy of the parent's harness tree. Edits here are ignored; only the returned patch counts. */
  harness_dir: string;
  seed: string;
  /** Selection-split archive summary (never contains final_test data). */
  archive?: ArchiveSummaryEntry[];
  /** Ancestor lineage from initial to parent (selection-split only). */
  lineage?: LineageEntry[];
  /** Selection-split failure traces and rejected-child reasons (never contains final_test data). */
  failure_traces?: FailureTrace[];
  /** Harness mutation policy so the proposer stays within mutable paths and patch size bounds. */
  harness_policy?: HarnessPolicySummary;
  /** Evaluator-applied component subset when the evaluator only applies a subset of manifest fields. */
  applied_components?: readonly string[] | undefined;
}

/**
 * Produces one mutation. Its output is untrusted: the host validates the
 * schema, refuses protected/out-of-allowlist paths, applies the patch in a
 * fresh workspace and re-digests control state before anything is evaluated.
 */
export interface MutationProposer {
  readonly id: string;
  propose(
    context: ProposalContext,
    signal: AbortSignal,
  ): Promise<MutationProposal>;
}

/** Deterministic proposer for tests and replay (no model). */
export function createScriptedProposer(
  id: string,
  script: (
    context: ProposalContext,
  ) => MutationProposal | Promise<MutationProposal>,
): MutationProposer {
  return {
    id,
    async propose(context) {
      return script(context);
    },
  };
}

/**
 * Structural subset of MARS `ModelRouter` (from `@mars/providers`) using
 * `@mars/contracts` types so `@mars/evolution` can route through MARS's
 * model provider/bridge directly.
 */
export interface ModelProposerClient {
  complete(
    request: ChatRequest,
    selection?: { model?: string; route?: string },
    signal?: AbortSignal,
  ): Promise<
    Pick<ChatResponse, "content"> & {
      model?: string | undefined;
      provider?: string | undefined;
      usage?:
        | {
            inputTokens?: number | undefined;
            outputTokens?: number | undefined;
            totalTokens?: number | undefined;
            costUsd?: number | undefined;
          }
        | undefined;
    }
  >;
}

export interface ModelProposerOptions {
  /** MARS ModelRouter or compatible chat-completion bridge. */
  client: ModelProposerClient;
  /** Model ID to request. Defaults to `"openrouter/free"`. */
  model?: string;
  /** Optional named route when not selecting a single explicit model. */
  route?: string;
  /**
   * Permit paid models. Defaults to `false`, enforcing free-tier OpenRouter
   * models (`openrouter/free` or `:free` suffix) for a strict $0.00 budget.
   */
  allowPaid?: boolean;
  /** Maximum response tokens requested from the model (default 2048). */
  maxTokens?: number;
  /** Sampling temperature (default 0.2). */
  temperature?: number;
  /** Maximum total bytes of mutable harness files included in the prompt (default 24000). */
  maxContextBytes?: number;
  /** Optional proposer identifier override. */
  id?: string;
}

export const DEFAULT_FREE_PROPOSER_MODEL = "openrouter/free";

/** True only for free-tier OpenRouter models (`openrouter/free` or `*:free`). */
export function isFreeOpenRouterModel(modelId: string): boolean {
  return modelId === "openrouter/free" || modelId.endsWith(":free");
}

function decoder(): TextDecoder {
  return new TextDecoder("utf-8", { fatal: false });
}

async function readMutableHarnessFiles(
  context: ProposalContext,
  maxContextBytes: number,
): Promise<{ path: string; content: string; truncated: boolean }[]> {
  let snap: Awaited<ReturnType<typeof snapshotDirectory>>;
  try {
    snap = await snapshotDirectory(context.harness_dir);
  } catch {
    return [];
  }
  const policy = context.harness_policy;
  const files: { path: string; content: string; truncated: boolean }[] = [];
  let usedBytes = 0;
  const decode = decoder();
  for (const entry of snap.entries) {
    if (policy) {
      if (matchesAny(entry.path, policy.protected_paths)) continue;
      if (!matchesAny(entry.path, policy.mutable_paths)) continue;
    }
    const blob = snap.blobs.get(entry.sha256);
    if (!blob) continue;
    if (usedBytes >= maxContextBytes) break;
    const remaining = maxContextBytes - usedBytes;
    const slice =
      blob.byteLength > remaining ? blob.subarray(0, remaining) : blob;
    const truncated = blob.byteLength > remaining;
    const text = scrubSecrets(decode.decode(slice));
    files.push({ path: entry.path, content: text, truncated });
    usedBytes += slice.byteLength;
  }
  return files;
}

/**
 * Extract a JSON object representing a `MutationProposal` from raw model text,
 * tolerating markdown code fences or brief surrounding prose.
 */
export function extractProposalJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) fail("invalid_input", "model proposer returned empty output");

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(trimmed);

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed;
      }
    } catch {
      // try next extraction strategy
    }
  }
  fail(
    "invalid_input",
    `model proposer did not return a valid JSON object: ${bounded(scrubSecrets(trimmed), 200)}`,
  );
}

/** Build the system and user messages handed to the model proposer. */
export async function buildProposalMessages(
  context: ProposalContext,
  maxContextBytes = 24_000,
): Promise<{ system: string; user: string }> {
  const mutableFiles = await readMutableHarnessFiles(context, maxContextBytes);
  const policy = context.harness_policy;
  const applied = context.applied_components;

  const system = [
    "You are the MARS DGM evolution proposer.",
    "Inspect the parent candidate's selection-split scores, archive summary, lineage, failure traces, and mutable harness files, then propose ONE small, concrete, testable mutation.",
    "Rules:",
    "1. Return ONLY a single valid JSON object (no prose outside the JSON).",
    '2. Schema: { "hypothesis": string, "patch"?: string, "prompts"?: Record<string, string>, "retrieval"?: { "repo_map_tokens": number, "memory_top_k": number, "context_window_tokens": number, "research": boolean } }.',
    "3. At least one of patch, prompts, or retrieval must change compared to the parent manifest.",
    '4. If proposing a patch in "patch", you MUST use exact git diff format starting with `diff --git a/<path> b/<path>`, followed by `--- a/<path>`, `+++ b/<path>`, and `@@ -oldStart,oldCount +newStart,newCount @@` hunks with exact matching lines from the mutable files below, ending with a trailing newline.',
    "5. NEVER touch protected paths or any path outside mutable_paths. Keep patch bytes strictly within max_patch_bytes.",
    applied && applied.length > 0
      ? `6. The evaluator only applies these components: ${applied.join(", ")}. Make sure your mutation modifies an applied component (for example, prompts.system_prompt if system_prompt is listed).`
      : "6. Prefer a minimal, targeted harness patch or prompt/parameter change that directly addresses the unresolved or unstable selection tasks.",
  ].join("\n");

  const payload = {
    run_id: context.run_id,
    generation: context.generation,
    child_index: context.child_index,
    entry: context.entry,
    parent: {
      candidate_id: context.parent.candidate_id,
      selection_score: context.parent.selection_score,
      per_task: context.parent.per_task,
      prompts: context.parent.manifest.prompts,
      retrieval: context.parent.manifest.retrieval,
    },
    archive: context.archive ?? [],
    lineage: context.lineage ?? [],
    failure_traces: context.failure_traces ?? [],
    harness_policy: policy ?? null,
    applied_components: applied ?? null,
    mutable_files: mutableFiles,
  };

  const user = [
    "Propose one bounded mutation for the next candidate based on this selection-split context:",
    JSON.stringify(payload, null, 2),
  ].join("\n\n");

  return { system, user };
}

/**
 * Real model-driven proposer routing through MARS's model provider/bridge
 * (`ModelRouter` or compatible `ModelProposerClient`).
 *
 * Enforces free-tier OpenRouter models (`openrouter/free` or `:free` suffix)
 * by default, inspects archive scores, lineage, failure traces, and mutable
 * harness files, and validates the returned proposal against `MutationProposalSchema`,
 * patch-size limits, and protected/mutable path policy before returning.
 */
export function createModelProposer(
  options: ModelProposerOptions,
): MutationProposer {
  const allowPaid = options.allowPaid === true;
  const model =
    options.model ?? (options.route ? undefined : DEFAULT_FREE_PROPOSER_MODEL);
  if (!allowPaid) {
    if (options.route !== undefined) {
      fail(
        "invalid_input",
        `model proposer refuses named route "${options.route}" unless allowPaid is true; named routes can select paid models`,
      );
    }
    if (model !== undefined && !isFreeOpenRouterModel(model)) {
      fail(
        "invalid_input",
        `model proposer refuses paid model "${model}"; only "openrouter/free" or ":free" models are allowed unless allowPaid is true`,
      );
    }
  }
  const maxTokens = options.maxTokens ?? 2048;
  const temperature = options.temperature ?? 0.2;
  const maxContextBytes = options.maxContextBytes ?? 24_000;
  const id =
    options.id ??
    `model:${model ?? options.route ?? DEFAULT_FREE_PROPOSER_MODEL}`;

  return {
    id,
    async propose(context, signal) {
      if (signal.aborted) fail("deadline_exceeded", "proposal aborted");
      const { system, user } = await buildProposalMessages(
        context,
        maxContextBytes,
      );
      if (signal.aborted) fail("deadline_exceeded", "proposal aborted");
      const selection: { model?: string; route?: string } = {};
      if (model !== undefined) selection.model = model;
      if (options.route !== undefined) selection.route = options.route;

      const startedAt = Date.now();
      const completePromise = options.client.complete(
        {
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          maxTokens,
          temperature,
        },
        selection,
        signal,
      );
      const response = await new Promise<Awaited<typeof completePromise>>(
        (resolvePromise, rejectPromise) => {
          const onAbort = () => {
            rejectPromise(
              new EvolutionError("deadline_exceeded", "proposal aborted"),
            );
          };
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
          completePromise.then(
            (value) => {
              signal.removeEventListener("abort", onAbort);
              resolvePromise(value);
            },
            (error) => {
              signal.removeEventListener("abort", onAbort);
              rejectPromise(error);
            },
          );
        },
      );
      if (signal.aborted) fail("deadline_exceeded", "proposal aborted");
      if (
        !allowPaid &&
        response.model !== undefined &&
        !isFreeOpenRouterModel(response.model)
      ) {
        fail(
          "invalid_input",
          `model proposer received paid model "${response.model}" while allowPaid is false`,
        );
      }

      const parsed = extractProposalJson(response.content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        delete (parsed as Record<string, unknown>).usage;
      }
      const proposal = MutationProposalSchema.parse(parsed);
      proposal.hypothesis = bounded(scrubSecrets(proposal.hypothesis), 4000);
      const rawTokens =
        response.usage?.totalTokens ??
        (response.usage?.inputTokens ?? 0) +
          (response.usage?.outputTokens ?? 0);
      const tokens =
        Number.isFinite(rawTokens) && rawTokens > 0 ? Math.round(rawTokens) : 0;
      const rawUsd = response.usage?.costUsd ?? 0;
      const usd = Number.isFinite(rawUsd) && rawUsd > 0 ? rawUsd : 0;
      const ms = Math.max(0, Math.round(Date.now() - startedAt));
      proposal.usage = { tokens, usd, ms };

      if (proposal.patch !== undefined && context.harness_policy) {
        const bytes = new TextEncoder().encode(proposal.patch).byteLength;
        if (bytes > context.harness_policy.max_patch_bytes) {
          fail(
            "unsafe_patch",
            `proposed patch (${bytes} bytes) exceeds max_patch_bytes (${context.harness_policy.max_patch_bytes})`,
          );
        }
        const parsedFiles = parsePatch(proposal.patch);
        enforcePathPolicy(
          parsedFiles.map((file) => file.path),
          context.harness_policy,
        );
      }

      return proposal;
    },
  };
}

export interface OpenRouterClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Lightweight OpenRouter `ModelProposerClient` for standalone callers that do
 * not already hold a `@mars/providers` `ModelRouter` instance.
 */
export function createOpenRouterProposerClient(
  options: OpenRouterClientOptions,
): ModelProposerClient {
  const baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(
    /\/+$/,
    "",
  );
  const timeoutMs = options.timeoutMs ?? 60_000;
  const doFetch = options.fetch ?? fetch;
  return {
    async complete(request, selection, signal) {
      if (signal?.aborted) fail("deadline_exceeded", "proposal aborted");
      const model = selection?.model ?? DEFAULT_FREE_PROPOSER_MODEL;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = signal
        ? AbortSignal.any([timeoutSignal, signal])
        : timeoutSignal;
      const response = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
          "http-referer": "https://mars.local",
          "x-title": "MARS Evolution Proposer",
        },
        body: JSON.stringify({
          model,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          ...(request.maxTokens !== undefined
            ? { max_tokens: request.maxTokens }
            : {}),
          ...(request.temperature !== undefined
            ? { temperature: request.temperature }
            : {}),
        }),
        signal: combinedSignal,
      });
      if (!response.ok) {
        const body = bounded(scrubSecrets(await response.text()), 400);
        fail(
          "invalid_state",
          `OpenRouter proposer HTTP ${response.status}: ${body}`,
        );
      }
      const json = (await response.json()) as {
        model?: string;
        choices?: { message?: { content?: string | null } }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          cost?: number;
        };
      };
      const content = json.choices?.[0]?.message?.content ?? "";
      return {
        content,
        model: json.model ?? model,
        provider: "openrouter",
        ...(json.usage
          ? {
              usage: {
                inputTokens: json.usage.prompt_tokens ?? 0,
                outputTokens: json.usage.completion_tokens ?? 0,
                totalTokens:
                  json.usage.total_tokens ??
                  (json.usage.prompt_tokens ?? 0) +
                    (json.usage.completion_tokens ?? 0),
                ...(typeof json.usage.cost === "number" &&
                Number.isFinite(json.usage.cost) &&
                json.usage.cost >= 0
                  ? { costUsd: json.usage.cost }
                  : {}),
              },
            }
          : {}),
      };
    },
  };
}
