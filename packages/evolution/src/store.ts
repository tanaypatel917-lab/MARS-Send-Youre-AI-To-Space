import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { EvolutionError, fail } from "./errors";
import { EVOLUTION_STORE_FORMAT_VERSION } from "./schemas";
import { digestOf, sha256 } from "./util";

const ZERO = "0".repeat(64);

export interface RunRow {
  run_id: string;
  scope_key: string;
  config_json: string;
  config_sha256: string;
  control_json: string;
  status: string;
  revision: number;
  created_at: string;
  updated_at: string;
  deadline_ms: number;
  lease_holder: string | null;
  lease_token: number;
  lease_expires_ms: number;
}

export interface CandidateRow {
  run_id: string;
  candidate_id: string;
  parent_id: string | null;
  generation: number;
  seq: number;
  depth: number;
  manifest_json: string;
  manifest_sha256: string;
  proposal_json: string;
  state: string;
  eligible: number;
  score: number | null;
  selection_json: string | null;
  bundle_sha256: string | null;
  reason: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface LedgerRow {
  seq: number;
  run_id: string;
  kind: "reserve" | "settle";
  key: string;
  tokens: number;
  usd: number;
  ms: number;
  prev_sha256: string;
  sha256: string;
  created_at: string;
}

export interface ChampionEntryRow {
  seq: number;
  scope_key: string;
  run_id: string;
  candidate_id: string;
  manifest_json: string;
  manifest_sha256: string;
  bundle_sha256: string | null;
  decision_id: string | null;
  action: "initial" | "deploy" | "rollback";
  target_seq: number | null;
  prev_sha256: string;
  sha256: string;
  created_at: string;
}

function ledgerDigest(row: Omit<LedgerRow, "seq" | "sha256">): string {
  return digestOf([
    row.run_id,
    row.kind,
    row.key,
    row.tokens,
    row.usd,
    row.ms,
    row.prev_sha256,
    row.created_at,
  ]);
}

function championDigest(row: Omit<ChampionEntryRow, "seq" | "sha256">): string {
  return digestOf([
    row.scope_key,
    row.run_id,
    row.candidate_id,
    row.manifest_sha256,
    sha256(row.manifest_json),
    row.bundle_sha256,
    row.decision_id,
    row.action,
    row.target_seq,
    row.prev_sha256,
    row.created_at,
  ]);
}

/**
 * Durable evolution store (one SQLite file, WAL, synchronous=FULL). Holds the
 * research archive, lineage, evaluations, the hash-chained experiment ledger
 * and — in separate tables — the production champion pointer and its
 * hash-chained history. Every multi-row change runs in one IMMEDIATE
 * transaction so a crash leaves either the old or the new state.
 */
export class EvolutionStore {
  readonly db: Database;
  readonly path: string;
  private closed = false;

