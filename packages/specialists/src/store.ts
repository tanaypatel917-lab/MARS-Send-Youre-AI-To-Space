import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { RequestContext, Scope } from "@mars/contracts";
import type { z } from "zod";
import { assertPublishable, canonicalJson, sha256 } from "./canonical";
import { SpecialistRegistryError } from "./errors";
import {
  type AuditActionSchema,
  SPECIALIST_STORE_FORMAT_VERSION,
} from "./schemas";

const ZERO_SHA256 = "0".repeat(64);

export interface SpecialistStoreOptions {
  rootDir: string;
  hostPrivateRoots?: readonly string[];
}

export interface SpecialistRevisionRow {
  scope_key: string;
  specialist_id: string;
  revision: string;
  record_json: string;
  record_sha256: string;
  candidate_sha256: string;
  status: string;
  verdict_json: string;
  invalidated_reason: string | null;
  rolled_back_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BaselineRow {
  scope_key: string;
  baseline_id: string;
  revision: string;
  record_json: string;
  record_sha256: string;
  status: string;
  created_at: string;
}

export interface ProductionRow {
  scope_key: string;
  specialist_id: string;
  production_revision: string | null;
  history_json: string;
  retired: number;
  pointer_version: number;
  updated_at: string;
}

export interface EvaluationJobRow {
  job_id: string;
  scope_key: string;
  specialist_id: string;
  revision: string;
  input_manifest_json: string;
  submitted_at: string;
}

export interface RoutingDecisionRow {
  decision_id: string;
  scope_key: string;
  task_id: string;
  request_json: string;
  decision_json: string;
  decision_sha256: string;
  retry_of: string | null;
  attempt: number;
  created_at: string;
}

export interface AuditEventRow {
  seq: number;
  scope_key: string;
  at: string;
  actor: string;
  action: z.infer<typeof AuditActionSchema>;
  subject: string;
  detail_json: string;
  prev_sha256: string;
  sha256: string;
}

function prepareRoot(requestedRoot: string): string {
  if (
    !path.isAbsolute(requestedRoot) ||
    path.resolve(requestedRoot) === path.parse(path.resolve(requestedRoot)).root
  ) {
    throw new SpecialistRegistryError("unsafe_path", "root_not_absolute");
  }
  let rootStat: ReturnType<typeof lstatSync> | undefined;
  try {
    rootStat = lstatSync(requestedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new SpecialistRegistryError("unsafe_path", "root_unavailable");
    }
  }
  if (rootStat) {
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new SpecialistRegistryError("unsafe_path", "root_not_directory");
    }
  } else {
    try {
      mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
    } catch {
      throw new SpecialistRegistryError("unsafe_path", "root_unavailable");
    }
  }
  try {
    chmodSync(requestedRoot, 0o700);
  } catch {
    throw new SpecialistRegistryError("unsafe_path", "root_unavailable");
  }
  const rootDir = path.resolve(requestedRoot);
  const databasePath = path.join(rootDir, "specialists.sqlite");
  try {
    const stat = lstatSync(databasePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new SpecialistRegistryError("unsafe_path", "database_not_regular");
    }
  } catch (error) {
    if (error instanceof SpecialistRegistryError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new SpecialistRegistryError("unsafe_path", "database_unavailable");
    }
  }
  return rootDir;
}

export class SpecialistStore {
  readonly rootDir: string;
  readonly databasePath: string;
  readonly db!: Database;
  private closed = false;
  private readonly hostPrivateRoots: readonly string[];

