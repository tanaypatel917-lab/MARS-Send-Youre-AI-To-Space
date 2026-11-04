import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamError } from "./errors";
import {
  createTeamStore,
  dmKey,
  TEAM_MIGRATIONS,
  TEAM_STORE_FORMAT_VERSION,
  type TeamStore,
} from "./store";

const roots: string[] = [];
const stores: TeamStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "mars-team-store-"));
  roots.push(dir);
  return dir;
}
function open(
  rootDir: string,
  limits?: Parameters<typeof createTeamStore>[0]["limits"],
) {
  const store = createTeamStore(limits ? { rootDir, limits } : { rootDir });
  stores.push(store);
  return store;
}
const alice = { team_id: "t", user_id: "alice" };
const bob = { team_id: "t", user_id: "bob" };

test("the store is private, records its format version and applies the migration ledger exactly once", () => {
  const dir = root();
  const store = open(dir);
  expect(statSync(store.rootDir).mode & 0o077).toBe(0);
  expect(lstatSync(join(store.rootDir, "team.sqlite")).mode & 0o077).toBe(0);
  const db = new Database(join(store.rootDir, "team.sqlite"), {
    readonly: true,
  });
  expect(
    db.query("SELECT value FROM meta WHERE key = 'format_version'").get(),
  ).toEqual({ value: String(TEAM_STORE_FORMAT_VERSION) });
  expect(
    db
      .query<{ id: string; position: number }, []>(
        "SELECT id, position FROM migrations ORDER BY position",
      )
      .all(),
  ).toEqual(TEAM_MIGRATIONS.map((m, position) => ({ id: m.id, position })));
  db.close();
  // Reopening applies nothing new and keeps the ledger.
  const again = open(dir);
  expect(
    again.setTeamMember({ team_id: "t", user_id: "alice", role: "admin" }).role,
  ).toBe("admin");
});

test("a ledger written by newer or diverged code is rejected instead of migrated", () => {
  const dir = root();
  const store = open(dir);
  store.close();
  stores.splice(0);
  const db = new Database(join(dir, "team.sqlite"));
  db.query(
    "INSERT INTO migrations (id, applied_at, position) VALUES ('9999_future', '2026-01-01T00:00:00.000Z', ?)",
  ).run(TEAM_MIGRATIONS.length);
  db.close();
  expect(() => createTeamStore({ rootDir: dir })).toThrow(TeamError);
  const db2 = new Database(join(dir, "team.sqlite"));
  db2.query("DELETE FROM migrations WHERE id = '9999_future'").run();
  db2.query("UPDATE meta SET value = '2' WHERE key = 'format_version'").run();
  db2.close();
  let code: string | undefined;
  try {
    createTeamStore({ rootDir: dir });
  } catch (error) {
    code = (error as TeamError).code;
  }
  expect(code).toBe("corrupt_record");
});

test("the partial unique index refuses a second DM for the same pair even through raw SQL", () => {
  const store = open(root());
  store.setTeamMember({ team_id: "t", user_id: "alice", role: "member" });
  store.setTeamMember({ team_id: "t", user_id: "bob", role: "member" });
  const view = store.createDm(alice, "r1", { peer_user_id: "bob" });
  const db = new Database(join(store.rootDir, "team.sqlite"));
  expect(() =>
    db
      .query(
        "INSERT INTO conversations (conversation_id, team_id, kind, title, dm_key, revision, last_seq, last_event_seq, created_by, created_at, updated_at) VALUES ('dup', 't', 'dm', NULL, ?, 0, 0, 0, 'alice', 'x', 'x')",
      )
      .run(dmKey("bob", "alice")),
  ).toThrow();
  // Groups are not constrained by dm_key.
  db.query(
    "INSERT INTO conversations (conversation_id, team_id, kind, title, dm_key, revision, last_seq, last_event_seq, created_by, created_at, updated_at) VALUES ('g', 't', 'group', 't', NULL, 0, 0, 0, 'alice', 'x', 'x')",
  ).run();
  db.query(
    "INSERT INTO conversations (conversation_id, team_id, kind, title, dm_key, revision, last_seq, last_event_seq, created_by, created_at, updated_at) VALUES ('g2', 't', 'group', 't', NULL, 0, 0, 0, 'alice', 'x', 'x')",
  ).run();
  db.close();
  expect(view.conversation.dm_key).toBe(dmKey("alice", "bob"));
});