  constructor(rootDir: string) {
    if (!isAbsolute(rootDir) || resolve(rootDir) === "/")
      fail("unsafe_path", "store root must be an absolute directory");
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    const info = lstatSync(rootDir);
    if (info.isSymbolicLink() || !info.isDirectory())
      fail("unsafe_path", "store root is not a directory");
    chmodSync(rootDir, 0o700);
    this.path = join(rootDir, "evolution.sqlite");
    try {
      const file = lstatSync(this.path);
      if (file.isSymbolicLink() || !file.isFile())
        fail("unsafe_path", "store database is not a regular file");
    } catch (error) {
      if (error instanceof EvolutionError) throw error;
    }
    this.db = new Database(this.path, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;",
    );
    chmodSync(this.path, 0o600);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blobs (sha256 TEXT PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (tree_sha256 TEXT PRIMARY KEY, entries_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, config_json TEXT NOT NULL,
        config_sha256 TEXT NOT NULL, control_json TEXT NOT NULL, status TEXT NOT NULL,
        revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        deadline_ms INTEGER NOT NULL, lease_holder TEXT, lease_token INTEGER NOT NULL,
        lease_expires_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candidates (
        run_id TEXT NOT NULL REFERENCES runs(run_id), candidate_id TEXT NOT NULL,
        parent_id TEXT, generation INTEGER NOT NULL, seq INTEGER NOT NULL, depth INTEGER NOT NULL,
        manifest_json TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, proposal_json TEXT NOT NULL,
        state TEXT NOT NULL, eligible INTEGER NOT NULL, score REAL, selection_json TEXT,
        bundle_sha256 TEXT, reason TEXT, revision INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, candidate_id),
        FOREIGN KEY (run_id, parent_id) REFERENCES candidates(run_id, candidate_id)
      );
      CREATE TABLE IF NOT EXISTS evaluations (
        run_id TEXT NOT NULL, candidate_id TEXT NOT NULL, split TEXT NOT NULL, key TEXT NOT NULL,
        outcome_json TEXT NOT NULL, outcome_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, candidate_id, split, key)
      );
      CREATE TABLE IF NOT EXISTS generations (
        run_id TEXT NOT NULL, generation INTEGER NOT NULL, plan_json TEXT NOT NULL,
        record_json TEXT, PRIMARY KEY (run_id, generation)
      );
      CREATE TABLE IF NOT EXISTS ledger (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, kind TEXT NOT NULL,
        key TEXT NOT NULL, tokens INTEGER NOT NULL, usd REAL NOT NULL, ms INTEGER NOT NULL,
        prev_sha256 TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE (run_id, kind, key)
      );
      CREATE TABLE IF NOT EXISTS champion (
        scope_key TEXT PRIMARY KEY, entry_seq INTEGER NOT NULL, pointer_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS champion_entries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, scope_key TEXT NOT NULL, run_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL, manifest_json TEXT NOT NULL, manifest_sha256 TEXT NOT NULL,
        bundle_sha256 TEXT, decision_id TEXT, action TEXT NOT NULL, target_seq INTEGER,
        prev_sha256 TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, run_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, decision_json TEXT NOT NULL,
        decision_sha256 TEXT NOT NULL, deployed_entry_seq INTEGER, created_at TEXT NOT NULL,
        UNIQUE (scope_key, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS candidates_run_idx ON candidates(run_id, seq);
      CREATE INDEX IF NOT EXISTS ledger_run_idx ON ledger(run_id, seq);
      CREATE INDEX IF NOT EXISTS champion_entries_scope_idx ON champion_entries(scope_key, seq);
    `);
    const format = this.db
      .query("SELECT value FROM meta WHERE key = 'format_version'")
      .get() as { value: string } | null;
    if (format && Number(format.value) !== EVOLUTION_STORE_FORMAT_VERSION)
      fail("corrupt_record", "unsupported evolution store format");
    if (!format)
      this.db
        .query("INSERT INTO meta (key, value) VALUES ('format_version', ?)")
        .run(String(EVOLUTION_STORE_FORMAT_VERSION));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  assertOpen(): void {
    if (this.closed) fail("closed");
  }

  transaction<T>(callback: () => T): T {
    this.assertOpen();
    return this.db.transaction(callback).immediate();
  }

  putBlob(data: Uint8Array): string {
    const digest = sha256(data);
    this.db
      .query("INSERT OR IGNORE INTO blobs (sha256, data) VALUES (?, ?)")
      .run(digest, data);
    return digest;
  }

  getBlob(digest: string): Uint8Array {
    const row = this.db
      .query("SELECT data FROM blobs WHERE sha256 = ?")
      .get(digest) as {
      data: Uint8Array;
    } | null;
    if (!row) fail("corrupt_record", `missing blob ${digest}`);
    const data = new Uint8Array(row.data);
    if (sha256(data) !== digest)
      fail("corrupt_record", `blob ${digest} does not match its digest`);
    return data;
  }

  putSnapshot(treeSha256: string, entriesJson: string): void {
    this.db
      .query(
        "INSERT OR IGNORE INTO snapshots (tree_sha256, entries_json) VALUES (?, ?)",
      )
      .run(treeSha256, entriesJson);
  }

  getSnapshot(treeSha256: string): string {
    const row = this.db
      .query("SELECT entries_json FROM snapshots WHERE tree_sha256 = ?")
      .get(treeSha256) as { entries_json: string } | null;
    if (!row) fail("corrupt_record", `missing snapshot ${treeSha256}`);
    return row.entries_json;
  }

  getRun(runId: string): RunRow | null {
    return this.db
      .query("SELECT * FROM runs WHERE run_id = ?")
      .get(runId) as RunRow | null;
  }

  listRuns(scopeKey: string): RunRow[] {
    return this.db
      .query(
        "SELECT * FROM runs WHERE scope_key = ? ORDER BY created_at, run_id",
      )
      .all(scopeKey) as RunRow[];
  }

  insertRun(row: RunRow): void {
    this.db
      .query(
        `INSERT INTO runs (run_id, scope_key, config_json, config_sha256, control_json, status,
          revision, created_at, updated_at, deadline_ms, lease_holder, lease_token, lease_expires_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.run_id,
        row.scope_key,
        row.config_json,
        row.config_sha256,
        row.control_json,
        row.status,
        row.revision,
        row.created_at,
        row.updated_at,
        row.deadline_ms,
        row.lease_holder,
        row.lease_token,
        row.lease_expires_ms,
      );
  }

  /** Takes or renews the run lease; returns the fencing token. */
  acquireLease(
    runId: string,
    holder: string,
    nowMs: number,
    ttlMs: number,
  ): number {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (!run) fail("not_found", `run ${runId}`);
      if (
        run.lease_holder !== null &&
        run.lease_holder !== holder &&
        run.lease_expires_ms > nowMs
      )
        fail("stale_lease", `run ${runId} is leased by another driver`);
      const token =
        run.lease_holder === holder && run.lease_expires_ms > nowMs
          ? run.lease_token
          : run.lease_token + 1;
      this.db
        .query(
          "UPDATE runs SET lease_holder = ?, lease_token = ?, lease_expires_ms = ?, revision = revision + 1 WHERE run_id = ?",
        )
        .run(holder, token, nowMs + ttlMs, runId);
      return token;
    });
  }