  constructor(options: SpecialistStoreOptions) {
    if (!options || typeof options.rootDir !== "string") {
      throw new SpecialistRegistryError("unsafe_path", "root_not_absolute");
    }
    this.hostPrivateRoots = options.hostPrivateRoots ?? [];
    this.rootDir = prepareRoot(options.rootDir);
    this.databasePath = path.join(this.rootDir, "specialists.sqlite");
    let opened: Database | undefined;
    try {
      opened = new Database(this.databasePath, {
        create: true,
        strict: true,
      });
      this.db = opened;
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;",
      );
      chmodSync(this.databasePath, 0o600);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS specialist_revisions (
          scope_key TEXT NOT NULL,
          specialist_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          record_json TEXT NOT NULL,
          record_sha256 TEXT NOT NULL,
          candidate_sha256 TEXT NOT NULL,
          status TEXT NOT NULL,
          verdict_json TEXT NOT NULL,
          invalidated_reason TEXT,
          rolled_back_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (scope_key, specialist_id, revision)
        );
        CREATE TABLE IF NOT EXISTS baselines (
          scope_key TEXT NOT NULL,
          baseline_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          record_json TEXT NOT NULL,
          record_sha256 TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (scope_key, baseline_id, revision)
        );
        CREATE TABLE IF NOT EXISTS production (
          scope_key TEXT NOT NULL,
          specialist_id TEXT NOT NULL,
          production_revision TEXT,
          history_json TEXT NOT NULL,
          retired INTEGER NOT NULL,
          pointer_version INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (scope_key, specialist_id)
        );
        CREATE TABLE IF NOT EXISTS evaluation_jobs (
          job_id TEXT PRIMARY KEY,
          scope_key TEXT NOT NULL,
          specialist_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          input_manifest_json TEXT NOT NULL,
          submitted_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS routing_decisions (
          decision_id TEXT PRIMARY KEY,
          scope_key TEXT NOT NULL,
          task_id TEXT NOT NULL,
          request_json TEXT NOT NULL,
          decision_json TEXT NOT NULL,
          decision_sha256 TEXT NOT NULL,
          retry_of TEXT,
          attempt INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          scope_key TEXT NOT NULL,
          at TEXT NOT NULL,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          subject TEXT NOT NULL,
          detail_json TEXT NOT NULL,
          prev_sha256 TEXT NOT NULL,
          sha256 TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS specialist_scope_idx
          ON specialist_revisions(scope_key, specialist_id);
        CREATE INDEX IF NOT EXISTS baseline_scope_idx
          ON baselines(scope_key, baseline_id);
        CREATE INDEX IF NOT EXISTS routing_scope_idx
          ON routing_decisions(scope_key, task_id);
      `);
      const format = this.db
        .query("SELECT value FROM meta WHERE key = 'format_version'")
        .get() as { value: string } | null;
      if (format && Number(format.value) !== SPECIALIST_STORE_FORMAT_VERSION) {
        throw new SpecialistRegistryError("corrupt_record", "format_version");
      }
      if (!format) {
        this.transaction(() => {
          this.db
            .query("INSERT INTO meta (key, value) VALUES ('format_version', ?)")
            .run(String(SPECIALIST_STORE_FORMAT_VERSION));
        });
      }
    } catch (error) {
      try {
        opened?.close();
      } catch {
        // Preserve the original safe error.
      }
      if (error instanceof SpecialistRegistryError) {
        throw error;
      }
      throw new SpecialistRegistryError("unsafe_path", "database_open_failed");
    }
  }

  assertOpen(): void {
    if (this.closed) throw new SpecialistRegistryError("closed");
  }

  transaction<T>(callback: () => T): T {
    this.assertOpen();
    try {
      return this.db.transaction(callback).immediate();
    } catch (error) {
      if (error instanceof SpecialistRegistryError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (message.includes("UNIQUE constraint failed")) {
        throw new SpecialistRegistryError("conflict", "revision_immutable");
      }
      throw error;
    }
  }

  readSpecialist(
    scopeKey: string,
    specialistId: string,
    revision: string,
  ): SpecialistRevisionRow | null {
    this.assertOpen();
    return this.db
      .query(
        `SELECT scope_key, specialist_id, revision, record_json, record_sha256,
          candidate_sha256, status, verdict_json, invalidated_reason,
          rolled_back_at, created_at, updated_at
         FROM specialist_revisions
         WHERE scope_key = ? AND specialist_id = ? AND revision = ?`,
      )
      .get(scopeKey, specialistId, revision) as SpecialistRevisionRow | null;
  }

  readBaseline(
    scopeKey: string,
    baselineId: string,
    revision: string,
  ): BaselineRow | null {
    this.assertOpen();
    return this.db
      .query(
        `SELECT scope_key, baseline_id, revision, record_json, record_sha256,
          status, created_at FROM baselines
         WHERE scope_key = ? AND baseline_id = ? AND revision = ?`,
      )
      .get(scopeKey, baselineId, revision) as BaselineRow | null;
  }

  readProduction(scopeKey: string, specialistId: string): ProductionRow | null {
    this.assertOpen();
    return this.db
      .query(
        `SELECT scope_key, specialist_id, production_revision, history_json,
          retired, pointer_version, updated_at FROM production
         WHERE scope_key = ? AND specialist_id = ?`,
      )
      .get(scopeKey, specialistId) as ProductionRow | null;
  }

  parseRecord<T>(
    recordJson: string,
    recordSha256: string,
    parse: (v: unknown) => T,
  ): T {
    this.assertOpen();
    try {
      if (sha256(recordJson) !== recordSha256) {
        throw new Error("hash");
      }
      const parsed = parse(JSON.parse(recordJson) as unknown);
      if (canonicalJson(parsed) !== recordJson) {
        throw new Error("canonical_json");
      }
      assertPublishable(parsed, {
        rootDir: this.rootDir,
        hostPrivateRoots: this.hostPrivateRoots,
      });
      return parsed;
    } catch (error) {
      if (
        error instanceof SpecialistRegistryError &&
        error.code === "unsafe_content"
      ) {
        throw error;
      }
      throw new SpecialistRegistryError("corrupt_record");
    }
  }

  writeAudit(input: {
    context: RequestContext;
    scope_key: string;
    action: z.infer<typeof AuditActionSchema>;
    subject: string;
    detail: unknown;
  }): void {
    this.assertOpen();
    const detail = {
      ...(input.detail !== null && typeof input.detail === "object"
        ? (input.detail as Record<string, unknown>)
        : { value: input.detail }),
      request_id: input.context.request_id,
    };
    assertPublishable(detail, {
      rootDir: this.rootDir,
      hostPrivateRoots: this.hostPrivateRoots,
    });
    const detailJson = canonicalJson(detail);
    const previous = this.db
      .query(
        "SELECT sha256 FROM audit_events WHERE scope_key = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(input.scope_key) as { sha256: string } | null;
    const event = {
      scope_key: input.scope_key,
      at: new Date().toISOString(),
      actor: `owner:${input.context.scope.owner_id}`,
      action: input.action,
      subject: input.subject,
      detail_json: detailJson,
      prev_sha256: previous?.sha256 ?? ZERO_SHA256,
    };
    const insert = this.db.query(
      `INSERT INTO audit_events
       (scope_key, at, actor, action, subject, detail_json, prev_sha256, sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const digest = sha256(
      canonicalJson({
        scope_key: event.scope_key,
        at: event.at,
        actor: event.actor,
        action: event.action,
        subject: event.subject,
        detail_json: event.detail_json,
        prev_sha256: event.prev_sha256,
      }),
    );
    insert.run(
      event.scope_key,
      event.at,
      event.actor,
      event.action,
      event.subject,
      event.detail_json,
      event.prev_sha256,
      digest,
    );
  }

  audit(
    _context: RequestContext,
    scopeKey: string,
  ): Array<{
    seq: number;
    at: string;
    actor: string;
    action: z.infer<typeof AuditActionSchema>;
    subject: string;
    detail: unknown;
    prev_sha256: string;
    sha256: string;
  }> {
    this.assertOpen();
    const rows = this.db
      .query(
        `SELECT seq, scope_key, at, actor, action, subject, detail_json,
          prev_sha256, sha256 FROM audit_events
         WHERE scope_key = ? ORDER BY seq`,
      )
      .all(scopeKey) as AuditEventRow[];
    let previous = ZERO_SHA256;
    const output = [];
    for (const row of rows) {
      let detail: unknown;
      try {
        detail = JSON.parse(row.detail_json) as unknown;
      } catch {
        throw new SpecialistRegistryError("corrupt_record");
      }
      if (canonicalJson(detail) !== row.detail_json) {
        throw new SpecialistRegistryError("corrupt_record");
      }
      assertPublishable(detail, {
        rootDir: this.rootDir,
        hostPrivateRoots: this.hostPrivateRoots,
      });
      const expected = sha256(
        canonicalJson({
          scope_key: row.scope_key,
          at: row.at,
          actor: row.actor,
          action: row.action,
          subject: row.subject,
          detail_json: row.detail_json,
          prev_sha256: row.prev_sha256,
        }),
      );
      if (row.prev_sha256 !== previous || row.sha256 !== expected) {
        throw new SpecialistRegistryError("corrupt_record");
      }
      previous = row.sha256;
      output.push({
        seq: row.seq,
        at: row.at,
        actor: row.actor,
        action: row.action,
        subject: row.subject,
        detail,
        prev_sha256: row.prev_sha256,
        sha256: row.sha256,
      });
    }
    assertPublishable(output, {
      rootDir: this.rootDir,
      hostPrivateRoots: this.hostPrivateRoots,
    });
    return output;
  }

  findScopeForDecision(decisionId: string): string | null {
    const row = this.db
      .query("SELECT scope_key FROM routing_decisions WHERE decision_id = ?")
      .get(decisionId) as { scope_key: string } | null;
    return row?.scope_key ?? null;
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

export function contextScope(context: RequestContext): Scope {
  return {
    owner_id: context.scope.owner_id,
    project_id: context.scope.project_id,
    ...(context.scope.workspace_id === undefined
      ? {}
      : { workspace_id: context.scope.workspace_id }),
  };
}
