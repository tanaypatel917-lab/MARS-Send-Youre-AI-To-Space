import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BridgeResult } from "../shared/methods";
import {
  PROVIDER_ISSUES,
  type ProviderIssue,
  SETUP_MILESTONES,
  type SetupMilestone,
  type SetupSummary,
} from "../shared/setup";

export type SetupJournal = {
  mark(milestone: SetupMilestone): Promise<void>;
  count(issue: ProviderIssue): Promise<void>;
  snapshot(): Promise<SetupSummary>;
};

function parse(raw: unknown): SetupSummary {
  const summary: SetupSummary = { milestones: {}, issues: {} };
  if (!raw || typeof raw !== "object") return summary;
  const { milestones, issues } = raw as Record<string, unknown>;
  for (const key of SETUP_MILESTONES) {
    const value = (milestones as Record<string, unknown> | undefined)?.[key];
    if (typeof value === "string" && !Number.isNaN(Date.parse(value)))
      summary.milestones[key] = new Date(value).toISOString();
  }
  for (const key of PROVIDER_ISSUES) {
    const value = (issues as Record<string, unknown> | undefined)?.[key];
    if (Number.isSafeInteger(value) && (value as number) > 0)
      summary.issues[key] = value as number;
  }
  return summary;
}

/** Records first-time setup milestones and provider failure counts in one private file. */
export function createSetupJournal(
  path: string,
  now: () => Date = () => new Date(),
): SetupJournal {
  let state: Promise<SetupSummary> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const read = () => {
    state ??= readFile(path, "utf8")
      .then((text) => parse(JSON.parse(text)))
      .catch(() => parse(undefined));
    return state;
  };
  const update = (change: (summary: SetupSummary) => boolean) => {
    const next = queue.then(async () => {
      const summary = await read();
      if (!change(summary)) return;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(summary), {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temp, path);
      } finally {
        await rm(temp, { force: true });
      }
    });
    queue = next.catch(() => {});
    return next.catch(() => {});
  };
  return {
    mark: (milestone) =>
      update((summary) => {
        if (summary.milestones[milestone]) return false;
        summary.milestones[milestone] = now().toISOString();
        return true;
      }),
    count: (issue) =>
      update((summary) => {
        summary.issues[issue] = (summary.issues[issue] ?? 0) + 1;
        return true;
      }),
    snapshot: async () => {
      await queue;
      return structuredClone(await read());
    },
  };
}

/** Derives task milestones from bridge results the main process already sees. */
export function observeBridge(
  journal: SetupJournal,
  method: unknown,
  result: BridgeResult<unknown>,
): void {
  if (result.ok) {
    if (method === "tasks.create") void journal.mark("first_task_created");
    if (method === "tasks.start") void journal.mark("first_task_started");
    if (
      method === "tasks.export" &&
      (result.result as { verified?: unknown } | null)?.verified === true
    )
      void journal.mark("first_verified_export");
    return;
  }
  if (
    (method === "tasks.start" || method === "tasks.resume") &&
    result.error.kind === "model_unavailable"
  )
    void journal.count("task_model_unavailable");
}
