import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type {
  Message,
  SharedEvidence,
  SharedEvidenceRecord,
  SharePreview,
  ShareUnverifiedReason,
  TaskLink,
  TaskLinkView,
} from "@mars/contracts";
import { SharedEvidenceSchema } from "@mars/contracts";
import { EvidenceResultSchema } from "@mars/workbench";
import { fixture } from "../test/fixture";
import type { ConversationViewResult, TaskLinkDraftResult } from "./protocol";
import { assessVerification, canonicalJson, sha256 } from "./store";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
function start(limits?: Parameters<typeof fixture>[0]) {
  const f = fixture(limits);
  fixtures.push(f);
  return f;
}

const DIFF_A = "a".repeat(64);
const DIFF_B = "b".repeat(64);
const SCOPE = {
  owner_id: "alice-owner",
  project_id: "alice-project",
  workspace_id: "alice-workspace",
};
const WORKBENCH = {
  scope: SCOPE,
  task_id: "wb-task-1",
  request_id: "wb-req-1",
};

function record(
  overrides: Partial<SharedEvidenceRecord> = {},
): SharedEvidenceRecord {
  return {
    event_id: "evt-1",
    verdict: "pass",
    assurance: "deterministic_local",
    verified: true,
    recorded_at: "2026-01-01T00:00:00.000Z",
    workspace_id: "ws-1",
    workspace_revision: "r7",
    diff_sha256: DIFF_A,
    stale: false,
    ...overrides,
  };
}

function evidence(
  records: SharedEvidenceRecord[],
  diff = DIFF_A,
): SharedEvidence {
  return {
    task_revision: 12,
    workspace: {
      workspace_id: "ws-1",
      provider: "git-worktree",
      revision: "r7",
    },
    diff_sha256: diff,
    verify_records: records,
  };
}

async function seeded(f: ReturnType<typeof fixture>) {
  const dm = await f.ok<ConversationViewResult>(
    "alice",
    "conversations.create_dm",
    { peer_user_id: "bob" },
  );
  const id = dm.conversation.conversation_id;
  const m1 = await f.ok<Message>("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "m1",
    body: "please fix the flaky retry in the uploader",
  });
  const m2 = await f.ok<Message>("bob", "messages.send", {
    conversation_id: id,
    client_message_id: "m2",
    body: `context: ${"x".repeat(400)}`,
  });
  return { id, m1, m2 };
}

async function createdLink(f: ReturnType<typeof fixture>) {
  const { id, m1, m2 } = await seeded(f);
  const draft = await f.ok<TaskLinkDraftResult>("alice", "tasks.link_draft", {
    conversation_id: id,
    message_ids: [m2.message_id, m1.message_id],
    reference_ids: [],
  });
  await f.ok<TaskLink>("alice", "tasks.link_confirm", {
    link_id: draft.link.link_id,
    workbench: WORKBENCH,
    target: { repo_id: "repo-1" },
  });
  const link = await f.ok<TaskLink>("alice", "tasks.link_created", {
    link_id: draft.link.link_id,
    task_revision: 3,
  });
  return { id, m1, m2, link };
}

