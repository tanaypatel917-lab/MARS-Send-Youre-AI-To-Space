import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepoRegistry } from "@mars/code-refs";
import type {
  AgentPreview,
  AgentRequest,
  GitRangeReference,
  MessageView,
} from "@mars/contracts";
import { fixture, TEAM, TOKENS } from "../test/fixture";
import { createAgentReferencePort } from "./agent-references";
import { TeamError } from "./errors";
import { TEAM_METRIC_COUNTERS, type TeamMetricsSnapshot } from "./metrics";
import type { ConversationViewResult } from "./protocol";
import {
  createTeamStore,
  TEAM_MIGRATIONS,
  TEAM_STORE_FORMAT_VERSION,
  type TeamStoreSnapshot,
} from "./store";

/**
 * Team Chat PR 7 (pilot rollout): kill switch, per-user rate limits with
 * `Retry-After`, redacted metrics behind the admin role, structured log
 * entries, export/import, the migration roll-forward / refuse-newer drill and
 * the agent reference port. Offline only: loopback server, dev tokens, temp
 * `git` repositories.
 */

const fixtures: ReturnType<typeof fixture>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const start = (...args: Parameters<typeof fixture>) => {
  const f = fixture(...args);
  fixtures.push(f);
  return f;
};
const dm = async (f: ReturnType<typeof fixture>) =>
  (
    await f.ok<ConversationViewResult>("alice", "conversations.create_dm", {
      peer_user_id: "bob",
    })
  ).conversation.conversation_id;

test("kill switch: default off, team.describe still answers, everything else is unavailable, open streams close, data survives re-enable", async () => {
  const f = start();
  const id = await dm(f);
  await f.ok("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "m1",
    body: "before the switch",
  });
  const stream = await f.stream("bob", [
    { conversation_id: id, after_event_seq: 0 },
  ]);
  await stream.waitFor(() =>
    stream.events.some((event) => event.kind === "message"),
  );

  // A fresh store is off until the host enables it.
  const cold = createTeamStore({
    rootDir: mkdtempSync(join(tmpdir(), "mars-team-cold-")),
  });
  dirs.push(cold.rootDir);
  expect(cold.isEnabled()).toBe(false);
  expect(cold.setEnabled(true)).toEqual({ enabled: true, changed: true });
  expect(cold.setEnabled(true)).toEqual({ enabled: true, changed: false });
  cold.close();

  expect(f.store.setEnabled(false)).toEqual({ enabled: false, changed: true });
  // The stream ended with a purposeful close before the disabling call returned.
  await stream.waitFor(() => stream.closes.length === 1);
  expect(stream.closes).toEqual([{ reason: "unavailable" }]);
  await stream.done;

  const described = await f.ok<{ enabled: boolean }>(
    "alice",
    "team.describe",
    {},
  );
  expect(described.enabled).toBe(false);
  for (const [method, params] of [
    ["conversations.list", {}],
    ["messages.history", { conversation_id: id }],
    [
      "messages.send",
      { conversation_id: id, client_message_id: "m2", body: "x" },
    ],
    ["events.poll", { cursors: [{ conversation_id: id, after_event_seq: 0 }] }],
    ["team.metrics", {}],
  ] as const) {
    const refused = await f.rpc("alice", method, params);
    expect([method, refused.status, refused.body.error?.code]).toEqual([
      method,
      503,
      "unavailable",
    ]);
    expect(refused.body.error?.message).toBe("Team service is unavailable.");
  }
  const refusedStream = await f.stream("bob", [
    { conversation_id: id, after_event_seq: 0 },
  ]);
  expect([refusedStream.status, refusedStream.error?.code]).toEqual([
    503,
    "unavailable",
  ]);
  // The worker claims nothing while the switch is off.
  expect(f.store.agentHost.claimNext()).toBeNull();

  expect(f.store.setEnabled(true)).toEqual({ enabled: true, changed: true });
  const history = await f.ok<MessageView[]>("bob", "messages.history", {
    conversation_id: id,
  });
  expect(history.map((m) => m.body)).toEqual(["before the switch"]);
  expect(f.store.metrics.snapshot().disabled_refusals).toBe(6);
});

