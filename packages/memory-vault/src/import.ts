import type { MemoryEntry, RequestContext } from "@mars/contracts";
import { scanThreat } from "@mars/memory";
import { sha256 } from "./notes";
import { type ScannedNote, scanVault } from "./scan";
import {
  type ImportAction,
  type ImportItem,
  type ImportOperation,
  type ImportReport,
  VAULT_SCHEMA_VERSION,
  VAULT_SOURCE,
} from "./schema";
import type { VaultStores } from "./stores";

export interface ImportVaultOptions extends VaultStores {
  vaultDir: string;
  actor: string;
  source?: string;
  allowRemove?: boolean;
  strict?: boolean;
  privateRoots?: readonly string[];
  now?: () => Date;
}

type Store = "memory" | "skills";

const shortDigest = (digest: string) => digest.slice(0, 16);

function item(
  path: string,
  kind: ImportItem["kind"],
  id: string | null,
  action: ImportAction,
  extra: Partial<
    Pick<ImportItem, "operation" | "store" | "proposal_id" | "reason">
  > = {},
): ImportItem {
  return {
    path,
    kind,
    id,
    action,
    operation: extra.operation ?? null,
    store: extra.store ?? null,
    proposal_id: extra.proposal_id ?? null,
    reason: extra.reason ?? null,
  };
}

/**
 * Store errors may echo the rejected content; the report keeps the error code
 * or class and a short message with every submitted text redacted.
 */
function errorText(error: unknown, texts: readonly string[] = []): string {
  const code =
    error instanceof Error
      ? typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code?: unknown }).code)
        : error.name
      : "error";
  let message = error instanceof Error ? error.message : String(error);
  for (const text of [...texts].sort((a, b) => b.length - a.length))
    if (text.length > 0) message = message.split(text).join("<note text>");
  message = message.replace(/\s+/g, " ").trim().slice(0, 200);
  return message ? `${code}: ${message}` : code;
}

/**
 * Reconciles vault edits back into the authoritative stores as proposals
 * only. Nothing here calls `batch`, `applyBatch`, `create` or `update`; every
 * change goes through `submitProposal`, which dry-runs it and leaves it
 * `pending` for a human or host to accept.
 */