test("(a) link draft -> confirm -> created; an interrupted confirm resolves to the same launch_key and never a second link", async () => {
  const f = start();
  const { id, m1, m2 } = await seeded(f);
  const draft = await f.ok<TaskLinkDraftResult>(
    "alice",
    "tasks.link_draft",
    {
      conversation_id: id,
      message_ids: [m2.message_id, m1.message_id],
      reference_ids: ["ref-1", "ref-1"],
    },
    { request_id: "draft-1" },
  );
  expect(draft.link.status).toBe("draft");
  expect(draft.link.launch_key).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  expect(draft.link.workbench).toBeNull();
  expect(draft.link.provenance).toEqual([
    { message_id: m1.message_id, seq: 1, body_sha256: m1.body_sha256 },
    { message_id: m2.message_id, seq: 2, body_sha256: m2.body_sha256 },
  ]);
  expect(draft.link.reference_ids).toEqual(["ref-1"]);
  expect(draft.excerpts.map((e) => [e.seq, e.truncated])).toEqual([
    [1, false],
    [2, true],
  ]);
  expect(draft.excerpts[1]?.excerpt.length).toBe(280);
  const replay = await f.ok<TaskLinkDraftResult>(
    "alice",
    "tasks.link_draft",
    {
      conversation_id: id,
      message_ids: [m2.message_id, m1.message_id],
      reference_ids: ["ref-1", "ref-1"],
    },
    { request_id: "draft-1" },
  );
  expect(replay).toEqual(draft);

  const confirmParams = {
    link_id: draft.link.link_id,
    workbench: WORKBENCH,
    target: { repo_id: "repo-1" },
  };
  const confirmed = await f.ok<TaskLink>(
    "alice",
    "tasks.link_confirm",
    confirmParams,
    { request_id: "confirm-1" },
  );
  expect(confirmed.status).toBe("confirmed");
  expect(confirmed.launch_key).toBe(draft.link.launch_key);
  expect(confirmed.target).toEqual({ repo_id: "repo-1", base_revision: null });
  // The response was lost: the same request id and a fresh one both land on the same link.
  const sameRequest = await f.ok<TaskLink>(
    "alice",
    "tasks.link_confirm",
    confirmParams,
    { request_id: "confirm-1" },
  );
  const freshRequest = await f.ok<TaskLink>(
    "alice",
    "tasks.link_confirm",
    confirmParams,
    { request_id: "confirm-2" },
  );
  expect(sameRequest).toEqual(confirmed);
  expect(freshRequest).toEqual(confirmed);
  const rebound = await f.rpc("alice", "tasks.link_confirm", {
    ...confirmParams,
    workbench: { ...WORKBENCH, task_id: "wb-task-other" },
  });
  expect(rebound.body.error?.code).toBe("conflict");

  const created = await f.ok<TaskLink>("alice", "tasks.link_created", {
    link_id: draft.link.link_id,
    task_revision: 3,
  });
  expect(created.status).toBe("created");
  expect(created.task_revision).toBe(3);
  expect(created.workbench).toEqual(WORKBENCH);
  const inspected = await f.ok<TaskLinkView>("alice", "tasks.link_inspect", {
    link_id: draft.link.link_id,
  });
  expect(inspected).toEqual({ view: "requester", link: created });

  const db = new Database(join(f.rootDir, "team.sqlite"), { readonly: true });
  expect(
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_links").get()
      ?.n,
  ).toBe(1);
  db.close();

  const foreign = await f.rpc("alice", "tasks.link_draft", {
    conversation_id: id,
    message_ids: ["not-a-message"],
    reference_ids: [],
  });
  expect(foreign.body.error?.code).toBe("invalid_request");
  const outsider = await f.rpc("carol", "tasks.link_draft", {
    conversation_id: id,
    message_ids: [m1.message_id],
    reference_ids: [],
  });
  expect(outsider.body.error?.code).toBe("not_found");
});