test("per-user sliding-window limits for sends, reactions, search and agent calls answer 503 with Retry-After and are counted", async () => {
  const f = start({
    limits: {
      max_sends_per_minute: 2,
      max_reactions_per_minute: 1,
      max_search_per_minute: 1,
      max_agent_requests_per_minute: 1,
    },
  });
  const id = await dm(f);
  const first = await f.ok<MessageView>("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "m1",
    body: "one",
  });
  await f.ok("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "m2",
    body: "two",
  });
  const third = await f.raw({
    method: "messages.send",
    context: { schema_version: 1, team_id: TEAM, request_id: "r-3" },
    params: { conversation_id: id, client_message_id: "m3", body: "three" },
  });
  expect(third.status).toBe(503);
  expect((await third.json()).error).toEqual({
    code: "unavailable",
    message: "Team service is unavailable.",
  });
  const retry = Number(third.headers.get("retry-after"));
  expect(Number.isInteger(retry) && retry >= 1 && retry <= 60).toBe(true);
  // Another user's budget is separate; the limited user's edit shares the send window.
  await f.ok("bob", "messages.send", {
    conversation_id: id,
    client_message_id: "b1",
    body: "bob",
  });
  const edit = await f.rpc("alice", "messages.edit", {
    message_id: first.message_id,
    body: "one!",
  });
  expect(edit.status).toBe(503);
  await f.ok("bob", "reactions.set", {
    message_id: first.message_id,
    emoji: "👍",
    on: true,
  });
  const reaction = await f.rpc("bob", "reactions.set", {
    message_id: first.message_id,
    emoji: "🎉",
    on: true,
  });
  expect([reaction.status, reaction.body.error?.code]).toEqual([
    503,
    "unavailable",
  ]);
  await f.ok("carol", "messages.search", { query: "one" });
  const search = await f.rpc("carol", "messages.search", { query: "one" });
  expect(search.status).toBe(503);
  // agent.* without host options is `unavailable` anyway; the window is taken
  // before the host check, so the counter proves the slot was consumed.
  await f.rpc("carol", "agent.preview", {
    conversation_id: id,
    message_ids: [],
    reference_ids: [],
  });
  await f.rpc("carol", "agent.preview", {
    conversation_id: id,
    message_ids: [],
    reference_ids: [],
  });
  const snapshot = f.store.metrics.snapshot();
  expect(snapshot.rate_limit_hits).toBe(5);
  expect(snapshot.sends).toBe(3);
  expect(snapshot.rpc_errors.unavailable).toBeGreaterThanOrEqual(4);
  // Only the three stored messages exist: the refused send wrote nothing.
  expect(
    (
      await f.ok<MessageView[]>("alice", "messages.history", {
        conversation_id: id,
      })
    ).length,
  ).toBe(3);
});