export async function importVault(
  ctx: RequestContext,
  options: ImportVaultOptions,
): Promise<ImportReport> {
  const source = options.source ?? VAULT_SOURCE;
  const strict = options.strict === true;
  const allowRemove = options.allowRemove === true;
  const scan = await scanVault(ctx, options);
  const items: ImportItem[] = [];
  const proposals = { memory: [] as string[], skills: [] as string[] };
  const now = () => (options.now?.() ?? new Date()).toISOString();

  const refuse = (
    note: ScannedNote,
    store: Store,
    operation: ImportOperation,
    texts: string[],
  ): boolean => {
    for (const text of texts) {
      const threat = scanThreat(text);
      if (threat) {
        items.push(
          item(note.path, note.kind, note.id, "refused", {
            operation,
            store,
            reason: `threat scanner flagged ${threat}; nothing was proposed`,
          }),
        );
        return true;
      }
    }
    return false;
  };

  const stale = (store: Store) =>
    store === "memory" ? scan.memoryStale : scan.skillsStale;

  const snapshot = await options.memory.snapshot(ctx);
  const current = new Map(
    snapshot.entries.map((entry) => [entry.entry_id, entry]),
  );
  const currentSkills = new Map(
    (await options.skills.list()).map((skill) => [skill.name, skill]),
  );
  const pendingMemory = (
    await options.memory.listProposals(ctx, "pending")
  ).filter((proposal) => proposal.source === source);
  const pendingSkills = (await options.skills.listProposals()).filter(
    (proposal) => proposal.status === "pending" && proposal.source === source,
  );
  const exportedRevision = scan.manifest.memory_revision;
  const exportedSkills = scan.manifest.skills_revision;

  interface Plan<R extends number | string> {
    note: ScannedNote;
    store: Store;
    operation: ImportOperation;
    texts: string[];
    entryUnchanged: boolean;
    pending: (op: unknown) => boolean;
    exported: R;
    currentRevision: R;
    run: (expectedRevision: R) => Promise<string>;
  }

  /**
   * Refuse threats, skip duplicates of pending vault proposals, then submit.
   * Unchanged stores are fenced on the exported revision. When a store moved
   * since export the proposal is still submitted (fenced on the current
   * revision) as long as the specific entry/skill is byte-identical to what
   * was exported; otherwise the edit is withheld as stale_export. --strict
   * withholds everything on a moved store.
   */
  const submit = async <R extends number | string>(plan: Plan<R>) => {
    const { note, store, operation } = plan;
    if (refuse(note, store, operation, plan.texts)) return;
    const duplicate =
      store === "memory"
        ? pendingMemory.find((p) => p.operations.some(plan.pending))
        : pendingSkills.find((p) => p.ops.some(plan.pending));
    if (duplicate) {
      items.push(
        item(note.path, note.kind, note.id, "already_proposed", {
          operation,
          store,
          proposal_id:
            "proposal_id" in duplicate ? duplicate.proposal_id : duplicate.id,
          reason: "an identical vault proposal is already pending",
        }),
      );
      return;
    }
    const moved = stale(store);
    if (moved && strict) {
      items.push(
        item(note.path, note.kind, note.id, "stale_export", {
          operation,
          store,
          reason: `${store} revision moved since export; not submitted under --strict`,
        }),
      );
      return;
    }
    if (moved && !plan.entryUnchanged) {
      items.push(
        item(note.path, note.kind, note.id, "stale_export", {
          operation,
          store,
          reason: `${store} entry changed since export; re-export and re-apply the edit`,
        }),
      );
      return;
    }
    try {
      const proposalId = await plan.run(
        moved ? plan.currentRevision : plan.exported,
      );
      proposals[store].push(proposalId);
      items.push(
        item(note.path, note.kind, note.id, "proposed", {
          operation,
          store,
          proposal_id: proposalId,
          ...(moved
            ? {
                reason: `${store} revision moved since export (stale_export); fenced on current revision, the owner decides on acceptance`,
              }
            : {}),
        }),
      );
    } catch (error) {
      items.push(
        item(note.path, note.kind, note.id, "failed", {
          operation,
          store,
          reason: errorText(error, plan.texts),
        }),
      );
    }
  };
  const memoryPlan = (
    note: ScannedNote,
    operation: ImportOperation,
    texts: string[],
    pending: (op: unknown) => boolean,
    run: (expectedRevision: number) => Promise<string>,
  ) =>
    submit({
      note,
      store: "memory",
      operation,
      texts,
      entryUnchanged:
        operation === "add" ||
        sha256(current.get(note.id ?? "")?.fact ?? "") ===
          note.tracked?.content_digest,
      pending,
      exported: exportedRevision,
      currentRevision: scan.memoryRevision,
      run,
    });
  const skillPlan = (
    note: ScannedNote,
    operation: ImportOperation,
    texts: string[],
    pending: (op: unknown) => boolean,
    run: (expectedRevision: string) => Promise<string>,
  ) =>
    submit({
      note,
      store: "skills",
      operation,
      texts,
      entryUnchanged:
        operation === "create" ||
        sha256(currentSkills.get(note.id ?? "")?.content ?? "") ===
          note.tracked?.content_digest,
      pending,
      exported: exportedSkills,
      currentRevision: scan.skillsRevision,
      run,
    });
  const memoryOp = (op: unknown) =>
    op as {
      operation: string;
      entry_id?: string;
      fact?: string;
      entry?: MemoryEntry;
    };
  const skillOp = (op: unknown) =>
    op as { op: string; name: string; content?: string };

  for (const note of scan.notes) {
    if (note.state === "invalid") {
      items.push(
        item(note.path, note.kind, note.id, "invalid", { reason: note.reason }),
      );
      continue;
    }
    if (note.state === "unchanged") {
      items.push(item(note.path, note.kind, note.id, "unchanged"));
      continue;
    }
    if (note.derived) {
      items.push(
        item(note.path, note.kind, note.id, "ignored_derived", {
          reason: `${note.kind} notes are rebuilt from the stores; ${note.state === "deleted" ? "deletion" : "edit"} ignored`,
        }),
      );
      continue;
    }
    const store: Store = note.kind === "skill" ? "skills" : "memory";
    if (note.state === "deleted") {
      if (!allowRemove) {
        items.push(
          item(note.path, note.kind, note.id, "deleted", {
            store,
            reason:
              "note removed from the vault; pass allowRemove to propose removal",
          }),
        );
        continue;
      }
      const digest = note.tracked?.content_digest ?? "";
      if (store === "memory") {
        const entryId = note.id ?? "";
        const rationale = `vault deletion of ${note.path} (exported revision ${exportedRevision}, digest ${shortDigest(digest)})`;
        await memoryPlan(
          note,
          "remove",
          [rationale],
          (op) =>
            memoryOp(op).operation === "remove" &&
            memoryOp(op).entry_id === entryId,
          async (expected_revision) =>
            (
              await options.memory.submitProposal(ctx, {
                source,
                operations: [{ operation: "remove", entry_id: entryId }],
                rationale,
                expected_revision,
              })
            ).proposal_id,
        );
      } else {
        const name = note.id ?? "";
        const rationale = `vault deletion of ${note.path} (exported revision ${shortDigest(exportedSkills)}, digest ${shortDigest(digest)}); skills are archived, never erased`;
        await skillPlan(
          note,
          "archive",
          [rationale],
          (op) => skillOp(op).op === "archive" && skillOp(op).name === name,
          async (expectedRevision) =>
            (
              await options.skills.submitProposal(
                { source, ops: [{ op: "archive", name }], rationale },
                { actor: options.actor, source, expectedRevision },
              )
            ).id,
        );
      }
      continue;
    }
    const body = note.note?.body ?? "";
    if (note.state === "modified") {
      const digest = note.tracked?.content_digest ?? "";
      if (store === "memory") {
        const entryId = note.id ?? "";
        const rationale = `vault edit of ${note.path} (exported revision ${exportedRevision}, digest ${shortDigest(digest)})`;
        const sourceEventIds =
          current.get(entryId)?.source_event_ids ?? eventIds(note);
        await memoryPlan(
          note,
          "patch",
          [body, rationale],
          (op) =>
            memoryOp(op).operation === "patch" &&
            memoryOp(op).entry_id === entryId &&
            memoryOp(op).fact === body,
          async (expected_revision) =>
            (
              await options.memory.submitProposal(ctx, {
                source,
                operations: [
                  {
                    operation: "patch",
                    entry_id: entryId,
                    fact: body,
                    source_event_ids: sourceEventIds,
                  },
                ],
                rationale,
                expected_revision,
              })
            ).proposal_id,
        );
      } else {
        const name = note.id ?? "";
        const rationale = `vault edit of ${note.path} (exported revision ${shortDigest(exportedSkills)}, digest ${shortDigest(digest)})`;
        await skillPlan(
          note,
          "update",
          [body, rationale],
          (op) =>
            skillOp(op).op === "update" &&
            skillOp(op).name === name &&
            skillOp(op).content === body,
          async (expectedRevision) =>
            (
              await options.skills.submitProposal(
                {
                  source,
                  ops: [{ op: "update", name, content: body }],
                  rationale,
                },
                { actor: options.actor, source, expectedRevision },
              )
            ).id,
        );
      }
      continue;
    }
    // added
    if (store === "memory") {
      const entryId = `vault-${sha256(`${note.path}\n${body}`).slice(0, 32)}`;
      const rationale = `vault note ${note.path} (new fact, digest ${shortDigest(sha256(body))})`;
      const target =
        note.note?.frontmatter.target === "profile" ? "profile" : "project";
      const scope =
        target === "profile"
          ? { owner_id: ctx.scope.owner_id, project_id: ctx.scope.project_id }
          : ctx.scope;
      const entry: MemoryEntry = {
        entry_id: entryId,
        scope,
        target,
        fact: body,
        revision: 0,
        source_event_ids: eventIds(note, `memory-vault:${note.path}`),
        observed_at: now(),
        verified_at: null,
        supersedes: null,
        deleted: false,
      };
      await memoryPlan(
        { ...note, id: entryId },
        "add",
        [body, rationale],
        (op) =>
          memoryOp(op).operation === "add" &&
          memoryOp(op).entry?.entry_id === entryId,
        async (expected_revision) =>
          (
            await options.memory.submitProposal(ctx, {
              source,
              operations: [{ operation: "add", entry }],
              rationale,
              expected_revision,
            })
          ).proposal_id,
      );
    } else {
      const name = note.id ?? note.path.slice("skills/".length, -".md".length);
      const rationale = `vault note ${note.path} (new skill, digest ${shortDigest(sha256(body))})`;
      await skillPlan(
        { ...note, id: name },
        "create",
        [body, rationale],
        (op) =>
          skillOp(op).op === "create" &&
          skillOp(op).name === name &&
          skillOp(op).content === body,
        async (expectedRevision) =>
          (
            await options.skills.submitProposal(
              {
                source,
                ops: [{ op: "create", name, content: body }],
                rationale,
              },
              { actor: options.actor, source, expectedRevision },
            )
          ).id,
      );
    }
  }

  const summary: Partial<Record<ImportAction, number>> = {};
  for (const entry of items)
    summary[entry.action] = (summary[entry.action] ?? 0) + 1;
  return {
    schema_version: VAULT_SCHEMA_VERSION,
    vault_dir: scan.vaultDir,
    scope: ctx.scope,
    source,
    strict,
    allow_remove: allowRemove,
    memory: {
      exported_revision: scan.manifest.memory_revision,
      current_revision: scan.memoryRevision,
      stale_export: scan.memoryStale,
    },
    skills: {
      exported_revision: scan.manifest.skills_revision,
      current_revision: scan.skillsRevision,
      stale_export: scan.skillsStale,
    },
    items,
    summary,
    proposals,
  };
}

function eventIds(note: ScannedNote, fallback?: string): string[] {
  const provenance = note.note?.frontmatter.provenance;
  const raw =
    provenance && typeof provenance === "object" && !Array.isArray(provenance)
      ? provenance.source_event_ids
      : note.note?.frontmatter.source_event_ids;
  const ids = Array.isArray(raw)
    ? raw.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      )
    : [];
  return ids.length > 0 ? ids : fallback ? [fallback] : [];
}