  renewLease(runId: string, token: number, nowMs: number, ttlMs: number): void {
    const updated = this.db
      .query(
        "UPDATE runs SET lease_expires_ms = ?, revision = revision + 1 WHERE run_id = ? AND lease_token = ? AND lease_expires_ms > ?",
      )
      .run(nowMs + ttlMs, runId, token, nowMs);
    if (updated.changes === 0)
      fail(
        "stale_lease",
        `lease token ${token} for run ${runId} is no longer valid`,
      );
  }

  /** Fencing check: called inside every write transaction made under a lease. */
  assertLease(runId: string, token: number, nowMs: number): void {
    const run = this.getRun(runId);
    if (!run || run.lease_token !== token || run.lease_expires_ms <= nowMs)
      fail(
        "stale_lease",
        `lease token ${token} for run ${runId} is no longer valid`,
      );
  }

  releaseLease(runId: string, token: number): void {
    this.db
      .query(
        "UPDATE runs SET lease_holder = NULL, lease_expires_ms = 0 WHERE run_id = ? AND lease_token = ?",
      )
      .run(runId, token);
  }

  setRunStatus(runId: string, status: string, nowIso: string): void {
    this.db
      .query(
        "UPDATE runs SET status = ?, updated_at = ?, revision = revision + 1 WHERE run_id = ?",
      )
      .run(status, nowIso, runId);
  }

  getCandidate(runId: string, candidateId: string): CandidateRow | null {
    return this.db
      .query("SELECT * FROM candidates WHERE run_id = ? AND candidate_id = ?")
      .get(runId, candidateId) as CandidateRow | null;
  }

  listCandidates(runId: string): CandidateRow[] {
    return this.db
      .query("SELECT * FROM candidates WHERE run_id = ? ORDER BY seq")
      .all(runId) as CandidateRow[];
  }

  nextSeq(runId: string): number {
    const row = this.db
      .query(
        "SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM candidates WHERE run_id = ?",
      )
      .get(runId) as { next: number };
    return row.next;
  }