test("team.metrics is admin-only, counts replays/conflicts/denials/streams, and never carries a body, path, SHA, token or user text", async () => {
  const f = start();
  const SECRET_BODY = "ultra secret body text";
  const SECRET_PATH = "/host/private/repo/src/secret.ts";
  const SECRET_SHA = "f".repeat(40);
  f.store.setTeamMember({ team_id: TEAM, user_id: "alice", role: "admin" });
  const id = await dm(f);
  const params = {
    conversation_id: id,
    client_message_id: `cm ${SECRET_PATH}`,
    body: `${SECRET_BODY} ${SECRET_SHA} ${TOKENS.alice}`,
  };
  await f.ok("alice", "messages.send", params, { request_id: "send-1" });
  await f.ok("alice", "messages.send", params, { request_id: "send-1" });
  const conflict = await f.rpc(
    "alice",
    "messages.send",
    { ...params, body: "other" },
    { request_id: "send-1" },
  );
  expect(conflict.status).toBe(409);
  // carol is a team member outside the DM: denied reads.
  expect(
    (await f.rpc("carol", "messages.history", { conversation_id: id })).status,
  ).toBe(404);
  expect((await f.rpc("stranger", "conversations.list", {})).status).toBe(403);
  const stream = await f.stream("bob", [
    { conversation_id: id, after_event_seq: 0 },
  ]);
  await stream.waitFor(() =>
    stream.events.some((event) => event.kind === "message"),
  );
  stream.abort();
  await stream.done;
  // The server's close bookkeeping runs after the socket drops.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const denied = await f.rpc("bob", "team.metrics", {});
  expect([denied.status, denied.body.error?.code]).toEqual([403, "forbidden"]);
  const metrics = await f.ok<TeamMetricsSnapshot>("alice", "team.metrics", {});
  // One committed message: the replayed send counts as a replay, not a send.
  expect(metrics.sends).toBe(1);
  expect(metrics.send_replays).toBe(1);
  expect(metrics.conflicts).toBe(1);
  expect(metrics.rpc_errors.conflict).toBe(1);
  expect(metrics.denied_reads.not_found).toBe(1);
  expect(metrics.denied_reads.forbidden).toBe(2);
  expect(metrics.stream_connects).toBe(1);
  expect(metrics.stream_disconnects).toBe(1);
  expect(metrics.backfill_pages).toBeGreaterThanOrEqual(1);
  expect(metrics).toEqual(f.store.metrics.snapshot());

  // Redaction proof: every key is a fixed counter name and every leaf an integer.
  const leaves: unknown[] = [];
  const keys: string[] = [];
  const walk = (value: unknown, path: string[]) => {
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value as object)) {
        keys.push([...path, key].join("."));
        walk(child, [...path, key]);
      }
    } else leaves.push(value);
  };
  walk(metrics, []);
  expect(leaves.every((leaf) => Number.isInteger(leaf))).toBe(true);
  const allowed = new Set<string>([
    "schema_version",
    ...TEAM_METRIC_COUNTERS,
    "denied_reads",
    "agent_requests",
    "rpc_errors",
  ]);
  expect(keys.filter((key) => !allowed.has(key))).toEqual([]);
  const text = JSON.stringify(metrics);
  for (const forbidden of [
    SECRET_BODY,
    "secret",
    SECRET_PATH,
    "/host",
    SECRET_SHA,
    TOKENS.alice,
    "alice",
    "bob",
    id,
  ])
    expect(text).not.toContain(forbidden);
  // Structured log entries: operation ids and codes only, never the client's request id or any text.
  expect(f.logs.length).toBeGreaterThan(5);
  const logText = JSON.stringify(f.logs);
  for (const forbidden of [
    "send-1",
    SECRET_BODY,
    SECRET_PATH,
    TOKENS.alice,
    "alice",
    id,
  ])
    expect(logText).not.toContain(forbidden);
  for (const entry of f.logs) {
    expect(Object.keys(entry).sort()).toEqual([
      "code",
      "id",
      "method",
      "ms",
      "op",
      "status",
    ]);
    expect(Number.isInteger(entry.id) && entry.id > 0).toBe(true);
  }
  expect(f.logs.some((e) => e.op === "stream_closed")).toBe(true);
  expect(
    f.logs.some(
      (e) =>
        e.method === "team.metrics" &&
        e.code === "forbidden" &&
        e.status === 403,
    ),
  ).toBe(true);
  // An unknown counter name is a programming error, not a label.
  expect(() => f.store.metrics.increment("bodies.seen" as "sends")).toThrow(
    TeamError,
  );
});

