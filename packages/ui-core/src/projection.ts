import type { EventEnvelope, VerificationView } from "@mars/contracts";
import { LIMITS } from "./limits";
import type { JournalEntry, JournalState } from "./types";

/** One `tasks.events` row with its decoded payload artifact (absent when not fetched). */
export interface ProjectionEvent {
  event: EventEnvelope;
  payload?: unknown;
}

export interface ProjectionTask {
  task_id: string;
  request: string;
  status: string;
}

export interface DiffFileInput {
  path: string;
  status: "added" | "modified" | "deleted";
  patch: string;
}

export interface ProjectionInput {
  task?: ProjectionTask;
  events: readonly ProjectionEvent[];
  journal?: JournalState;
  /** `text/plain` final artifact, when the task produced one. */
  finalText?: string | null;
  diff?: { files: readonly DiffFileInput[] } | null;
  verification?: VerificationView | null;
  limit?: number;
}

/** Where untrusted text came from; rendered on the card so provenance is always visible. */
export interface Provenance {
  source: string;
  event_id: string | null;
}

export type ToolStatus = "ok" | "error" | "blocked" | "running";

export interface ToolEntry {
  kind: "tool";
  id: string;
  name: string;
  primary: string | null;
  status: ToolStatus;
  output: string;
  provenance: Provenance;
}

export interface DiffFileEntry {
  path: string;
  status: "added" | "modified" | "deleted";
  added: number;
  removed: number;
  patch: string;
}

export interface ResearchFinding {
  finding_id: string;
  claim: string | null;
  source: string | null;
  confidence: number | null;
  used: boolean | null;
  stale: boolean;
  excerpt: string | null;
}

export type Entry =
  | { kind: "earlier"; id: string; count: number }
  | {
      kind: "user";
      id: string;
      text: string;
      source: "request" | "steer";
      provenance: Provenance;
    }
  | {
      kind: "turn";
      id: string;
      observed: string;
      summary: string | null;
      entry_ids: string[];
      running: boolean;
      provenance: Provenance;
    }
  | {
      kind: "assistant";
      id: string;
      text: string;
      provenance: Provenance;
    }
  | {
      kind: "thinking";
      id: string;
      text: string;
      tokens: number | null;
      provenance: Provenance;
    }
  | ToolEntry
  | {
      kind: "explored";
      id: string;
      counts: { verb: string; count: number }[];
      tools: ToolEntry[];
    }
  | {
      kind: "hook";
      id: string;
      phase: string;
      command: string;
      exit_code: number | null;
      blocked: boolean;
      reason: string | null;
      output: string;
      provenance: Provenance;
    }
  | {
      kind: "diff";
      id: string;
      files: DiffFileEntry[];
      added: number;
      removed: number;
    }
  | {
      kind: "child";
      id: string;
      label: string;
      status: string;
      tool_calls: number | null;
      model: string | null;
      tier: string | null;
      provenance: Provenance;
    }
  | {
      kind: "research";
      id: string;
      findings: ResearchFinding[];
      provenance: Provenance;
    }
  | {
      kind: "evidence";
      id: string;
      check: string;
      evidence_kind: string;
      verdict: string;
      verified: boolean;
      advisory: boolean;
      files: string[];
      summary: string;
      record: unknown;
      provenance: Provenance;
    }
  | {
      kind: "proposal";
      id: string;
      proposal_kind: string;
      scope: string;
      revision: string | null;
      before: string;
      after: string;
      decision: string | null;
      provenance: Provenance;
    }
  | {
      kind: "graph";
      id: string;
      operation: string;
      status: string;
      revision: string | null;
      isolation: string | null;
      summary: string;
      provenance: Provenance;
    }
  | {
      kind: "notice";
      id: string;
      tone: "info" | "warning" | "error";
      text: string;
      detail: string | null;
    }
  | {
      kind: "error";
      id: string;
      code: string;
      text: string;
      detail: string | null;
    }
  | {
      kind: "summary";
      id: string;
      status: string;
      seconds: number | null;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number | null;
      tools: number;
    };

export type EntryKind = Entry["kind"];

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  /** `null` while every usage row is free (no `cost_usd`). */
  cost_usd: number | null;
}

export interface TranscriptProjection {
  entries: Entry[];
  /** Entries dropped from the front to stay within the limit. */
  trimmed: number;
  totals: UsageTotals;
  /** Running children by label, for the status line. */
  children: number;
  verify: { pass: number; fail: number };
  journal: JournalState["status"];
  last_event_id: string | null;
}

/** Read-only tool names that fold into one `Explored ›` card (§2.1). */
export const READ_ONLY_TOOLS: Readonly<Record<string, string>> = {
  mars_read: "read",
  mars_list: "list",
  mars_glob: "list",
  mars_grep: "search",
  mars_search: "search",
  mars_history: "history",
  mars_research_findings: "research",
};