test("(b) provenance is frozen at draft time: a later edit or deletion never changes it", async () => {
  const f = start();
  const { id, m1, m2, link } = await createdLink(f);
  const before = link.provenance;
  // No edit/delete RPC exists yet; apply the future mutation directly to the store.
  const db = new Database(join(f.rootDir, "team.sqlite"));
  const rows = db
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq",
    )
    .all(id);
  const rewrite = (
    row: Record<string, unknown>,
    patch: Record<string, unknown>,
  ) => {
    const record = {
      message_id: row.message_id,
      conversation_id: row.conversation_id,
      author_id: row.author_id,
      seq: row.seq,
      client_message_id: row.client_message_id,
      body: row.body,
      body_sha256: row.body_sha256,
      reply_to: row.reply_to,
      reference_ids: JSON.parse(row.reference_ids_json as string),
      created_at: row.created_at,
      edited_at: row.edited_at,
      deleted: row.deleted === 1,
      ...patch,
    };
    db.query(
      "UPDATE messages SET body = ?, body_sha256 = ?, edited_at = ?, deleted = ?, record_sha256 = ? WHERE message_id = ?",
    ).run(
      record.body as string,
      record.body_sha256 as string,
      record.edited_at as string | null,
      record.deleted ? 1 : 0,
      sha256(canonicalJson(record)),
      record.message_id as string,
    );
  };
  const edited = "please fix the flaky retry in the downloader";
  rewrite(rows[0] as Record<string, unknown>, {
    body: edited,
    body_sha256: sha256(edited),
    edited_at: "2026-02-02T00:00:00.000Z",
  });
  rewrite(rows[1] as Record<string, unknown>, {
    body: "",
    body_sha256: sha256(""),
    deleted: true,
  });
  db.close();
  const history = await f.ok<Message[]>("alice", "messages.history", {
    conversation_id: id,
  });
  expect(history.map((m) => [m.body === edited, m.deleted])).toEqual([
    [true, false],
    [false, true],
  ]);
  const after = await f.ok<TaskLinkView>("alice", "tasks.link_inspect", {
    link_id: link.link_id,
  });
  expect(after.link.provenance).toEqual(before);
  expect(after.link.provenance[0]?.body_sha256).toBe(m1.body_sha256);
  expect(after.link.provenance[1]?.body_sha256).toBe(m2.body_sha256);
  const fresh = await f.ok<TaskLinkDraftResult>("alice", "tasks.link_draft", {
    conversation_id: id,
    message_ids: [m1.message_id],
    reference_ids: [],
  });
  expect(fresh.link.provenance[0]?.body_sha256).toBe(sha256(edited));
  expect(fresh.link.link_id).not.toBe(link.link_id);
});

test("(c) a fail, skipped/missing, inconclusive, stale or mismatched record can never produce verified: true", async () => {
  const f = start();
  const { link } = await createdLink(f);
  const preview = (records: SharedEvidenceRecord[], ids = ["evt-1"]) =>
    f.ok<SharePreview>("alice", "shares.preview", {
      link_id: link.link_id,
      evidence: evidence(records),
      run_status: "completed",
      selection: {
        summary: "retry fixed",
        include_diff_digest: true,
        verify_event_ids: ids,
      },
    });
  const cases: Array<
    [SharedEvidenceRecord[], string[], ShareUnverifiedReason]
  > = [
    [[record({ verdict: "fail", verified: false })], ["evt-1"], "failed"],
    [[record({ verdict: "error", verified: false })], ["evt-1"], "failed"],
    [[record({ verified: false })], ["evt-1"], "skipped"],
    [[record()], [], "missing"],
    [
      [record({ verdict: "inconclusive", verified: false })],
      ["evt-1"],
      "inconclusive",
    ],
    [[record({ stale: true })], ["evt-1"], "stale"],
    [[record({ diff_sha256: DIFF_B })], ["evt-1"], "stale"],
    [[record({ workspace_revision: "r6" })], ["evt-1"], "stale"],
    [
      [
        record({ event_id: "evt-1", verdict: "fail", verified: false }),
        record({ event_id: "evt-2", verified: false }),
      ],
      ["evt-2", "evt-1"],
      "failed",
    ],
  ];
  for (const [records, ids, reason] of cases) {
    const result = await preview(records, ids);
    expect([result.card.verified, result.card.verified_reason]).toEqual([
      false,
      reason,
    ]);
    expect(result.card.git_status).toBe("unknown");
    expect(result.card.export_status).toBe("not_exported");
    expect(result.card.run_status).toBe("completed");
  }
  const good = await preview([
    record({ event_id: "evt-0", verdict: "fail", verified: false }),
    record(),
  ]);
  expect([good.card.verified, good.card.verified_reason]).toEqual([true, null]);
  expect(good.card.evidence_event_id).toBe("evt-1");
  expect(good.card.attested_by).toBe("alice");
  expect(good.card.diff_sha256).toBe(DIFF_A);
  expect(good.preview_sha256).toBe(sha256(canonicalJson(good.card)));
  // The contract forbids verified: true on anything but a pass.
  const forged = await f.rpc("alice", "shares.preview", {
    link_id: link.link_id,
    evidence: evidence([record({ verdict: "fail", verified: true })]),
    run_status: "completed",
    selection: {
      summary: "",
      include_diff_digest: false,
      verify_event_ids: ["evt-1"],
    },
  });
  expect(forged.body.error?.code).toBe("invalid_request");
  const unknownEvent = await f.rpc("alice", "shares.preview", {
    link_id: link.link_id,
    evidence: evidence([record()]),
    run_status: "completed",
    selection: {
      summary: "",
      include_diff_digest: false,
      verify_event_ids: ["evt-404"],
    },
  });
  expect(unknownEvent.body.error?.code).toBe("invalid_request");
  expect(assessVerification(evidence([]), []).reason).toBe("missing");
});