test("export dumps every durable row without credentials; import refuses a non-empty store or a foreign ledger and otherwise restores the data disabled", async () => {
  const f = start();
  f.store.setRepo({ team_id: TEAM, repo_id: "repo-x", label: "Repo X" });
  f.store.setRepoAccess({ team_id: TEAM, repo_id: "repo-x", user_id: "alice" });
  const id = await dm(f);
  await f.ok("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "m1",
    body: "keep me",
  });
  await f.ok("bob", "reactions.set", {
    message_id: (
      await f.ok<MessageView[]>("bob", "messages.history", {
        conversation_id: id,
      })
    )[0]?.message_id,
    emoji: "👍",
    on: true,
  });
  const snapshot = f.store.exportSnapshot();
  expect(snapshot.schema_version).toBe(1);
  expect(snapshot.format_version).toBe(TEAM_STORE_FORMAT_VERSION);
  expect(snapshot.ledger).toEqual(TEAM_MIGRATIONS.map((m) => m.id));
  expect(snapshot.enabled).toBe(true);
  expect(snapshot.tables.messages?.length).toBe(1);
  expect(snapshot.tables.members?.length).toBe(4);
  expect(snapshot.tables.reactions?.length).toBe(1);
  expect(snapshot.tables.repo_access?.length).toBe(1);
  const text = JSON.stringify(snapshot);
  for (const token of Object.values(TOKENS)) expect(text).not.toContain(token);
  expect(text).not.toContain(f.rootDir);

  // Non-empty target: refused, nothing changed.
  expect(() => f.store.importSnapshot(snapshot)).toThrow(/non-empty/);
  expect(f.store.exportSnapshot().tables).toEqual(snapshot.tables);

  const restoredDir = mkdtempSync(join(tmpdir(), "mars-team-restore-"));
  dirs.push(restoredDir);
  const restored = createTeamStore({ rootDir: restoredDir });
  try {
    const foreign: TeamStoreSnapshot = {
      ...snapshot,
      ledger: [...snapshot.ledger, "0099_future"],
    };
    expect(() => restored.importSnapshot(foreign)).toThrow(/ledger/);
    expect(() => restored.importSnapshot({ nope: true })).toThrow(TeamError);
    // A snapshot missing a table is not a restore.
    const { members: _omitted, ...partialTables } = snapshot.tables;
    expect(() =>
      restored.importSnapshot({ ...snapshot, tables: partialTables }),
    ).toThrow(/missing a table/);
    expect(restored.exportSnapshot().tables.conversations).toEqual([]);
    const report = restored.importSnapshot(
      JSON.parse(JSON.stringify(snapshot)),
    );
    expect(report.tables).toBe(15);
    expect(report.rows).toBeGreaterThan(8);
    // Restored data reads back through the normal authorized path; the switch stays off until the operator enables it.
    expect(restored.isEnabled()).toBe(false);
    const bob = { team_id: TEAM, user_id: "bob" };
    const history = restored.history(bob, { conversation_id: id });
    expect(history.map((m) => [m.body, m.reactions])).toEqual([
      ["keep me", [{ emoji: "👍", count: 1, reacted: true }]],
    ]);
    expect(
      restored.hasRepoAccess({ team_id: TEAM, user_id: "alice" }, "repo-x"),
    ).toBe(true);
    expect(restored.exportSnapshot().tables).toEqual(snapshot.tables);
    // A second import is refused like any non-empty store.
    expect(() => restored.importSnapshot(snapshot)).toThrow(/non-empty/);
  } finally {
    restored.close();
  }
});