test("two processes racing the same DM creation end up with one conversation", async () => {
  const store = open(root());
  store.setTeamMember({ team_id: "t", user_id: "alice", role: "member" });
  store.setTeamMember({ team_id: "t", user_id: "bob", role: "member" });
  const script = join(import.meta.dir, "..", "test", "concurrent-dm.ts");
  const spawn = (user: string, peer: string, request: string) =>
    Bun.spawn(
      [process.execPath, script, store.rootDir, "t", user, peer, request],
      { stdout: "pipe", stderr: "pipe" },
    );
  const processes = [
    spawn("alice", "bob", "p1"),
    spawn("bob", "alice", "p2"),
    spawn("alice", "bob", "p3"),
  ];
  const local = store.createDm(bob, "local", { peer_user_id: "alice" })
    .conversation.conversation_id;
  const outputs = await Promise.all(
    processes.map(async (child) => {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      return stdout.trim();
    }),
  );
  expect(new Set([...outputs, local]).size).toBe(1);
  expect(store.list(alice)).toHaveLength(1);
});

test("idempotency rows are bounded per user and replay results verbatim", () => {
  const store = open(root(), { max_pending_idempotency_rows: 3 });
  store.setTeamMember({ team_id: "t", user_id: "alice", role: "member" });
  store.setTeamMember({ team_id: "t", user_id: "bob", role: "member" });
  const dm = store.createDm(alice, "dm", { peer_user_id: "bob" });
  const id = dm.conversation.conversation_id;
  const first = store.send(alice, "s1", {
    conversation_id: id,
    client_message_id: "c1",
    body: "a",
  });
  for (const index of [2, 3, 4, 5])
    store.send(alice, `s${index}`, {
      conversation_id: id,
      client_message_id: `c${index}`,
      body: "b",
    });
  const db = new Database(join(store.rootDir, "team.sqlite"), {
    readonly: true,
  });
  expect(
    db
      .query(
        "SELECT COUNT(*) AS count FROM idempotency WHERE user_id = 'alice'",
      )
      .get(),
  ).toEqual({ count: 3 });
  db.close();
  // The pruned request id no longer replays through idempotency, but the client key still does.
  expect(
    store.send(alice, "s1", {
      conversation_id: id,
      client_message_id: "c1",
      body: "a",
    }),
  ).toEqual(first);
  expect(() =>
    store.send(alice, "s5", {
      conversation_id: id,
      client_message_id: "c9",
      body: "b",
    }),
  ).toThrow(/reused/);
});

test("removing a team member removes them from every conversation and denies further access", () => {
  const store = open(root());
  for (const user of ["alice", "bob", "carol"])
    store.setTeamMember({ team_id: "t", user_id: user, role: "member" });
  const dm = store.createDm(alice, "dm", { peer_user_id: "carol" });
  const group = store.createGroup(bob, "g", {
    member_ids: ["carol"],
    title: "g",
  });
  const carol = { team_id: "t", user_id: "carol" };
  expect(store.list(carol)).toHaveLength(2);
  const removed = store.removeTeamMember({ team_id: "t", user_id: "carol" });
  expect(removed.state).toBe("removed");
  expect(removed.revision).toBe(1);
  expect(() => store.list(carol)).toThrow(TeamError);
  expect(() => store.describe(carol)).toThrow(/membership/);
  expect(
    store
      .open(alice, dm.conversation.conversation_id)
      .members.find((m) => m.user_id === "carol")?.state,
  ).toBe("removed");
  expect(
    store.open(bob, group.conversation.conversation_id).conversation.revision,
  ).toBe(1);
  expect(
    store
      .poll(bob, {
        cursors: [
          {
            conversation_id: group.conversation.conversation_id,
            after_event_seq: 0,
          },
        ],
      })
      .map((e) => e.kind),
  ).toEqual(["membership", "membership"]);
  expect(() =>
    store.removeTeamMember({ team_id: "t", user_id: "nobody" }),
  ).toThrow(TeamError);
  // Re-adding restores team access but not past conversations' participation.
  store.setTeamMember({ team_id: "t", user_id: "carol", role: "member" });
  expect(store.list(carol)).toEqual([]);
});

test("the store refuses relative and symlinked roots", () => {
  expect(() => createTeamStore({ rootDir: "relative/dir" })).toThrow(TeamError);
  const dir = root();
  const target = join(dir, "real");
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, join(dir, "link"));
  let code: string | undefined;
  try {
    createTeamStore({ rootDir: join(dir, "link") });
  } catch (error) {
    code = (error as TeamError).code;
  }
  expect(code).toBe("unsafe_path");
});
