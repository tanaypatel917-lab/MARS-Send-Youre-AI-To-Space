import type { RequestContext } from "@mars/contracts";
import type { DurableTaskStore } from "@mars/tasks";
import {
  WATCH_EVIDENCE_PRODUCER,
  WATCH_PACKAGE_VERSION,
  WATCH_SKILL_VERSION,
  type WatchEvidenceRecord,
  WatchEvidenceRecordSchema,
  type WatchEvidenceSink,
  type WatchService,
} from "@mars/watch";

/** The host-owned watch service surface the workbench binds per task. */
export type WorkbenchWatch = Pick<WatchService, "toolsFor">;

const MAX_LISTED_RECORDS = 50;

/**
 * Persists watch-skill evidence as `tool.completed` task events so loop and
 * verification verdicts are durable, reviewable and bound to the task, and
 * reads them back for `mars_watch_evidence`.
 */
export function watchEvidence(
  store: Pick<DurableTaskStore, "appendEvent" | "events" | "artifacts">,
  context: () => RequestContext,
  taskId: string,
): WatchEvidenceSink {
  return {
    async append(record) {
      await store.appendEvent(context(), taskId, {
        event_type: "tool.completed",
        run_id: crypto.randomUUID(),
        producer: WATCH_EVIDENCE_PRODUCER,
        versions: [
          {
            component: WATCH_EVIDENCE_PRODUCER,
            revision: WATCH_PACKAGE_VERSION,
          },
          { component: "watch-skill", revision: WATCH_SKILL_VERSION },
        ],
        payload: record,
      });
    },
    async list() {
      const records: WatchEvidenceRecord[] = [];
      const current = context();
      for await (const event of store.events(current, taskId)) {
        if (
          event.event_type !== "tool.completed" ||
          event.producer !== WATCH_EVIDENCE_PRODUCER
        )
          continue;
        const bytes = await store.artifacts.get(current, event.payload);
        const parsed = WatchEvidenceRecordSchema.safeParse(
          JSON.parse(new TextDecoder().decode(bytes)),
        );
        if (parsed.success) records.push(parsed.data);
      }
      return records.slice(-MAX_LISTED_RECORDS);
    },
  };
}
