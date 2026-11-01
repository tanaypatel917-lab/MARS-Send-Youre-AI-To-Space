import type { ResearchFinding } from "@mars/contracts";
import { type AppendEventInput, canonicalJson } from "@mars/tasks";

export interface ResearchWorkerVersion {
  id: string;
  version: string;
}

export interface StoredResearchEvent {
  eventRequestId: string;
  eventJson: string;
}

export function proposedEventInput(
  requestId: string,
  finding: ResearchFinding,
  worker: ResearchWorkerVersion | null,
  formatVersion: number,
): StoredResearchEvent {
  const input = {
    event_type: "research.proposed",
    run_id: requestId,
    producer: "mars-research",
    versions: [
      {
        component: "@mars/research",
        revision: String(formatVersion),
      },
      worker
        ? {
            component: `worker:${worker.id}`,
            revision: worker.version,
          }
        : { component: "worker:none", revision: "0" },
    ],
    payload: {
      request_id: requestId,
      finding_id: finding.finding_id,
      task_revision: finding.task_revision,
      confidence: finding.confidence,
      source_count: finding.sources.length,
    },
    source_event_ids: [],
  } satisfies AppendEventInput;
  return {
    eventRequestId: `research:${finding.finding_id}:proposed`,
    eventJson: canonicalJson(input),
  };
}

export function staleEventInput(
  requestId: string,
  taskRevision: number,
  staleFindingIds: readonly string[],
  worker: ResearchWorkerVersion | null,
  formatVersion: number,
): StoredResearchEvent {
  const input = {
    event_type: "research.stale",
    run_id: requestId,
    producer: "mars-research",
    versions: [
      {
        component: "@mars/research",
        revision: String(formatVersion),
      },
      worker
        ? {
            component: `worker:${worker.id}`,
            revision: worker.version,
          }
        : { component: "worker:none", revision: "0" },
    ],
    payload: {
      request_id: requestId,
      task_revision: taskRevision,
      stale_finding_ids: [...staleFindingIds],
    },
    source_event_ids: [],
  } satisfies AppendEventInput;
  return {
    eventRequestId: `research:${requestId}:stale`,
    eventJson: canonicalJson(input),
  };
}