  insertCandidate(row: CandidateRow): void {
    this.db
      .query(
        `INSERT INTO candidates (run_id, candidate_id, parent_id, generation, seq, depth, manifest_json,
          manifest_sha256, proposal_json, state, eligible, score, selection_json, bundle_sha256, reason,
          revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.run_id,
        row.candidate_id,
        row.parent_id,
        row.generation,
        row.seq,
        row.depth,
        row.manifest_json,
        row.manifest_sha256,
        row.proposal_json,
        row.state,
        row.eligible,
        row.score,
        row.selection_json,
        row.bundle_sha256,
        row.reason,
        row.revision,
        row.created_at,
        row.updated_at,
      );
  }

  /** Compare-and-set candidate update fenced by the expected revision. */
  updateCandidate(
    runId: string,
    candidateId: string,
    expectedRevision: number,
    patch: Partial<
      Pick<
        CandidateRow,
        | "state"
        | "eligible"
        | "score"
        | "selection_json"
        | "bundle_sha256"
        | "reason"
      >
    >,
    nowIso: string,
  ): number {
    const current = this.getCandidate(runId, candidateId);
    if (!current) fail("not_found", `candidate ${candidateId}`);
    if (current.revision !== expectedRevision)
      fail(
        "stale_revision",
        `candidate ${candidateId} revision ${current.revision} ≠ ${expectedRevision}`,
      );
    const next = { ...current, ...patch };
    this.db
      .query(
        `UPDATE candidates SET state = ?, eligible = ?, score = ?, selection_json = ?, bundle_sha256 = ?,
          reason = ?, revision = revision + 1, updated_at = ? WHERE run_id = ? AND candidate_id = ?`,
      )
      .run(
        next.state,
        next.eligible,
        next.score,
        next.selection_json,
        next.bundle_sha256,
        next.reason,
        nowIso,
        runId,
        candidateId,
      );
    return expectedRevision + 1;
  }

  putEvaluation(
    runId: string,
    candidateId: string,
    split: string,
    key: string,
    outcomeJson: string,
    nowIso: string,
  ): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO evaluations (run_id, candidate_id, split, key, outcome_json, outcome_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        candidateId,
        split,
        key,
        outcomeJson,
        sha256(outcomeJson),
        nowIso,
      );
  }

  getEvaluation(
    runId: string,
    candidateId: string,
    split: string,
    key: string,
  ): string | null {
    const row = this.db
      .query(
        "SELECT outcome_json, outcome_sha256 FROM evaluations WHERE run_id = ? AND candidate_id = ? AND split = ? AND key = ?",
      )
      .get(runId, candidateId, split, key) as {
      outcome_json: string;
      outcome_sha256: string;
    } | null;
    if (!row) return null;
    if (sha256(row.outcome_json) !== row.outcome_sha256)
      fail(
        "accounting_tampered",
        `evaluation ${candidateId}/${split}/${key} digest mismatch`,
      );
    return row.outcome_json;
  }

  listSelectionEvaluations(
    runId: string,
    candidateId: string,
  ): { key: string; outcome_json: string }[] {
    const rows = this.db
      .query(
        "SELECT key, outcome_json, outcome_sha256 FROM evaluations WHERE run_id = ? AND candidate_id = ? AND split = 'selection' ORDER BY key",
      )
      .all(runId, candidateId) as {
      key: string;
      outcome_json: string;
      outcome_sha256: string;
    }[];
    return rows.map((row) => {
      if (sha256(row.outcome_json) !== row.outcome_sha256)
        fail(
          "accounting_tampered",
          `evaluation ${candidateId}/selection/${row.key} digest mismatch`,
        );
      return { key: row.key, outcome_json: row.outcome_json };
    });
  }

  evaluationSubjects(runId: string, split: string, key: string): string[] {
    return (
      this.db
        .query(
          "SELECT DISTINCT candidate_id FROM evaluations WHERE run_id = ? AND split = ? AND key = ? ORDER BY candidate_id",
        )
        .all(runId, split, key) as { candidate_id: string }[]
    ).map((row) => row.candidate_id);
  }

  countEvaluations(runId: string, split: string, excludeKey = ""): number {
    const row = this.db
      .query(
        "SELECT COUNT(DISTINCT key) AS n FROM evaluations WHERE run_id = ? AND split = ? AND key <> ?",
      )
      .get(runId, split, excludeKey) as { n: number };
    return row.n;
  }

  getGeneration(
    runId: string,
    generation: number,
  ): { plan_json: string; record_json: string | null } | null {
    return this.db
      .query(
        "SELECT plan_json, record_json FROM generations WHERE run_id = ? AND generation = ?",
      )
      .get(runId, generation) as {
      plan_json: string;
      record_json: string | null;
    } | null;
  }

  listGenerations(
    runId: string,
  ): { generation: number; plan_json: string; record_json: string | null }[] {
    return this.db
      .query(
        "SELECT generation, plan_json, record_json FROM generations WHERE run_id = ? ORDER BY generation",
      )
      .all(runId) as {
      generation: number;
      plan_json: string;
      record_json: string | null;
    }[];
  }

  putGenerationPlan(runId: string, generation: number, planJson: string): void {
    this.db
      .query(
        "INSERT OR IGNORE INTO generations (run_id, generation, plan_json, record_json) VALUES (?, ?, ?, NULL)",
      )
      .run(runId, generation, planJson);
  }

  finishGeneration(
    runId: string,
    generation: number,
    recordJson: string,
  ): void {
    this.db
      .query(
        "UPDATE generations SET record_json = ? WHERE run_id = ? AND generation = ? AND record_json IS NULL",
      )
      .run(recordJson, runId, generation);
  }

  ledger(runId: string): LedgerRow[] {
    return this.db
      .query("SELECT * FROM ledger WHERE run_id = ? ORDER BY seq")
      .all(runId) as LedgerRow[];
  }

  /** Appends one hash-chained ledger row; a repeated (kind, key) is a no-op (idempotency). */
  appendLedger(
    runId: string,
    kind: LedgerRow["kind"],
    key: string,
    amounts: { tokens: number; usd: number; ms: number },
    nowIso: string,
  ): boolean {
    const exists = this.db
      .query("SELECT 1 FROM ledger WHERE run_id = ? AND kind = ? AND key = ?")
      .get(runId, kind, key);
    if (exists) return false;
    const last = this.db
      .query(
        "SELECT sha256 FROM ledger WHERE run_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(runId) as { sha256: string } | null;
    const row = {
      run_id: runId,
      kind,
      key,
      tokens: Math.round(amounts.tokens),
      usd: amounts.usd,
      ms: Math.round(amounts.ms),
      prev_sha256: last?.sha256 ?? ZERO,
      created_at: nowIso,
    };
    this.db
      .query(
        `INSERT INTO ledger (run_id, kind, key, tokens, usd, ms, prev_sha256, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.run_id,
        row.kind,
        row.key,
        row.tokens,
        row.usd,
        row.ms,
        row.prev_sha256,
        ledgerDigest(row),
        row.created_at,
      );
    return true;
  }

  /** Recomputes the ledger hash chain; throws `accounting_tampered` on any edited, removed or reordered row. */
  verifyLedger(runId: string): void {
    let previous = ZERO;
    for (const row of this.ledger(runId)) {
      if (row.prev_sha256 !== previous || ledgerDigest(row) !== row.sha256)
        fail(
          "accounting_tampered",
          `ledger row ${row.seq} of run ${runId} fails its hash chain`,
        );
      previous = row.sha256;
    }
  }

  championPointer(
    scopeKey: string,
  ): { entry_seq: number; pointer_version: number } | null {
    return this.db
      .query(
        "SELECT entry_seq, pointer_version FROM champion WHERE scope_key = ?",
      )
      .get(scopeKey) as { entry_seq: number; pointer_version: number } | null;
  }

  championEntries(scopeKey: string): ChampionEntryRow[] {
    return this.db
      .query("SELECT * FROM champion_entries WHERE scope_key = ? ORDER BY seq")
      .all(scopeKey) as ChampionEntryRow[];
  }

  championEntry(scopeKey: string, seq: number): ChampionEntryRow | null {
    return this.db
      .query("SELECT * FROM champion_entries WHERE scope_key = ? AND seq = ?")
      .get(scopeKey, seq) as ChampionEntryRow | null;
  }

  verifyChampionChain(scopeKey: string): void {
    let previous = ZERO;
    for (const row of this.championEntries(scopeKey)) {
      if (
        row.prev_sha256 !== previous ||
        championDigest(row) !== row.sha256 ||
        sha256(row.manifest_json) !== row.manifest_sha256
      )
        fail(
          "accounting_tampered",
          `champion history entry ${row.seq} fails its hash chain`,
        );
      previous = row.sha256;
    }
    const pointer = this.championPointer(scopeKey);
    if (pointer && !this.championEntry(scopeKey, pointer.entry_seq))
      fail("corrupt_record", "champion pointer names a missing history entry");
  }

  /**
   * Appends a champion history entry and moves the pointer to it, fenced by
   * the expected pointer version (null = no champion yet).
   */
  moveChampion(
    entry: Omit<ChampionEntryRow, "seq" | "prev_sha256" | "sha256">,
    expectedPointerVersion: number | null,
    pointsTo: "new" | number,
  ): { entry_seq: number; pointer_version: number } {
    const pointer = this.championPointer(entry.scope_key);
    if ((pointer?.pointer_version ?? null) !== expectedPointerVersion)
      fail(
        "stale_revision",
        `champion pointer version is ${pointer?.pointer_version ?? "none"}, expected ${expectedPointerVersion ?? "none"}`,
      );
    const last = this.db
      .query(
        "SELECT sha256 FROM champion_entries WHERE scope_key = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(entry.scope_key) as { sha256: string } | null;
    const row = { ...entry, prev_sha256: last?.sha256 ?? ZERO };
    const inserted = this.db
      .query(
        `INSERT INTO champion_entries (scope_key, run_id, candidate_id, manifest_json, manifest_sha256, bundle_sha256,
          decision_id, action, target_seq, prev_sha256, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      )
      .get(
        row.scope_key,
        row.run_id,
        row.candidate_id,
        row.manifest_json,
        row.manifest_sha256,
        row.bundle_sha256,
        row.decision_id,
        row.action,
        row.target_seq,
        row.prev_sha256,
        championDigest(row),
        row.created_at,
      ) as { seq: number };
    const target = pointsTo === "new" ? inserted.seq : pointsTo;
    const version = (pointer?.pointer_version ?? 0) + 1;
    this.db
      .query(
        `INSERT INTO champion (scope_key, entry_seq, pointer_version, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET entry_seq = excluded.entry_seq,
           pointer_version = excluded.pointer_version, updated_at = excluded.updated_at`,
      )
      .run(entry.scope_key, target, version, entry.created_at);
    return { entry_seq: target, pointer_version: version };
  }

  getDecisionByKey(
    scopeKey: string,
    idempotencyKey: string,
  ): {
    decision_json: string;
    decision_sha256: string;
    deployed_entry_seq: number | null;
  } | null {
    return this.db
      .query(
        "SELECT decision_json, decision_sha256, deployed_entry_seq FROM decisions WHERE scope_key = ? AND idempotency_key = ?",
      )
      .get(scopeKey, idempotencyKey) as {
      decision_json: string;
      decision_sha256: string;
      deployed_entry_seq: number | null;
    } | null;
  }

  getDecision(decisionId: string): {
    scope_key: string;
    decision_json: string;
    decision_sha256: string;
    deployed_entry_seq: number | null;
  } | null {
    return this.db
      .query(
        "SELECT scope_key, decision_json, decision_sha256, deployed_entry_seq FROM decisions WHERE decision_id = ?",
      )
      .get(decisionId) as {
      scope_key: string;
      decision_json: string;
      decision_sha256: string;
      deployed_entry_seq: number | null;
    } | null;
  }

  insertDecision(row: {
    decision_id: string;
    scope_key: string;
    run_id: string;
    candidate_id: string;
    idempotency_key: string;
    decision_json: string;
    created_at: string;
  }): void {
    this.db
      .query(
        `INSERT INTO decisions (decision_id, scope_key, run_id, candidate_id, idempotency_key, decision_json,
          decision_sha256, deployed_entry_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        row.decision_id,
        row.scope_key,
        row.run_id,
        row.candidate_id,
        row.idempotency_key,
        row.decision_json,
        sha256(row.decision_json),
        row.created_at,
      );
  }

  markDecisionDeployed(decisionId: string, entrySeq: number): void {
    this.db
      .query(
        "UPDATE decisions SET deployed_entry_seq = ? WHERE decision_id = ? AND deployed_entry_seq IS NULL",
      )
      .run(entrySeq, decisionId);
  }
}