test("(d) a re-share with a different diff_sha256 marks the earlier card stale in messages.history", async () => {
  const f = start();
  const { id, link } = await createdLink(f);
  const share = async (diff: string, summary: string) => {
    const params = {
      link_id: link.link_id,
      evidence: evidence([record({ diff_sha256: diff })], diff),
      run_status: "completed",
      selection: {
        summary,
        include_diff_digest: false,
        verify_event_ids: ["evt-1"],
      },
    };
    const preview = await f.ok<SharePreview>("alice", "shares.preview", params);
    return f.ok<Message>("alice", "shares.create", {
      ...params,
      preview_sha256: preview.preview_sha256,
    });
  };
  const first = await share(DIFF_A, "first candidate");
  expect(first.kind).toBe("result_card");
  expect(first.body).toBe("first candidate");
  expect(first.payload?.verified).toBe(true);
  expect(first.payload?.diff_sha256).toBeNull();
  expect(first.payload?.stale).toBe(false);
  const again = await share(DIFF_A, "same candidate, re-posted");
  const second = await share(DIFF_B, "second candidate");
  const history = await f.ok<Message[]>("bob", "messages.history", {
    conversation_id: id,
  });
  const cards = history.filter((m) => m.kind === "result_card");
  expect(cards.map((m) => m.message_id)).toEqual([
    first.message_id,
    again.message_id,
    second.message_id,
  ]);
  expect(
    cards.map((m) => [m.payload?.stale, m.payload?.superseded_by]),
  ).toEqual([
    [true, second.message_id],
    [true, second.message_id],
    [false, null],
  ]);
  // Posted content is immutable; only the overlay changed.
  const { stale: _s, superseded_by: _b, ...firstNow } = cards[0]?.payload ?? {};
  const { stale: _s2, superseded_by: _b2, ...firstThen } = first.payload ?? {};
  expect(firstNow).toEqual(firstThen);
  const after = await f.ok<TaskLinkView>("alice", "tasks.link_inspect", {
    link_id: link.link_id,
  });
  expect(after.link.status).toBe("shared");
  const events = await f.ok<Array<{ kind: string; message_id: string | null }>>(
    "bob",
    "events.poll",
    { cursors: [{ conversation_id: id, after_event_seq: 0 }] },
  );
  expect(events.slice(-3).map((e) => e.message_id)).toEqual(
    cards.map((m) => m.message_id),
  );
  expect(JSON.stringify(events)).not.toContain("candidate");
});

