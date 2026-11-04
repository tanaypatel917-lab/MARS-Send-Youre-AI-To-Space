import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { MessageView, SharePreview, TaskLink } from "@mars/contracts";
import { fixture } from "../test/fixture";
import type { ConversationViewResult, TaskLinkDraftResult } from "./protocol";
import { canonicalJson, createTeamStore, sha256 } from "./store";

/**
 * Upgrade coverage for migration `0004_agent_requests`: a store populated by
 * the pre-0004 code (simulated by downgrading a current store to the exact
 * 0003 shape: no `kind`/`agent_request_id` columns, legacy message digests,
 * legacy idempotency results, no `agent_requests` table) is reopened and must
 * keep its result cards, replay old sends and verify old digests.
 */

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
const DIFF = "a".repeat(64);
const WORKBENCH = {
  scope: { owner_id: "alice-owner", project_id: "alice-project" },
  task_id: "wb-task-1",
  request_id: "wb-req-1",
};

interface LegacyRow {
  message_id: string;
  conversation_id: string;
  author_id: string;
  seq: number;
  client_message_id: string;
  body: string;
  body_sha256: string;
  reply_to: string | null;
  reference_ids_json: string;
  created_at: string;
  edited_at: string | null;
  deleted: number;
}

/** Rewrites a 0004 store into the exact shape the 0003 code left behind. */
function downgrade(rootDir: string) {
  const db = new Database(join(rootDir, "team.sqlite"), { strict: true });
  db.exec("PRAGMA foreign_keys=ON;");
  db.transaction(() => {
    for (const row of db
      .query<LegacyRow, []>(
        "SELECT message_id, conversation_id, author_id, seq, client_message_id, body, body_sha256, reply_to, reference_ids_json, created_at, edited_at, deleted FROM messages",
      )
      .all()) {
      const legacy = {
        message_id: row.message_id,
        conversation_id: row.conversation_id,
        author_id: row.author_id,
        seq: row.seq,
        client_message_id: row.client_message_id,
        body: row.body,
        body_sha256: row.body_sha256,
        reply_to: row.reply_to,
        reference_ids: JSON.parse(row.reference_ids_json) as string[],
        created_at: row.created_at,
        edited_at: row.edited_at,
        deleted: row.deleted === 1,
      };
      db.query(
        "UPDATE messages SET record_sha256 = ? WHERE message_id = ?",
      ).run(sha256(canonicalJson(legacy)), row.message_id);
    }
    // Pre-0004 `messages.send` results had neither field; `shares.create`
    // results already carried `kind: "result_card"` but no `agent_request_id`.
    for (const row of db
      .query<{ rowid: number; operation: string; result_json: string }, []>(
        "SELECT rowid, operation, result_json FROM idempotency WHERE operation IN ('messages.send', 'shares.create')",
      )
      .all()) {
      const {
        kind,
        agent_request_id: _agent,
        ...rest
      } = JSON.parse(row.result_json) as Record<string, unknown>;
      db.query("UPDATE idempotency SET result_json = ? WHERE rowid = ?").run(
        canonicalJson(
          row.operation === "shares.create" ? { ...rest, kind } : rest,
        ),
        row.rowid,
      );
    }
    db.exec(
      "ALTER TABLE messages DROP COLUMN agent_request_id; ALTER TABLE messages DROP COLUMN kind; DROP TABLE agent_requests; DELETE FROM migrations WHERE id = '0004_agent_requests'; DROP TABLE metrics; DELETE FROM migrations WHERE id = '0005_metrics';",
    );
  })();
  db.close();
}