test("migration drill: a store at ledger N-1 rolls forward to N keeping its data; a ledger from newer code is refused without being modified", async () => {
  const last = TEAM_MIGRATIONS[TEAM_MIGRATIONS.length - 1];
  if (!last) throw new Error("ledger is empty");
  // (a1) Fixture built by applying migrations 0..N-1 directly, with a member row written under that schema.
  const dir = mkdtempSync(join(tmpdir(), "mars-team-drill-"));
  dirs.push(dir);
  const raw = new Database(join(dir, "team.sqlite"), {
    create: true,
    strict: true,
  });
  raw.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  raw.exec(
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, position INTEGER NOT NULL UNIQUE);",
  );
  raw
    .query("INSERT INTO meta (key, value) VALUES ('format_version', ?)")
    .run(String(TEAM_STORE_FORMAT_VERSION));
  TEAM_MIGRATIONS.slice(0, -1).forEach((migration, index) => {
    raw.exec(migration.sql);
    raw
      .query(
        "INSERT INTO migrations (id, applied_at, position) VALUES (?, ?, ?)",
      )
      .run(migration.id, "2026-01-01T00:00:00.000Z", index);
  });
  raw
    .query(
      "INSERT INTO members (team_id, user_id, role, state, revision, created_at, updated_at) VALUES ('team-1', 'alice', 'admin', 'active', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    )
    .run();
  raw.close();
  const rolled = createTeamStore({ rootDir: dir });
  try {
    expect(rolled.migrationsApplied).toEqual([last.id]);
    expect(rolled.ledgerHead).toBe(last.id);
    expect(rolled.describe({ team_id: "team-1", user_id: "alice" }).role).toBe(
      "admin",
    );
    rolled.metrics.increment("sends");
    expect(rolled.metrics.snapshot().sends).toBe(1);
  } finally {
    rolled.close();
  }
  // Reopening a current store applies nothing.
  const again = createTeamStore({ rootDir: dir });
  expect(again.migrationsApplied).toEqual([]);
  again.close();

  // (a2) A populated current store taken back to N-1 (the previous binary's shape) rolls forward with its conversations intact.
  const f = start();
  const id = await dm(f);
  await f.ok("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "m1",
    body: "survives",
  });
  await f.server.stop(true);
  f.store.close();
  const downgrade = new Database(join(f.rootDir, "team.sqlite"), {
    strict: true,
  });
  downgrade.exec(
    `DROP TABLE metrics; DELETE FROM migrations WHERE id = '${last.id}';`,
  );
  downgrade.close();
  const upgraded = createTeamStore({ rootDir: f.rootDir });
  try {
    expect(upgraded.migrationsApplied).toEqual([last.id]);
    expect(
      upgraded
        .history({ team_id: TEAM, user_id: "bob" }, { conversation_id: id })
        .map((m) => m.body),
    ).toEqual(["survives"]);
  } finally {
    upgraded.close();
  }

  // (b) A ledger written by newer code is refused and left exactly as found.
  const future = new Database(join(f.rootDir, "team.sqlite"), { strict: true });
  future.exec("CREATE TABLE future_rows (x TEXT);");
  future
    .query(
      "INSERT INTO migrations (id, applied_at, position) VALUES ('0099_future', '2027-01-01T00:00:00.000Z', ?)",
    )
    .run(TEAM_MIGRATIONS.length);
  const before = future
    .query("SELECT id, position FROM migrations ORDER BY position")
    .all();
  future.close();
  expect(() => createTeamStore({ rootDir: f.rootDir })).toThrow(TeamError);
  const check = new Database(join(f.rootDir, "team.sqlite"), {
    readonly: true,
  });
  expect(
    check.query("SELECT id, position FROM migrations ORDER BY position").all(),
  ).toEqual(before);
  expect(check.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({
    n: 1,
  });
  expect(
    check
      .query("SELECT name FROM sqlite_master WHERE name = 'future_rows'")
      .all(),
  ).toEqual([{ name: "future_rows" }]);
  check.close();
});