test("(e) a nonmember cannot inspect a link or see a card; other members never receive the requester's workbench scope", async () => {
  const f = start();
  const { id, link } = await createdLink(f);
  const params = {
    link_id: link.link_id,
    evidence: evidence([record()]),
    run_status: "completed",
    selection: {
      summary: "shipped",
      include_diff_digest: true,
      verify_event_ids: ["evt-1"],
    },
  };
  const preview = await f.ok<SharePreview>("alice", "shares.preview", params);
  await f.ok<Message>("alice", "shares.create", {
    ...params,
    preview_sha256: preview.preview_sha256,
  });
  for (const user of ["carol", "stranger"] as const) {
    const inspect = await f.rpc(user, "tasks.link_inspect", {
      link_id: link.link_id,
    });
    expect(inspect.body.error?.code).toBe(
      user === "stranger" ? "forbidden" : "not_found",
    );
    const history = await f.rpc(user, "messages.history", {
      conversation_id: id,
    });
    expect(history.body.error?.code).toBe(
      user === "stranger" ? "forbidden" : "not_found",
    );
    const share = await f.rpc(user, "shares.preview", params);
    expect(share.body.error?.code).toBe(
      user === "stranger" ? "forbidden" : "not_found",
    );
  }
  const other = await f.rpc("dave", "tasks.link_inspect", {
    link_id: link.link_id,
  });
  expect(other.body.error?.code).toBe("forbidden");

  const bobView = await f.ok<TaskLinkView>("bob", "tasks.link_inspect", {
    link_id: link.link_id,
  });
  expect(bobView.view).toBe("member");
  expect(Object.keys(bobView.link).sort()).toEqual([
    "conversation_id",
    "created_at",
    "link_id",
    "provenance",
    "reference_ids",
    "requester_id",
    "status",
    "task_revision",
    "team_id",
    "updated_at",
  ]);
  const serialized = JSON.stringify(bobView);
  for (const secret of [
    SCOPE.owner_id,
    SCOPE.workspace_id,
    SCOPE.project_id,
    WORKBENCH.task_id,
    WORKBENCH.request_id,
    link.launch_key,
    "repo-1",
  ])
    expect(serialized).not.toContain(secret);
  const bobHistory = await f.ok<Message[]>("bob", "messages.history", {
    conversation_id: id,
  });
  const card = bobHistory.find((m) => m.kind === "result_card");
  expect(card?.payload?.requester_id).toBe("alice");
  expect(card?.payload?.verified).toBe(true);
  const cardJson = JSON.stringify(card);
  for (const secret of [
    SCOPE.owner_id,
    SCOPE.project_id,
    WORKBENCH.task_id,
    link.launch_key,
  ])
    expect(cardJson).not.toContain(secret);
  for (const [method, p] of [
    [
      "tasks.link_confirm",
      { link_id: link.link_id, workbench: WORKBENCH, target: {} },
    ],
    ["tasks.link_created", { link_id: link.link_id, task_revision: 4 }],
    ["shares.preview", params],
    ["shares.create", { ...params, preview_sha256: preview.preview_sha256 }],
  ] as const) {
    const denied = await f.rpc("bob", method, p);
    expect(denied.body.error?.code).toBe("forbidden");
  }
});