test("a pre-0004 store keeps its result cards, replays old sends and verifies old digests after the upgrade", async () => {
  const f = fixture();
  fixtures.push(f);
  const dm = await f.ok<ConversationViewResult>(
    "alice",
    "conversations.create_dm",
    {
      peer_user_id: "bob",
    },
  );
  const id = dm.conversation.conversation_id;
  const sent = await f.ok<MessageView>(
    "alice",
    "messages.send",
    {
      conversation_id: id,
      client_message_id: "m1",
      body: "please fix the uploader",
    },
    { request_id: "send-1" },
  );
  const draft = await f.ok<TaskLinkDraftResult>("alice", "tasks.link_draft", {
    conversation_id: id,
    message_ids: [sent.message_id],
    reference_ids: [],
  });
  await f.ok<TaskLink>("alice", "tasks.link_confirm", {
    link_id: draft.link.link_id,
    workbench: WORKBENCH,
    target: { repo_id: "repo-1" },
  });
  await f.ok<TaskLink>("alice", "tasks.link_created", {
    link_id: draft.link.link_id,
    task_revision: 3,
  });
  const shareParams = {
    link_id: draft.link.link_id,
    evidence: {
      task_revision: 3,
      workspace: {
        workspace_id: "ws-1",
        provider: "git-worktree",
        revision: "r7",
      },
      diff_sha256: DIFF,
      verify_records: [
        {
          event_id: "evt-1",
          verdict: "pass",
          assurance: "deterministic_local",
          verified: true,
          recorded_at: "2026-01-01T00:00:00.000Z",
          workspace_id: "ws-1",
          workspace_revision: "r7",
          diff_sha256: DIFF,
          stale: false,
        },
      ],
    },
    run_status: "completed",
    selection: {
      summary: "fixed",
      include_diff_digest: false,
      verify_event_ids: ["evt-1"],
    },
  };
  const preview = await f.ok<SharePreview>(
    "alice",
    "shares.preview",
    shareParams,
  );
  const card = await f.ok<MessageView>(
    "alice",
    "shares.create",
    { ...shareParams, preview_sha256: preview.preview_sha256 },
    { request_id: "share-1" },
  );
  expect(card.kind).toBe("result_card");
  const before = await f.ok<MessageView[]>("bob", "messages.history", {
    conversation_id: id,
  });
  // Simulate the store as the 0003 code left it, then reopen with the current code.
  await f.server.stop(true);
  f.store.close();
  downgrade(f.rootDir);
  const legacy = new Database(join(f.rootDir, "team.sqlite"), {
    readonly: true,
  });
  expect(
    legacy.query("SELECT id FROM migrations ORDER BY position").all(),
  ).toEqual([
    { id: "0001_initial" },
    { id: "0002_task_links" },
    { id: "0003_references" },
  ]);
  legacy.close();
  const upgraded = createTeamStore({ rootDir: f.rootDir });
  try {
    const alice = { team_id: "team-1", user_id: "alice" };
    const bob = { team_id: "team-1", user_id: "bob" };
    const after = upgraded.history(bob, { conversation_id: id });
    expect(after.map((m) => [m.kind, m.agent_request_id])).toEqual([
      ["user", null],
      ["result_card", null],
    ]);
    expect(after[1]?.payload).toEqual(before[1]?.payload);
    expect(after[1]?.payload?.verified).toBe(true);
    // A retry of a pre-upgrade send replays the original message, now with the new fields.
    const replay = upgraded.send(alice, "send-1", {
      conversation_id: id,
      client_message_id: "m1",
      body: "please fix the uploader",
    });
    expect(replay).toEqual(after[0] as MessageView);
    expect(upgraded.history(bob, { conversation_id: id })).toHaveLength(2);
    // A retry of the pre-upgrade share replays the card with its payload.
    const cardReplay = upgraded.shareCreate(alice, "share-1", {
      ...shareParams,
      preview_sha256: preview.preview_sha256,
    } as Parameters<typeof upgraded.shareCreate>[2]);
    expect(cardReplay).toEqual(after[1] as MessageView);
    expect(upgraded.history(bob, { conversation_id: id })).toHaveLength(2);
    // Old rows can still be edited (digest is recomputed in the new shape) and new sends work.
    const edited = upgraded.editMessage(alice, {
      message_id: sent.message_id,
      body: "please fix the uploader soon",
    });
    expect(edited.kind).toBe("user");
    expect(upgraded.history(bob, { conversation_id: id })[0]?.body).toBe(
      "please fix the uploader soon",
    );
  } finally {
    upgraded.close();
  }
});