const THINKING_KINDS = new Set(["thinking", "reasoning"]);
const TEXT_KINDS = new Set([
  "assistant",
  "text",
  "message",
  "assistant_message",
]);

type Bag = Record<string, unknown>;
const bag = (value: unknown): Bag =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Bag)
    : {};
const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

export function countDiffLines(patch: string): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function toolStatus(payload: Bag): ToolStatus {
  const status = str(payload.status);
  if (status === "blocked") return "blocked";
  if (status === "running") return "running";
  if (status === "error" || status === "failed" || payload.ok === false)
    return "error";
  return "ok";
}

function diffEntry(id: string, files: readonly DiffFileInput[]): Entry {
  const rows = files.map((file) => ({
    ...file,
    ...countDiffLines(file.patch),
  }));
  return {
    kind: "diff",
    id,
    files: rows,
    added: rows.reduce((sum, file) => sum + file.added, 0),
    removed: rows.reduce((sum, file) => sum + file.removed, 0),
  };
}

/**
 * Projects `tasks.events` (+ optional `tasks.journal` text) into rendered entries,
 * oldest first, bounded to `limit` entries. Pure: the RPC log stays the source of truth.
 */
export function projectTranscript(
  input: ProjectionInput,
): TranscriptProjection {
  const limit = input.limit ?? LIMITS.renderedEntries;
  const journal = input.journal ?? { status: "unknown" };
  const entries: Entry[] = [];
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: null as number | null,
  };
  const children = new Map<string, string>();
  const verify = { pass: 0, fail: 0 };
  const seenEntries = new Set<string>();
  const findings = new Map<string, ResearchFinding>();
  let toolsThisTurn = 0;
  let turnStarted: string | null = null;
  const running = input.task?.status === "running";

  if (input.task)
    entries.push({
      kind: "user",
      id: `request:${input.task.task_id}`,
      text: input.task.request,
      source: "request",
      provenance: { source: "tasks.inspect.request", event_id: null },
    });

  const pushTool = (tool: ToolEntry) => {
    toolsThisTurn++;
    const verb = READ_ONLY_TOOLS[tool.name];
    const previous = entries.at(-1);
    if (verb && tool.status === "ok") {
      if (previous?.kind === "explored") {
        previous.tools.push(tool);
        const count = previous.counts.find((row) => row.verb === verb);
        if (count) count.count++;
        else previous.counts.push({ verb, count: 1 });
        return;
      }
      if (
        previous?.kind === "tool" &&
        previous.status === "ok" &&
        READ_ONLY_TOOLS[previous.name]
      ) {
        const firstVerb = READ_ONLY_TOOLS[previous.name] as string;
        entries[entries.length - 1] = {
          kind: "explored",
          id: `explored:${previous.id}`,
          counts:
            firstVerb === verb
              ? [{ verb, count: 2 }]
              : [
                  { verb: firstVerb, count: 1 },
                  { verb, count: 1 },
                ],
          tools: [previous, tool],
        };
        return;
      }
    }
    entries.push(tool);
  };

  for (const { event, payload: rawPayload } of input.events) {
    const payload = bag(rawPayload);
    const provenance: Provenance = {
      source: event.producer,
      event_id: event.event_id,
    };
    const id = `event:${event.event_id}`;
    turnStarted ??= event.occurred_at;
    if (event.usage) {
      totals.input_tokens += event.usage.input_tokens;
      totals.output_tokens += event.usage.output_tokens;
      if (event.usage.cost_usd !== null)
        totals.cost_usd = (totals.cost_usd ?? 0) + event.usage.cost_usd;
    }
    switch (event.event_type) {
      case "task.created":
        break;
      case "task.updated": {
        const instruction = str(payload.instruction);
        if (instruction) {
          entries.push({
            kind: "user",
            id,
            text: instruction,
            source: "steer",
            provenance: { source: "tasks.steer", event_id: event.event_id },
          });
          break;
        }
        const status = str(payload.status);
        const reason = str(payload.reason) ?? str(payload.code);
        if (status === "failed")
          entries.push({
            kind: "error",
            id,
            code: reason ?? "failed",
            text: `task failed${reason ? ` · ${reason}` : ""}`,
            detail: str(payload.detail),
          });
        else if (reason === "model_unavailable")
          entries.push({
            kind: "notice",
            id,
            tone: "warning",
            text: `model ${str(payload.model_id) ?? "selected"} unavailable → ${status ?? "paused"}`,
            detail: str(payload.detail),
          });
        else if (reason === "budget_exhausted" || reason === "budget")
          entries.push({
            kind: "notice",
            id,
            tone: "warning",
            text: `budget exhausted${num(payload.max_usd) !== null ? ` · cap $${num(payload.max_usd)?.toFixed(2)}` : ""} → ${status ?? "paused"}`,
            detail: str(payload.detail),
          });
        else if (status)
          entries.push({
            kind: "notice",
            id,
            tone: status === "cancelled" ? "warning" : "info",
            text:
              status === "completed"
                ? "task completed · verification is reported separately"
                : `task ${status}${reason ? ` · ${reason}` : ""}`,
            detail: null,
          });
        break;
      }
      case "execution.observed": {
        const entryIds = strings(bag(payload.upstream).entry_ids);
        const observed = str(payload.kind) ?? "event";
        const summary = str(payload.summary);
        const resolved: JournalEntry[] = [];
        if (journal.status === "available")
          for (const entryId of entryIds) {
            const entry = journal.entries.get(entryId);
            if (
              entry &&
              (THINKING_KINDS.has(entry.kind) ||
                (TEXT_KINDS.has(entry.kind) && entry.text.trim()))
            )
              resolved.push(entry);
          }
        if (resolved.length === 0) {
          entries.push({
            kind: "turn",
            id,
            observed,
            summary,
            entry_ids: entryIds,
            running: false,
            provenance,
          });
          break;
        }
        for (const entry of resolved) {
          if (seenEntries.has(entry.entry_id)) continue;
          seenEntries.add(entry.entry_id);
          const entryProvenance = {
            source: `tasks.journal ${entry.entry_id}`,
            event_id: event.event_id,
          };
          if (THINKING_KINDS.has(entry.kind))
            entries.push({
              kind: "thinking",
              id: `journal:${entry.entry_id}`,
              text: entry.text,
              tokens: entry.usage?.output_tokens ?? null,
              provenance: entryProvenance,
            });
          else
            entries.push({
              kind: "assistant",
              id: `journal:${entry.entry_id}`,
              text: entry.text,
              provenance: entryProvenance,
            });
        }
        break;
      }
      case "tool.completed": {
        const operation = str(payload.operation);
        if (operation === "runtime.result") {
          const started = turnStarted ? Date.parse(turnStarted) : Number.NaN;
          const seconds = Number.isNaN(started)
            ? null
            : Math.max(
                0,
                Math.round((Date.parse(event.occurred_at) - started) / 1000),
              );
          entries.push({
            kind: "summary",
            id,
            status: str(payload.status) ?? "completed",
            seconds,
            input_tokens: event.usage?.input_tokens ?? 0,
            output_tokens: event.usage?.output_tokens ?? 0,
            cost_usd: event.usage?.cost_usd ?? null,
            tools: toolsThisTurn,
          });
          toolsThisTurn = 0;
          turnStarted = null;
        } else if (operation === "hook.completed") {
          const results = Array.isArray(payload.results)
            ? payload.results.map(bag)
            : [];
          const first = results[0] ?? {};
          const blocked = results.some((result) => result.blocked === true);
          entries.push({
            kind: "hook",
            id,
            phase: str(payload.event) ?? "hook",
            command: str(first.command) ?? str(first.name) ?? "hook",
            exit_code: num(first.exit_code),
            blocked,
            reason: blocked ? (str(first.reason) ?? str(first.stderr)) : null,
            output: [str(first.stdout), str(first.stderr)]
              .filter(Boolean)
              .join("\n"),
            provenance,
          });
        } else if (operation === "child.result") {
          const label =
            str(payload.role_label) ?? str(payload.child_agent_id) ?? "child";
          const status = str(payload.status) ?? "unknown";
          children.set(label, status);
          const routing = bag(payload.routing);
          entries.push({
            kind: "child",
            id,
            label,
            status,
            tool_calls: num(payload.tool_calls),
            model: str(payload.model_id),
            tier: str(routing.tier) ?? str(payload.tier),
            provenance,
          });
        } else if (operation === "watch.evidence") {
          const verdict = str(payload.verdict) ?? "inconclusive";
          if (str(payload.kind) === "verify") {
            if (verdict === "pass") verify.pass++;
            else if (verdict === "fail") verify.fail++;
          }
          entries.push({
            kind: "evidence",
            id,
            check: str(payload.tool) ?? "check",
            evidence_kind: str(payload.kind) ?? "verify",
            verdict,
            verified: payload.verified === true,
            advisory: payload.advisory === true,
            files: strings(payload.files),
            summary: str(payload.summary) ?? "",
            record: rawPayload ?? null,
            provenance,
          });
        } else if (operation === "graph.build" || operation === "graph.query") {
          entries.push({
            kind: "graph",
            id,
            operation,
            status: str(payload.status) ?? "unknown",
            revision: str(payload.revision),
            isolation: str(payload.isolation),
            summary: str(payload.summary) ?? str(payload.answer) ?? "",
            provenance,
          });
        } else if (
          str(payload.tool) &&
          (str(payload.tool) === "mars_write" ||
            str(payload.tool) === "mars_apply_patch") &&
          Array.isArray(payload.files)
        ) {
          const files = payload.files
            .map(bag)
            .filter((file) => str(file.path) && str(file.patch) !== null)
            .map((file) => ({
              path: str(file.path) as string,
              status: (str(file.status) ??
                "modified") as DiffFileInput["status"],
              patch: str(file.patch) as string,
            }));
          toolsThisTurn++;
          entries.push(diffEntry(id, files));
        } else if (str(payload.tool)) {
          pushTool({
            kind: "tool",
            id,
            name: str(payload.tool) as string,
            primary:
              str(payload.primary) ?? str(payload.path) ?? str(payload.command),
            status: toolStatus(payload),
            output: str(payload.output) ?? "",
            provenance,
          });
        } else {
          entries.push({
            kind: "notice",
            id,
            tone: "info",
            text: `${operation ?? "tool.completed"}${str(payload.status) ? ` · ${str(payload.status)}` : ""}`,
            detail: str(payload.summary),
          });
        }
        break;
      }
      case "research.proposed": {
        const findingId = str(payload.finding_id) ?? event.event_id;
        const finding: ResearchFinding = {
          finding_id: findingId,
          claim: str(payload.claim),
          source: str(payload.source),
          confidence: num(payload.confidence),
          used: typeof payload.used === "boolean" ? payload.used : null,
          stale: false,
          excerpt: str(payload.excerpt),
        };
        findings.set(findingId, finding);
        const previous = entries.at(-1);
        if (previous?.kind === "research") previous.findings.push(finding);
        else
          entries.push({
            kind: "research",
            id,
            findings: [finding],
            provenance,
          });
        break;
      }
      case "research.stale": {
        const stale = strings(payload.stale_finding_ids);
        for (const findingId of stale) {
          const finding = findings.get(findingId);
          if (finding) finding.stale = true;
        }
        entries.push({
          kind: "notice",
          id,
          tone: "info",
          text: `${stale.length} research finding${stale.length === 1 ? "" : "s"} stale`,
          detail: null,
        });
        break;
      }
      case "memory.revised":
      case "skill.revised":
      case "promotion.decided":
        entries.push({
          kind: "proposal",
          id,
          proposal_kind:
            str(payload.kind) ??
            (event.event_type === "memory.revised"
              ? "memory"
              : event.event_type === "skill.revised"
                ? "skill"
                : "promotion"),
          scope: str(payload.scope) ?? event.access,
          revision: str(payload.revision) ?? str(payload.expected_revision),
          before: str(payload.before) ?? "",
          after: str(payload.after) ?? "",
          decision: str(payload.decision),
          provenance,
        });
        break;
      case "evaluation.completed":
      case "training.updated": {
        const score = num(payload.score);
        entries.push({
          kind: "notice",
          id,
          tone: "info",
          text: `${event.event_type === "evaluation.completed" ? "evaluation" : "training"} ${str(payload.name) ?? str(payload.status) ?? "updated"}${score !== null ? ` · score ${score}` : ""}`,
          detail: str(payload.summary),
        });
        break;
      }
    }
  }

  if (running) {
    const lastTurn = entries.findLast((entry) => entry.kind === "turn");
    if (lastTurn?.kind === "turn" && entries.at(-1) === lastTurn)
      lastTurn.running = true;
  }
  if (input.diff?.files.length)
    entries.push(diffEntry("diff:current", input.diff.files));
  if (input.finalText?.trim())
    entries.push({
      kind: "assistant",
      id: "artifact:final",
      text: input.finalText,
      provenance: { source: "final artifact (tasks.artifact)", event_id: null },
    });

  let trimmed = 0;
  if (entries.length > limit) {
    trimmed = entries.length - (limit - 1);
    entries.splice(0, trimmed);
    entries.unshift({ kind: "earlier", id: "earlier", count: trimmed });
  }
  return {
    entries,
    trimmed,
    totals,
    children: [...children.values()].filter((status) => status === "running")
      .length,
    verify,
    journal: journal.status,
    last_event_id: input.events.at(-1)?.event.event_id ?? null,
  };
}

/** Journal entry ids still to resolve, in event order, for the next `tasks.journal` call. */
export function pendingJournalIds(
  events: readonly ProjectionEvent[],
  known: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  for (const { event, payload } of events) {
    if (event.event_type !== "execution.observed") continue;
    for (const entryId of strings(bag(bag(payload).upstream).entry_ids))
      if (!known.has(entryId)) ids.push(entryId);
  }
  return [...new Set(ids)];
}