const GIT = Bun.which("git");
test.skipIf(!GIT)(
  "agent reference port: a selection with a reference some participant cannot read is restricted (no path or SHA) and refused at request time",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "mars-team-agent-refs-"));
    dirs.push(root);
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(home);
    mkdirSync(join(repo, "src"), { recursive: true });
    const SECRET_PATH = "src/hidden-module.ts";
    writeFileSync(
      join(repo, SECRET_PATH),
      "export const hidden = 'hidden-text-marker';\nexport const two = 2;\n",
    );
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(
        [
          GIT ?? "git",
          "-c",
          "user.name=f",
          "-c",
          "user.email=f@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "init.defaultBranch=main",
          ...args,
        ],
        {
          cwd: repo,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            LC_ALL: "C",
          },
          stdin: "ignore",
        },
      );
      if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
      return result.stdout.toString().trim();
    };
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "c1");
    const sha = git("rev-parse", "HEAD");
    const registry = createRepoRegistry();
    await registry.register({
      repo_id: "repo-h",
      dir: repo,
      label: "Hidden Repo",
    });
    let f: ReturnType<typeof fixture> | undefined;
    const port = createAgentReferencePort({
      repos: registry,
      store: () => {
        if (!f) throw new Error("store not ready");
        return f.store;
      },
    });
    f = start({
      repos: registry,
      agentReferences: port,
      agent: {
        model: () => ({ model_id: "fixture/free", tier: "free" }),
        references: port,
      },
    });
    f.store.setRepo({ team_id: TEAM, repo_id: "repo-h", label: "Hidden Repo" });
    f.store.setRepoAccess({
      team_id: TEAM,
      repo_id: "repo-h",
      user_id: "alice",
    });
    const group = await f.ok<ConversationViewResult>(
      "alice",
      "conversations.create_group",
      { member_ids: ["alice", "bob"], title: "g" },
    );
    const id = group.conversation.conversation_id;
    const ref = await f.ok<GitRangeReference>("alice", "references.create", {
      repo_id: "repo-h",
      commit_sha: sha,
      path: SECRET_PATH,
      line_start: 1,
      line_end: 2,
    });
    const sent = await f.ok<MessageView>("alice", "messages.send", {
      conversation_id: id,
      client_message_id: "m1",
      body: "see this",
      reference_ids: [ref.reference_id],
    });
    const selection = {
      conversation_id: id,
      message_ids: [sent.message_id],
      reference_ids: [ref.reference_id],
    };

    // bob (no repo access) is a participant, so the reference is restricted for the whole audience.
    const previewByBob = await f.rpc("bob", "agent.preview", selection);
    expect(previewByBob.status).toBe(200);
    const preview = previewByBob.body.result as AgentPreview;
    expect(preview.restricted_reference_ids).toEqual([ref.reference_id]);
    expect(preview.participant_count).toBe(2);
    // The restricted excerpt's size and threat flag stay behind the gate too.
    for (const item of preview.items.filter((i) => i.kind === "reference"))
      expect([item.bytes, item.flagged]).toEqual([0, null]);
    const bobText = JSON.stringify(previewByBob.body);
    for (const forbidden of [
      SECRET_PATH,
      sha,
      "hidden-text-marker",
      repo,
      "Hidden Repo",
    ])
      expect(bobText).not.toContain(forbidden);
    const refused = await f.rpc("bob", "agent.request", {
      ...selection,
      idempotency_key: "k1",
      audience: "conversation",
      preview_sha256: preview.preview_sha256,
    });
    expect([refused.status, refused.body.error?.code]).toEqual([
      403,
      "forbidden",
    ]);
    // alice sees the same restriction: an answer derived from the excerpt could reach bob.
    const previewByAlice = await f.ok<AgentPreview>(
      "alice",
      "agent.preview",
      selection,
    );
    expect(previewByAlice.restricted_reference_ids).toEqual([ref.reference_id]);

    // Granting bob access makes the reference readable by every participant; the port supplied the pinned excerpt.
    f.store.setRepoAccess({ team_id: TEAM, repo_id: "repo-h", user_id: "bob" });
    const open = await f.ok<AgentPreview>("alice", "agent.preview", selection);
    expect(open.restricted_reference_ids).toEqual([]);
    const item = open.items.find((entry) => entry.kind === "reference");
    const bytes = item && item.kind === "reference" ? item.bytes : 0;
    // The resolver returns the two lines without the trailing newline.
    expect(bytes).toBeGreaterThanOrEqual(60);
    expect(bytes).toBeLessThanOrEqual(66);
    // A queued request moves the durable agent counters.
    await f.ok<AgentRequest>("alice", "agent.request", {
      idempotency_key: "k-metrics",
      ...selection,
      audience: "conversation",
      preview_sha256: open.preview_sha256,
    });
    expect(f.store.metrics.snapshot().agent_requests.pending).toBe(1);
    // Revoking again restricts the next call immediately (no cache of access, only of immutable text).
    f.store.revokeRepoAccess({
      team_id: TEAM,
      repo_id: "repo-h",
      user_id: "bob",
    });
    // Provisioning reads the row state so a restart never re-grants a revoked row.
    expect(
      f.store.repoAccessState({
        team_id: TEAM,
        repo_id: "repo-h",
        user_id: "bob",
      }),
    ).toBe("removed");
    expect(
      f.store.repoAccessState({
        team_id: TEAM,
        repo_id: "repo-h",
        user_id: "carol",
      }),
    ).toBeNull();
    expect(
      (await f.ok<AgentPreview>("alice", "agent.preview", selection))
        .restricted_reference_ids,
    ).toEqual([ref.reference_id]);
    const described = port.describe({
      team_id: TEAM,
      reference_ids: [ref.reference_id, "unknown"],
      viewers: ["alice", "bob", "carol"],
    });
    expect(described.map((d) => [d.reference_id, d.readers, d.label])).toEqual([
      [
        ref.reference_id,
        ["alice"],
        `repo-h ${SECRET_PATH}@${sha.slice(0, 12)}:1-2`,
      ],
    ]);
  },
);