test("(f) preview_sha256 mismatch -> conflict; artifact shares -> unavailable; sharing before creation -> conflict", async () => {
  const f = start();
  const { id, link } = await createdLink(f);
  const params = {
    link_id: link.link_id,
    evidence: evidence([record()]),
    run_status: "completed",
    selection: {
      summary: "shipped",
      include_diff_digest: true,
      verify_event_ids: ["evt-1"],
    },
  };
  const preview = await f.ok<SharePreview>("alice", "shares.preview", params);
  const mismatch = await f.rpc("alice", "shares.create", {
    ...params,
    selection: { ...params.selection, summary: "shipped!" },
    preview_sha256: preview.preview_sha256,
  });
  expect(mismatch.body.error?.code).toBe("conflict");
  const wrongDigest = await f.rpc("alice", "shares.create", {
    ...params,
    preview_sha256: DIFF_B,
  });
  expect(wrongDigest.body.error?.code).toBe("conflict");
  const posted = await f.ok<Message>(
    "alice",
    "shares.create",
    { ...params, preview_sha256: preview.preview_sha256 },
    { request_id: "share-1" },
  );
  const replay = await f.ok<Message>(
    "alice",
    "shares.create",
    { ...params, preview_sha256: preview.preview_sha256 },
    { request_id: "share-1" },
  );
  expect(replay).toEqual(posted);
  expect(
    (
      await f.ok<Message[]>("alice", "messages.history", {
        conversation_id: id,
      })
    ).filter((m) => m.kind === "result_card"),
  ).toHaveLength(1);
  const {
    stale: _s,
    superseded_by: _b,
    share_id: _i,
    message_id: _m,
    created_at: _c,
    preview_sha256: _p,
    ...card
  } = posted.payload ?? {};
  expect(card).toEqual(preview.card);

  const artifacts = await f.rpc("alice", "shares.preview", {
    ...params,
    selection: {
      ...params.selection,
      artifacts: [
        {
          artifact_id: "art-1",
          sha256: DIFF_A,
          media_type: "text/x-diff",
          byte_length: 1,
        },
      ],
    },
  });
  expect(artifacts.body.error).toEqual({
    code: "unavailable",
    message: "Team service is unavailable.",
  });

  const dmDraft = await f.ok<TaskLinkDraftResult>("alice", "tasks.link_draft", {
    conversation_id: id,
    message_ids: [posted.message_id],
    reference_ids: [],
  });
  const early = await f.rpc("alice", "shares.preview", {
    ...params,
    link_id: dmDraft.link.link_id,
  });
  expect(early.body.error?.code).toBe("conflict");
});

test("the shared evidence mirror accepts exactly what the workbench tasks.evidence contract produces", () => {
  const samples: unknown[] = [
    evidence([
      record(),
      record({
        event_id: "evt-2",
        verified: false,
        contract_id: "c1",
        contract_digest: "d1",
      }),
    ]),
    evidence([]),
    evidence([record({ verdict: "fail", verified: true })]),
    { ...evidence([]), extra: true },
    evidence([
      record({
        workspace_id: null,
        workspace_revision: null,
        diff_sha256: null,
      }),
    ]),
  ];
  for (const sample of samples)
    expect(SharedEvidenceSchema.safeParse(sample).success).toBe(
      EvidenceResultSchema.safeParse(sample).success,
    );
});

function shareParams(linkId: string, diff: string, summary: string) {
  return {
    link_id: linkId,
    evidence: evidence([record({ diff_sha256: diff })], diff),
    run_status: "completed",
    selection: {
      summary,
      include_diff_digest: false,
      verify_event_ids: ["evt-1"],
    },
  };
}

async function post(
  f: ReturnType<typeof fixture>,
  params: ReturnType<typeof shareParams>,
  requestId?: string,
) {
  const preview = await f.ok<SharePreview>("alice", "shares.preview", params);
  return f.ok<Message>(
    "alice",
    "shares.create",
    { ...params, preview_sha256: preview.preview_sha256 },
    requestId ? { request_id: requestId } : undefined,
  );
}

test("(g) a shared link records newer task revisions without leaving the shared state", async () => {
  const f = start();
  const { link } = await createdLink(f);
  await post(f, shareParams(link.link_id, DIFF_A, "shared at 3"));
  const advanced = await f.ok<TaskLink>("alice", "tasks.link_created", {
    link_id: link.link_id,
    task_revision: 4,
  });
  expect([advanced.status, advanced.task_revision]).toEqual(["shared", 4]);
  const same = await f.ok<TaskLink>("alice", "tasks.link_created", {
    link_id: link.link_id,
    task_revision: 4,
  });
  expect(same).toEqual(advanced);
  const backwards = await f.rpc("alice", "tasks.link_created", {
    link_id: link.link_id,
    task_revision: 3,
  });
  expect(backwards.body.error?.code).toBe("conflict");
  const view = await f.ok<TaskLinkView>("bob", "tasks.link_inspect", {
    link_id: link.link_id,
  });
  expect([view.link.status, view.link.task_revision]).toEqual(["shared", 4]);
});

