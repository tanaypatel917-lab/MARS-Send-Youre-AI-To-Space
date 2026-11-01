import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  type ArtifactRef,
  ArtifactRefSchema,
  type MemoryEntry,
  type MemoryOperation,
  type MemoryService,
  type RequestContext,
  ScopeSchema,
} from "@mars/contracts";
import { z } from "zod";
import {
  type JournalInput,
  type JournalMessage,
  parseJournal,
} from "./journal";

export const MEMORY_STORE_FORMAT_VERSION = 1;
export const DEFAULT_BUDGETS = { profile: 1375, project: 2200 } as const;
export const DISCLOSURE =
  "Deletion cannot erase influence on already-trained model weights; retire or retrain these manifests.";
export type MemoryStoreErrorCode =
  | "invalid_input"
  | "scope_denied"
  | "not_found"
  | "conflict"
  | "budget_exceeded"
  | "corrupt_record"
  | "unknown_format"
  | "journal_incompatible"
  | "closed"
  | "storage_error";
export class MemoryStoreError extends Error {
  constructor(
    public readonly code: MemoryStoreErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MemoryStoreError";
  }
}
function fail(
  code: MemoryStoreErrorCode,
  details?: Record<string, unknown>,
): never {
  throw new MemoryStoreError(code, `Memory store: ${code}`, details);
}
const id = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
export const RequestContextSchema = z
  .object({ schema_version: z.literal(1), scope: ScopeSchema, request_id: id })
  .strict();
export const MemoryEntrySchema = z
  .object({
    entry_id: id,
    scope: ScopeSchema,
    target: z.enum(["profile", "project"]),
    fact: z.string(),
    revision: z.number().int().nonnegative(),
    source_event_ids: z.array(id),
    observed_at: timestamp,
    verified_at: timestamp.nullable(),
    supersedes: id.nullable(),
    deleted: z.boolean(),
  })
  .strict();
const operationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("add"), entry: MemoryEntrySchema }).strict(),
  z
    .object({
      operation: z.literal("patch"),
      entry_id: id,
      fact: z.string(),
      source_event_ids: z.array(id),
    })
    .strict(),
  z.object({ operation: z.literal("remove"), entry_id: id }).strict(),
]);
const validate = <S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
): z.output<S> => {
  const result = schema.safeParse(value);
  return result.success ? result.data : fail("invalid_input");
};
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const encode = (v: unknown): string => {
    if (v === null || typeof v === "string" || typeof v === "boolean")
      return JSON.stringify(v);
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== "object" || seen.has(v)) fail("invalid_input");
    seen.add(v);
    try {
      if (Array.isArray(v)) return `[${Array.from(v, encode).join(",")}]`;
      if (
        Object.getPrototypeOf(v) !== Object.prototype &&
        Object.getPrototypeOf(v) !== null
      )
        fail("invalid_input");
      const record = v as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
        .join(",")}}`;
    } finally {
      seen.delete(v);
    }
  };
  return encode(value);
}
const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const fact = (value: string): string => {
  for (const char of value) {
    const c = char.charCodeAt(0);
    if (
      (c < 32 && c !== 9 && c !== 10) ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2060 && c <= 0x2064) ||
      c === 0xfeff
    )
      fail("invalid_input");
  }
  if (!value.trim() || value.includes("\n§\n")) fail("invalid_input");
  return value.trim();
};
export interface MemoryStoreOptions {
  rootDir: string;
  budgets?: { profile?: number; project?: number };
  hostPrivateRoots?: string[];
  now?: () => Date;
}
export interface MemorySnapshot {
  revision: number;
  entries: MemoryEntry[];
}
export interface DatasetCandidate {
  source_id: string;
  source_ids: string[];
  text: string;
  kind: "memory" | "journal";
}
export interface ErasureResult {
  affected_training_manifests: string[];
  disclosure: string;
}
export interface HistoryHit {
  source: { session_id: string; entry_id: string };
  role: JournalMessage["role"];
  timestamp: string;
  text: string;
  surrounding: { before: JournalMessage[]; after: JournalMessage[] };
}
interface EntryRow {
  entry_id: string;
  owner: string;
  project: string;
  workspace: string;
  target: string;
  first_seq: number;
}
interface RevisionRow {
  entry_id: string;
  revision: number;
  commit_seq: number;
  record: string;
  row_hash: string;
  request_id: string;
  superseded_by: string | null;
}
interface JournalRow {
  scope_key: string;
  session_id: string;
  entry_id: string;
  record: string;
  row_hash: string;
}
const visibility =
  "owner = ? AND (target = 'profile' OR (project = ? AND (workspace = '' OR workspace = ?)))";
const journalVisibility = "owner = ? AND project = ? AND workspace = ?";
const args = (ctx: RequestContext): [string, string, string] => [
  ctx.scope.owner_id,
  ctx.scope.project_id,
  ctx.scope.workspace_id ?? "",
];
const scopeKey = (ctx: RequestContext): string =>
  hash(canonicalJson(ctx.scope));
const streamKey = (entry: MemoryEntry): string =>
  hash(
    canonicalJson(
      entry.target === "profile"
        ? ["profile", entry.scope.owner_id]
        : [
            "project",
            entry.scope.owner_id,
            entry.scope.project_id,
            entry.scope.workspace_id ?? "",
          ],
    ),
  );
const tokens = (query: string): string =>
  (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
    .filter(
      (t) =>
        !new Set([
          "a",
          "an",
          "the",
          "is",
          "of",
          "to",
          "and",
          "or",
          "in",
          "for",
        ]).has(t),
    )
    .map((t) => `"${t}"`)
    .join(" AND ");

export function formatSnapshot(
  snapshot: MemorySnapshot,
  budgets: { profile?: number; project?: number } = {},
): string {
  return (["profile", "project"] as const)
    .map((target) => {
      const text = snapshot.entries
        .filter((e) => e.target === target)
        .map((e) => e.fact)
        .join("\n§\n");
      return `<${target} ${[...text].length}/${budgets[target] ?? DEFAULT_BUDGETS[target]}>\n${text}\n</${target}>`;
    })
    .join("\n");
}

export class DurableMemoryStore implements MemoryService {
  private db!: Database;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private budgets: { profile: number; project: number };
  constructor(private readonly options: MemoryStoreOptions) {
    this.budgets = validate(
      z.object({
        profile: z.number().int().nonnegative(),
        project: z.number().int().nonnegative(),
      }),
      { ...DEFAULT_BUDGETS, ...options.budgets },
    );
    try {
      mkdirSync(options.rootDir, { recursive: true, mode: 0o700 });
      this.db = new Database(path.join(options.rootDir, "memory.sqlite"), {
        create: true,
      });
      this.db.exec(
        "PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;",
      );
      this.db.exec("BEGIN IMMEDIATE");
      const version = this.db.query("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (
        version.user_version !== 0 &&
        version.user_version !== MEMORY_STORE_FORMAT_VERSION
      ) {
        this.db.close();
        fail("unknown_format");
      }
      if (version.user_version === 0) {
        const tables = this.db
          .query("SELECT name FROM sqlite_master WHERE type='table'")
          .all();
        if (tables.length) {
          this.db.close();
          fail("unknown_format");
        }
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sequence (id INTEGER PRIMARY KEY CHECK(id=1), seq INTEGER NOT NULL);
        INSERT OR IGNORE INTO sequence VALUES (1,0);
        CREATE TABLE IF NOT EXISTS streams (stream_key TEXT PRIMARY KEY, owner TEXT, project TEXT, workspace TEXT, target TEXT, last_seq INTEGER);
        CREATE TABLE IF NOT EXISTS entries (entry_id TEXT PRIMARY KEY, owner TEXT, project TEXT, workspace TEXT, target TEXT, first_seq INTEGER);
        CREATE TABLE IF NOT EXISTS entry_revisions (entry_id TEXT, revision INTEGER, commit_seq INTEGER, record TEXT, row_hash TEXT, request_id TEXT, superseded_by TEXT, PRIMARY KEY(entry_id,revision));
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(entry_id UNINDEXED, fact, tokenize="unicode61 tokenchars '_'");
        INSERT INTO memory_fts(memory_fts,rank) VALUES('secure-delete',1);
        CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, scope_key TEXT, owner TEXT, project TEXT, workspace TEXT);
        CREATE TABLE IF NOT EXISTS session_claims (session_digest TEXT PRIMARY KEY, scope_key TEXT);
        CREATE TABLE IF NOT EXISTS journal (session_id TEXT, entry_id TEXT, scope_key TEXT, record TEXT, row_hash TEXT, PRIMARY KEY(session_id,entry_id));
        CREATE VIRTUAL TABLE IF NOT EXISTS journal_fts USING fts5(session_id UNINDEXED, entry_id UNINDEXED, text, tokenize="unicode61 tokenchars '_'");
        INSERT INTO journal_fts(journal_fts,rank) VALUES('secure-delete',1);
        CREATE TABLE IF NOT EXISTS exclusions (digest TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS dataset_use (scope_key TEXT, manifest_id TEXT, source_id TEXT, evidence_id TEXT, PRIMARY KEY(scope_key,manifest_id,source_id,evidence_id));
        CREATE TABLE IF NOT EXISTS exports (scope_key TEXT, digest TEXT, owner TEXT, PRIMARY KEY(scope_key,digest));
        PRAGMA user_version=1; COMMIT;`);
    } catch (e) {
      if (e instanceof MemoryStoreError) throw e;
      fail("storage_error");
    }
  }
  private context(ctx: RequestContext): RequestContext {
    if (this.closed) fail("closed");
    return validate(RequestContextSchema, ctx);
  }
  private transaction<T>(work: () => T, write = false): T {
    this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      if (e instanceof MemoryStoreError) throw e;
      fail("storage_error");
    }
  }
  private write<T>(work: () => T, erase = false): Promise<T> {
    const next = this.queue.then(() => {
      if (this.closed) fail("closed");
      const result = this.transaction(work, true);
      if (erase) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      return result;
    });
    this.queue = next.catch(() => {});
    return next;
  }
  private nextSeq(): number {
    return (
      this.db
        .query("UPDATE sequence SET seq=seq+1 WHERE id=1 RETURNING seq")
        .get() as { seq: number }
    ).seq;
  }
  private validateFact(value: string): string {
    for (const root of [
      this.options.rootDir,
      path.resolve(this.options.rootDir),
      ...(this.options.hostPrivateRoots ?? []),
    ]) {
      if (root && value.includes(root)) fail("invalid_input");
    }
    return fact(value);
  }
  private revision(ctx: RequestContext): number {
    return (
      this.db
        .query(
          `SELECT COALESCE(MAX(last_seq),0) AS seq FROM streams WHERE ${visibility}`,
        )
        .get(...args(ctx)) as { seq: number }
    ).seq;
  }
  private decode(row: RevisionRow): MemoryEntry {
    try {
      const record: unknown = JSON.parse(row.record);
      if (
        hash(
          canonicalJson({
            record,
            commit_seq: row.commit_seq,
            request_id: row.request_id,
            superseded_by: row.superseded_by,
          }),
        ) !== row.row_hash
      )
        fail("corrupt_record");
      const parsed = MemoryEntrySchema.safeParse(record);
      if (
        !parsed.success ||
        parsed.data.entry_id !== row.entry_id ||
        parsed.data.revision !== row.revision
      )
        fail("corrupt_record");
      return parsed.data;
    } catch {
      fail("corrupt_record");
    }
  }
  private visibleRows(ctx: RequestContext): EntryRow[] {
    return this.db
      .query(
        `SELECT * FROM entries WHERE ${visibility} ORDER BY first_seq,entry_id`,
      )
      .all(...args(ctx)) as EntryRow[];
  }
  private latest(
    entryId: string,
    at = Number.MAX_SAFE_INTEGER,
  ): RevisionRow | null {
    return this.db
      .query(
        "SELECT * FROM entry_revisions WHERE entry_id=? AND commit_seq<=? ORDER BY revision DESC LIMIT 1",
      )
      .get(entryId, at) as RevisionRow | null;
  }
  private find(
    ctx: RequestContext,
    entryId: string,
    live = false,
  ): MemoryEntry {
    validate(id, entryId);
    const row = this.db
      .query(`SELECT * FROM entries WHERE entry_id=? AND ${visibility}`)
      .get(entryId, ...args(ctx)) as EntryRow | null;
    if (!row) fail("not_found");
    const rev = this.latest(entryId);
    if (!rev) fail("corrupt_record");
    const entry = this.decode(rev);
    if (live && entry.deleted) fail("not_found");
    return entry;
  }
  private append(
    ctx: RequestContext,
    entry: MemoryEntry,
    seq: number,
    supersededBy: string | null = null,
  ): void {
    const record = canonicalJson(entry);
    this.db.query("INSERT INTO entry_revisions VALUES(?,?,?,?,?,?,?)").run(
      entry.entry_id,
      entry.revision,
      seq,
      record,
      hash(
        canonicalJson({
          record: entry,
          commit_seq: seq,
          request_id: ctx.request_id,
          superseded_by: supersededBy,
        }),
      ),
      ctx.request_id,
      supersededBy,
    );
    this.db
      .query("DELETE FROM memory_fts WHERE entry_id=?")
      .run(entry.entry_id);
    if (!entry.deleted)
      this.db
        .query("INSERT INTO memory_fts(entry_id,fact) VALUES(?,?)")
        .run(entry.entry_id, entry.fact);
    this.db
      .query(
        "INSERT INTO streams VALUES(?,?,?,?,?,?) ON CONFLICT(stream_key) DO UPDATE SET last_seq=excluded.last_seq",
      )
      .run(
        streamKey(entry),
        entry.scope.owner_id,
        entry.target === "profile" ? "" : entry.scope.project_id,
        entry.scope.workspace_id ?? "",
        entry.target,
        seq,
      );
  }
  async snapshot(ctx: RequestContext): Promise<MemorySnapshot> {
    this.context(ctx);
    return this.transaction(() => this.view(ctx, this.revision(ctx)));
  }
  private view(ctx: RequestContext, at: number): MemorySnapshot {
    const entries = this.visibleRows(ctx).flatMap((row) => {
      const rev = this.latest(row.entry_id, at);
      if (!rev) return [];
      const entry = this.decode(rev);
      return entry.deleted ? [] : [entry];
    });
    return { revision: at, entries };
  }
  async snapshotAt(
    ctx: RequestContext,
    revision: number,
  ): Promise<MemorySnapshot> {
    this.context(ctx);
    validate(z.number().int().nonnegative(), revision);
    return this.transaction(() => {
      if (revision > this.revision(ctx)) fail("invalid_input");
      return this.view(ctx, revision);
    });
  }
  async batch(
    ctx: RequestContext,
    expectedRevision: number,
    operations: MemoryOperation[],
  ): Promise<number> {
    return (await this.batchWithReport(ctx, expectedRevision, operations))
      .revision;
  }
  async batchWithReport(
    ctx: RequestContext,
    expectedRevision: number,
    operations: MemoryOperation[],
  ): Promise<ErasureResult & { revision: number }> {
    this.context(ctx);
    validate(z.number().int().nonnegative(), expectedRevision);
    const ops = validate(z.array(operationSchema), operations);
    return this.write(() => {
      const current = this.revision(ctx);
      if (current !== expectedRevision)
        fail("conflict", { current_revision: current });
      if (!ops.length)
        return {
          revision: current,
          affected_training_manifests: [],
          disclosure: DISCLOSURE,
        };
      const seq = this.nextSeq();
      const removedSources: string[] = [];
      const targets = new Set<"profile" | "project">();
      const changedWorkspaces = new Set<string>();
      for (const op of ops) {
        if (op.operation === "add") {
          targets.add(op.entry.target);
          if (op.entry.target === "project")
            changedWorkspaces.add(op.entry.scope.workspace_id ?? "");
          const entry = {
            ...op.entry,
            fact: this.validateFact(op.entry.fact),
            revision: 1,
          };
          if (entry.deleted) fail("invalid_input");
          if (
            entry.scope.owner_id !== ctx.scope.owner_id ||
            entry.scope.project_id !== ctx.scope.project_id ||
            (entry.scope.workspace_id !== undefined &&
              entry.scope.workspace_id !== ctx.scope.workspace_id) ||
            (entry.target === "profile" &&
              entry.scope.workspace_id !== undefined)
          )
            fail("scope_denied");
          if (
            this.db
              .query("SELECT 1 FROM entries WHERE entry_id=?")
              .get(entry.entry_id) ||
            this.excluded(`memory:${entry.entry_id}`)
          )
            fail("conflict");
          if (entry.supersedes) {
            const old = this.find(ctx, entry.supersedes, true);
            if (
              old.target !== entry.target ||
              canonicalJson(old.scope) !== canonicalJson(entry.scope)
            )
              fail("not_found");
            if (old.target === "project")
              changedWorkspaces.add(old.scope.workspace_id ?? "");
            removedSources.push(...this.memorySources(old.entry_id));
            this.append(
              ctx,
              { ...old, revision: old.revision + 1, deleted: true },
              seq,
              entry.entry_id,
            );
          }
          this.db
            .query("INSERT INTO entries VALUES(?,?,?,?,?,?)")
            .run(
              entry.entry_id,
              entry.scope.owner_id,
              entry.scope.project_id,
              entry.scope.workspace_id ?? "",
              entry.target,
              seq,
            );
          this.append(ctx, entry, seq);
        } else {
          const old = this.find(ctx, op.entry_id, true);
          targets.add(old.target);
          if (old.target === "project")
            changedWorkspaces.add(old.scope.workspace_id ?? "");
          removedSources.push(...this.memorySources(old.entry_id));
          this.append(
            ctx,
            op.operation === "remove"
              ? { ...old, revision: old.revision + 1, deleted: true }
              : {
                  ...old,
                  revision: old.revision + 1,
                  fact: this.validateFact(op.fact),
                  source_event_ids: op.source_event_ids,
                },
            seq,
          );
        }
      }
      this.checkBudgets(ctx, targets, changedWorkspaces);
      return {
        revision: seq,
        affected_training_manifests: this.affected(ctx, removedSources),
        disclosure: DISCLOSURE,
      };
    });
  }
  private checkBudgets(
    ctx: RequestContext,
    targets: Set<"profile" | "project">,
    changedWorkspaces: Set<string>,
  ): void {
    const rows = this.db
      .query(
        "SELECT * FROM entries WHERE owner=? AND (target='profile' OR project=?) ORDER BY first_seq,entry_id",
      )
      .all(ctx.scope.owner_id, ctx.scope.project_id) as EntryRow[];
    const entries = rows.flatMap((row) => {
      const rev = this.latest(row.entry_id);
      if (!rev) fail("corrupt_record");
      const e = this.decode(rev);
      return e.deleted ? [] : [e];
    });
    const check = (target: "profile" | "project", workspace: string) => {
      if (!targets.has(target)) return;
      if (
        target === "project" &&
        workspace &&
        !changedWorkspaces.has("") &&
        !changedWorkspaces.has(workspace)
      )
        return;
      const text = entries
        .filter(
          (e) =>
            e.target === target &&
            (target === "profile" ||
              !e.scope.workspace_id ||
              e.scope.workspace_id === workspace),
        )
        .map((e) => e.fact)
        .join("\n§\n");
      const size = [...text].length,
        limit = this.budgets[target];
      if (size > limit) {
        if (workspace && workspace !== ctx.scope.workspace_id)
          fail("budget_exceeded", {
            target,
            workspace_scoped: true,
            foreign_workspace: true,
            limit,
          });
        fail("budget_exceeded", {
          target,
          workspace_scoped: !!workspace,
          final_chars: size,
          limit,
          over_by: size - limit,
        });
      }
    };
    check("profile", "");
    check("project", "");
    for (const workspace of new Set(
      entries
        .filter((e) => e.target === "project")
        .map((e) => e.scope.workspace_id)
        .filter((s): s is string => !!s),
    ))
      check("project", workspace);
  }
  async search(ctx: RequestContext, query: string): Promise<MemoryEntry[]> {
    this.context(ctx);
    validate(z.string(), query);
    const match = tokens(query);
    if (!match) return [];
    return this.transaction(() =>
      (
        this.db
          .query(
            `SELECT e.entry_id FROM memory_fts JOIN entries e ON e.entry_id=memory_fts.entry_id WHERE memory_fts MATCH ? AND ${visibility} ORDER BY bm25(memory_fts),e.entry_id`,
          )
          .all(match, ...args(ctx)) as { entry_id: string }[]
      ).map((row) => this.find(ctx, row.entry_id, true)),
    );
  }
  async provenance(
    ctx: RequestContext,
    entryId: string,
  ): Promise<MemoryEntry[]> {
    this.context(ctx);
    return this.transaction(() => {
      this.find(ctx, entryId);
      const seen = new Set<string>();
      const output: MemoryEntry[] = [];
      const visit = (key: string) => {
        if (seen.has(key)) return;
        seen.add(key);
        let entry: MemoryEntry;
        try {
          entry = this.find(ctx, key);
        } catch (e) {
          if (e instanceof MemoryStoreError && e.code === "not_found") return;
          throw e;
        }
        const rows = this.db
          .query(
            "SELECT * FROM entry_revisions WHERE entry_id=? ORDER BY revision",
          )
          .all(key) as RevisionRow[];
        if (entry.supersedes) visit(entry.supersedes);
        output.push(...rows.map((row) => this.decode(row)));
        for (const row of rows) if (row.superseded_by) visit(row.superseded_by);
      };
      visit(entryId);
      return output;
    });
  }
  private excluded(key: string): boolean {
    return !!this.db
      .query("SELECT 1 FROM exclusions WHERE digest=?")
      .get(hash(key));
  }
  private exclude(key: string): void {
    this.db.query("INSERT OR IGNORE INTO exclusions VALUES(?)").run(hash(key));
  }
  private journalRows(ctx: RequestContext): JournalRow[] {
    return this.db
      .query(
        `SELECT j.* FROM journal j JOIN sessions s ON s.session_id=j.session_id WHERE ${journalVisibility} ORDER BY j.session_id,j.entry_id`,
      )
      .all(...args(ctx)) as JournalRow[];
  }
  private decodeJournal(row: JournalRow): JournalMessage {
    try {
      const record = JSON.parse(row.record) as JournalMessage;
      if (
        hash(canonicalJson(record)) !== row.row_hash ||
        record.entry_id !== row.entry_id ||
        record.session_id !== row.session_id
      )
        fail("corrupt_record");
      return record;
    } catch {
      fail("corrupt_record");
    }
  }
  async indexJournal(ctx: RequestContext, input: JournalInput): Promise<void> {
    this.context(ctx);
    let messages: JournalMessage[];
    try {
      messages = parseJournal(input, [
        this.options.rootDir,
        path.resolve(this.options.rootDir),
        ...(this.options.hostPrivateRoots ?? []),
      ]);
    } catch {
      fail("journal_incompatible");
    }
    return this.write(() => {
      const existing = this.db
        .query("SELECT scope_key FROM session_claims WHERE session_digest=?")
        .get(hash(input.session_id)) as { scope_key: string } | null;
      if (existing && existing.scope_key !== scopeKey(ctx))
        fail("scope_denied");
      if (this.excluded(`${scopeKey(ctx)}:${input.session_id}`)) return;
      this.db
        .query("INSERT OR IGNORE INTO session_claims VALUES(?,?)")
        .run(hash(input.session_id), scopeKey(ctx));
      this.db
        .query("INSERT OR IGNORE INTO sessions VALUES(?,?,?,?,?)")
        .run(input.session_id, scopeKey(ctx), ...args(ctx));
      this.dropSession(input.session_id, false);
      for (const message of messages) {
        if (
          this.excluded(
            `${scopeKey(ctx)}:${input.session_id}:${message.entry_id}`,
          )
        )
          continue;
        const record = canonicalJson(message);
        this.db
          .query("INSERT INTO journal VALUES(?,?,?,?,?)")
          .run(
            input.session_id,
            message.entry_id,
            scopeKey(ctx),
            record,
            hash(record),
          );
        this.db
          .query(
            "INSERT INTO journal_fts(session_id,entry_id,text) VALUES(?,?,?)",
          )
          .run(input.session_id, message.entry_id, message.text);
      }
    });
  }
  private visibleSession(ctx: RequestContext, sessionId: string): boolean {
    return !!this.db
      .query(
        `SELECT 1 FROM sessions WHERE session_id=? AND ${journalVisibility}`,
      )
      .get(sessionId, ...args(ctx));
  }
  private dropSession(sessionId: string, session = true): void {
    this.db.query("DELETE FROM journal_fts WHERE session_id=?").run(sessionId);
    this.db.query("DELETE FROM journal WHERE session_id=?").run(sessionId);
    if (session)
      this.db.query("DELETE FROM sessions WHERE session_id=?").run(sessionId);
  }
  async searchHistory(
    ctx: RequestContext,
    query: string,
    options: { limit?: number; before?: number; after?: number } = {},
  ): Promise<HistoryHit[]> {
    this.context(ctx);
    validate(z.string(), query);
    const opts = validate(
      z
        .object({
          limit: z.number().int().nonnegative().max(1000).default(20),
          before: z.number().int().nonnegative().max(100).default(0),
          after: z.number().int().nonnegative().max(100).default(0),
        })
        .strict(),
      options,
    );
    const match = tokens(query);
    if (!match) return [];
    return this.transaction(() => {
      const rows = this.db
        .query(
          `SELECT j.* FROM journal_fts JOIN journal j ON j.session_id=journal_fts.session_id AND j.entry_id=journal_fts.entry_id JOIN sessions s ON s.session_id=j.session_id WHERE journal_fts MATCH ? AND ${journalVisibility} ORDER BY bm25(journal_fts),j.session_id,j.entry_id LIMIT ?`,
        )
        .all(match, ...args(ctx), opts.limit) as JournalRow[];
      return rows.map((row) => {
        const message = this.decodeJournal(row);
        const all = (
          this.db
            .query("SELECT * FROM journal WHERE session_id=?")
            .all(row.session_id) as JournalRow[]
        )
          .map((r) => this.decodeJournal(r))
          .sort((a, b) => a.seq - b.seq);
        const before: JournalMessage[] = [],
          after: JournalMessage[] = [];
        const visited = new Set([message.entry_id]);
        let cursor = message;
        for (let n = 0; n < opts.before; n++) {
          const parent = all.find((m) => m.entry_id === cursor.parent_id);
          if (!parent || visited.has(parent.entry_id)) break;
          visited.add(parent.entry_id);
          before.unshift(parent);
          cursor = parent;
        }
        cursor = message;
        for (let n = 0; n < opts.after; n++) {
          const child = all.find((m) => m.parent_id === cursor.entry_id);
          if (!child || visited.has(child.entry_id)) break;
          visited.add(child.entry_id);
          after.push(child);
          cursor = child;
        }
        return {
          source: { session_id: row.session_id, entry_id: row.entry_id },
          role: message.role,
          timestamp: message.timestamp,
          text: message.text,
          surrounding: { before, after },
        };
      });
    });
  }
  async datasetCandidates(ctx: RequestContext): Promise<DatasetCandidate[]> {
    this.context(ctx);
    return this.transaction(() => [
      ...this.view(ctx, this.revision(ctx)).entries.map((e) => ({
        source_id: `memory:${e.entry_id}`,
        source_ids: [`memory:${e.entry_id}`, ...e.source_event_ids],
        text: e.fact,
        kind: "memory" as const,
      })),
      ...this.journalRows(ctx).map((row) => {
        const m = this.decodeJournal(row);
        const source = `journal:${m.session_id}:${m.entry_id}`;
        return {
          source_id: source,
          source_ids: [source],
          text: m.text,
          kind: "journal" as const,
        };
      }),
    ]);
  }
  async recordDatasetUse(
    ctx: RequestContext,
    manifestId: string,
    sourceIds: string[],
  ): Promise<void> {
    this.context(ctx);
    validate(id, manifestId);
    validate(z.array(id), sourceIds);
    return this.write(() => {
      const allowed = new Map<string, Set<string>>();
      const allow = (source: string, evidence: string) => {
        const matches = allowed.get(source) ?? new Set<string>();
        matches.add(evidence);
        allowed.set(source, matches);
      };
      for (const e of this.view(ctx, this.revision(ctx)).entries) {
        allow(`memory:${e.entry_id}`, `memory:${e.entry_id}`);
        for (const s of e.source_event_ids) allow(s, `memory:${e.entry_id}`);
      }
      for (const row of this.journalRows(ctx))
        allow(
          `journal:${row.session_id}:${row.entry_id}`,
          `journal:${row.session_id}:${row.entry_id}`,
        );
      if (sourceIds.some((s) => !allowed.has(s))) fail("not_found");
      for (const source of sourceIds)
        for (const evidence of allowed.get(source) ?? [])
          this.db
            .query("INSERT OR IGNORE INTO dataset_use VALUES(?,?,?,?)")
            .run(scopeKey(ctx), manifestId, source, evidence);
    });
  }
  private affected(ctx: RequestContext, sources: string[]): string[] {
    const out = new Set<string>();
    for (const source of sources)
      for (const row of this.db
        .query(
          "SELECT manifest_id FROM dataset_use WHERE evidence_id=? AND scope_key=?",
        )
        .all(source, scopeKey(ctx)) as { manifest_id: string }[])
        out.add(row.manifest_id);
    return [...out].sort();
  }
  private memorySources(entryId: string): string[] {
    return [`memory:${entryId}`];
  }
  private journalDatasetSources(
    ctx: RequestContext,
    sessionId?: string,
  ): string[] {
    const prefix =
      sessionId === undefined ? "journal:" : `journal:${sessionId}:`;
    return (
      this.db
        .query(
          "SELECT DISTINCT evidence_id FROM dataset_use WHERE scope_key=? AND substr(evidence_id,1,length(?))=?",
        )
        .all(scopeKey(ctx), prefix, prefix) as { evidence_id: string }[]
    ).map((row) => row.evidence_id);
  }
  private clearDatasetUse(ctx: RequestContext, sources: string[]): void {
    for (const source of sources)
      this.db
        .query("DELETE FROM dataset_use WHERE scope_key=? AND evidence_id=?")
        .run(scopeKey(ctx), source);
  }
  private clearExports(owner: string): void {
    for (const row of this.db
      .query("SELECT * FROM exports WHERE owner=?")
      .all(owner) as { scope_key: string; digest: string }[])
      rmSync(
        path.join(
          this.options.rootDir,
          "exports",
          row.scope_key,
          `${row.digest}.json`,
        ),
        { force: true },
      );
    this.db.query("DELETE FROM exports WHERE owner=?").run(owner);
  }
  private eraseEntry(entryId: string): void {
    this.db.query("DELETE FROM memory_fts WHERE entry_id=?").run(entryId);
    this.db.query("DELETE FROM entry_revisions WHERE entry_id=?").run(entryId);
    this.db.query("DELETE FROM entries WHERE entry_id=?").run(entryId);
    this.exclude(`memory:${entryId}`);
  }
  async forgetEntry(
    ctx: RequestContext,
    entryId: string,
  ): Promise<ErasureResult> {
    this.context(ctx);
    return this.write(() => {
      const entry = this.find(ctx, entryId);
      const affected = this.affected(ctx, this.memorySources(entryId));
      const seq = this.nextSeq();
      this.db
        .query("UPDATE streams SET last_seq=? WHERE stream_key=?")
        .run(seq, streamKey(entry));
      this.eraseEntry(entryId);
      this.clearDatasetUse(ctx, this.memorySources(entryId));
      this.clearExports(ctx.scope.owner_id);
      return { affected_training_manifests: affected, disclosure: DISCLOSURE };
    }, true);
  }
  async excludeJournal(
    ctx: RequestContext,
    sessionId: string,
    entryIds?: string[],
  ): Promise<ErasureResult> {
    this.context(ctx);
    validate(id, sessionId);
    if (entryIds) validate(z.array(id), entryIds);
    return this.write(() => {
      if (!this.visibleSession(ctx, sessionId)) fail("not_found");
      const session = this.db
        .query("SELECT scope_key FROM sessions WHERE session_id=?")
        .get(sessionId) as { scope_key: string };
      const sources = entryIds
        ? entryIds.map((key) => `journal:${sessionId}:${key}`)
        : this.journalDatasetSources(ctx, sessionId);
      const affected = this.affected(ctx, sources);
      this.clearDatasetUse(ctx, sources);
      if (!entryIds) {
        this.exclude(`${session.scope_key}:${sessionId}`);
        this.dropSession(sessionId, false);
      } else
        for (const key of entryIds) {
          this.exclude(`${session.scope_key}:${sessionId}:${key}`);
          this.db
            .query("DELETE FROM journal WHERE session_id=? AND entry_id=?")
            .run(sessionId, key);
          this.db
            .query("DELETE FROM journal_fts WHERE session_id=? AND entry_id=?")
            .run(sessionId, key);
        }
      this.clearExports(ctx.scope.owner_id);
      return { affected_training_manifests: affected, disclosure: DISCLOSURE };
    }, true);
  }
  async dropHistory(ctx: RequestContext, sessionId: string): Promise<void> {
    this.context(ctx);
    validate(id, sessionId);
    return this.write(() => {
      if (!this.visibleSession(ctx, sessionId)) fail("not_found");
      this.dropSession(sessionId, false);
    });
  }
  async export(ctx: RequestContext): Promise<ArtifactRef> {
    this.context(ctx);
    return this.write(() => {
      const history = this.visibleRows(ctx).map((row) => ({
        entry_id: row.entry_id,
        revisions: (
          this.db
            .query(
              "SELECT * FROM entry_revisions WHERE entry_id=? ORDER BY revision",
            )
            .all(row.entry_id) as RevisionRow[]
        ).map((r) => this.decode(r)),
      }));
      const sessions = (
        this.db
          .query(
            `SELECT * FROM sessions WHERE ${journalVisibility} ORDER BY session_id`,
          )
          .all(...args(ctx)) as { session_id: string }[]
      ).map((s) => {
        const messages = (
          this.db
            .query("SELECT * FROM journal WHERE session_id=?")
            .all(s.session_id) as JournalRow[]
        )
          .map((r) => this.decodeJournal(r))
          .sort((a, b) => a.seq - b.seq);
        return {
          session_id: s.session_id,
          entry_count: messages.length,
          messages,
        };
      });
      const data = Buffer.from(
        canonicalJson({
          format_version: 1,
          scope: ctx.scope,
          entries: history,
          sessions,
          dataset_use: [
            ...history.map((e) => `memory:${e.entry_id}`),
            ...sessions.flatMap((s) =>
              s.messages.map((m) => `journal:${s.session_id}:${m.entry_id}`),
            ),
          ].flatMap((source) =>
            this.db
              .query(
                "SELECT manifest_id,source_id FROM dataset_use WHERE evidence_id=? AND scope_key=? ORDER BY manifest_id,source_id",
              )
              .all(source, scopeKey(ctx)),
          ),
          disclosure: DISCLOSURE,
        }),
      );
      const digest = hash(data),
        dir = path.join(this.options.rootDir, "exports", scopeKey(ctx));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${digest}.json`);
      const fd = openSync(file, "w", 0o600);
      try {
        writeFileSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const directory = openSync(dir, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      this.db
        .query("INSERT OR IGNORE INTO exports VALUES(?,?,?)")
        .run(scopeKey(ctx), digest, ctx.scope.owner_id);
      return {
        artifact_id: digest,
        sha256: digest,
        media_type: "application/json",
        byte_length: data.length,
      };
    });
  }
  async readExport(ctx: RequestContext, ref: ArtifactRef): Promise<Uint8Array> {
    this.context(ctx);
    validate(ArtifactRefSchema, ref);
    if (ref.artifact_id !== ref.sha256 || ref.media_type !== "application/json")
      fail("not_found");
    if (
      !this.db
        .query("SELECT 1 FROM exports WHERE scope_key=? AND digest=?")
        .get(scopeKey(ctx), ref.sha256)
    )
      fail("not_found");
    try {
      const data = readFileSync(
        path.join(
          this.options.rootDir,
          "exports",
          scopeKey(ctx),
          `${ref.sha256}.json`,
        ),
      );
      if (hash(data) !== ref.sha256 || data.length !== ref.byte_length)
        fail("corrupt_record");
      return data;
    } catch (e) {
      if (e instanceof MemoryStoreError) throw e;
      fail("corrupt_record");
    }
  }
  async delete(ctx: RequestContext): Promise<ErasureResult> {
    this.context(ctx);
    return this.write(() => {
      const entries = this.visibleRows(ctx);
      const journals = this.journalRows(ctx);
      const sources = [
        ...entries.flatMap((e) => this.memorySources(e.entry_id)),
        ...journals.map((r) => `journal:${r.session_id}:${r.entry_id}`),
        ...this.journalDatasetSources(ctx),
      ];
      const affected = this.affected(ctx, sources);
      const seq = this.nextSeq();
      this.db
        .query(`UPDATE streams SET last_seq=? WHERE ${visibility}`)
        .run(seq, ...args(ctx));
      const anchor: MemoryEntry = {
        entry_id: "",
        scope: {
          owner_id: ctx.scope.owner_id,
          project_id: ctx.scope.project_id,
        },
        target: "profile",
        fact: "",
        revision: 0,
        source_event_ids: [],
        observed_at: "",
        verified_at: null,
        supersedes: null,
        deleted: true,
      };
      this.db
        .query(
          "INSERT INTO streams VALUES(?,?,?,?,?,?) ON CONFLICT(stream_key) DO UPDATE SET last_seq=excluded.last_seq",
        )
        .run(streamKey(anchor), ctx.scope.owner_id, "", "", "profile", seq);
      for (const e of entries) this.eraseEntry(e.entry_id);
      for (const s of this.db
        .query(`SELECT * FROM sessions WHERE ${journalVisibility}`)
        .all(...args(ctx)) as { scope_key: string; session_id: string }[]) {
        this.exclude(`${s.scope_key}:${s.session_id}`);
        this.dropSession(s.session_id);
      }
      this.clearExports(ctx.scope.owner_id);
      this.clearDatasetUse(ctx, sources);
      return { affected_training_manifests: affected, disclosure: DISCLOSURE };
    }, true);
  }
  async close(): Promise<void> {
    await this.queue;
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
export function createMemoryStore(
  options: MemoryStoreOptions,
): DurableMemoryStore {
  return new DurableMemoryStore(options);
}