test("(h) a replayed shares.create reports the same staleness as messages.history", async () => {
  const f = start();
  const { id, link } = await createdLink(f);
  const paramsA = shareParams(link.link_id, DIFF_A, "candidate A");
  const first = await post(f, paramsA, "share-A");
  const second = await post(
    f,
    shareParams(link.link_id, DIFF_B, "candidate B"),
  );
  const preview = await f.ok<SharePreview>("alice", "shares.preview", paramsA);
  const replay = await f.ok<Message>(
    "alice",
    "shares.create",
    { ...paramsA, preview_sha256: preview.preview_sha256 },
    { request_id: "share-A" },
  );
  expect(replay.message_id).toBe(first.message_id);
  expect([replay.payload?.stale, replay.payload?.superseded_by]).toEqual([
    true,
    second.message_id,
  ]);
  const history = await f.ok<Message[]>("alice", "messages.history", {
    conversation_id: id,
  });
  const cards = history.filter((m) => m.kind === "result_card");
  expect(cards).toHaveLength(2);
  // History items add the PR 3 view fields (reactions, reply excerpt).
  expect(cards[0]).toMatchObject(replay);
});

test("(i) a member who joined or rejoined after the quoted messages cannot inspect the link", async () => {
  const f = start();
  const group = await f.ok<ConversationViewResult>(
    "alice",
    "conversations.create_group",
    { member_ids: ["bob"], title: "Launch" },
  );
  const id = group.conversation.conversation_id;
  const quoted = await f.ok<Message>("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "q1",
    body: "quoted before carol joined",
  });
  const draft = await f.ok<TaskLinkDraftResult>("alice", "tasks.link_draft", {
    conversation_id: id,
    message_ids: [quoted.message_id],
    reference_ids: [],
  });
  const revision = async () =>
    (
      await f.ok<ConversationViewResult>("alice", "conversations.open", {
        conversation_id: id,
      })
    ).conversation.revision;
  await f.ok("alice", "conversations.add_member", {
    conversation_id: id,
    user_id: "carol",
    expected_revision: await revision(),
  });
  const bobBefore = await f.ok<TaskLinkView>("bob", "tasks.link_inspect", {
    link_id: draft.link.link_id,
  });
  expect(bobBefore.view).toBe("member");
  const carol = await f.rpc("carol", "tasks.link_inspect", {
    link_id: draft.link.link_id,
  });
  expect(carol.body.error?.code).toBe("not_found");
  const carolHistory = await f.ok<Message[]>("carol", "messages.history", {
    conversation_id: id,
  });
  expect(carolHistory).toEqual([]);
  await f.ok("alice", "conversations.remove_member", {
    conversation_id: id,
    user_id: "bob",
    expected_revision: await revision(),
  });
  await f.ok("alice", "conversations.add_member", {
    conversation_id: id,
    user_id: "bob",
    expected_revision: await revision(),
  });
  const bobAfter = await f.rpc("bob", "tasks.link_inspect", {
    link_id: draft.link.link_id,
  });
  expect(bobAfter.body.error?.code).toBe("not_found");
  // The requester keeps their own link regardless.
  const alice = await f.ok<TaskLinkView>("alice", "tasks.link_inspect", {
    link_id: draft.link.link_id,
  });
  expect(alice.view).toBe("requester");
});

test("(j) a card that would not fit a history page is refused instead of posted", async () => {
  const f = start({ max_page_bytes: 2500 });
  const { id, link } = await createdLink(f);
  const params = shareParams(link.link_id, DIFF_A, "s".repeat(1500));
  const preview = await f.ok<SharePreview>("alice", "shares.preview", params);
  const refused = await f.rpc("alice", "shares.create", {
    ...params,
    preview_sha256: preview.preview_sha256,
  });
  expect(refused.body.error?.code).toBe("too_large");
  const history = await f.ok<Message[]>("alice", "messages.history", {
    conversation_id: id,
  });
  expect(history.some((m) => m.kind === "result_card")).toBe(false);
  const small = await post(f, shareParams(link.link_id, DIFF_A, "ok"));
  expect(small.kind).toBe("result_card");
});
