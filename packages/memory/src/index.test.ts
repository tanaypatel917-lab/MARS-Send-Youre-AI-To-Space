import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryEntry, RequestContext } from "@mars/contracts";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import {
  createMemoryStore,
  DEFAULT_BUDGETS,
  type DurableMemoryStore,
  formatSnapshot,
} from "./index";

const roots: string[] = [];
const stores: DurableMemoryStore[] = [];
const ctx = (
  project = "p",
  workspace?: string,
  owner = "o",
): RequestContext => ({
  schema_version: 1,
  scope: {
    owner_id: owner,
    project_id: project,
    ...(workspace ? { workspace_id: workspace } : {}),
  },
  request_id: "request",
});
const c = ctx();
const journalSource = (session: string, entry: string) =>
  `journal:${JSON.stringify([session, entry])}`;
const entry = (
  entry_id: string,
  fact = entry_id,
  context = c,
  target: "profile" | "project" = "project",
): MemoryEntry => ({
  entry_id,
  scope: context.scope,
  target,
  fact,
  revision: 0,
  source_event_ids: [`event-${entry_id}`],
  observed_at: "2026-01-01T00:00:00.000Z",
  verified_at: null,
  supersedes: null,
  deleted: false,
});
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "mars-memory-"));
  roots.push(dir);
  return dir;
};
const open = (
  dir = root(),
  budgets?: { profile?: number; project?: number },
) => {
  const store = createMemoryStore({
    rootDir: dir,
    ...(budgets ? { budgets } : {}),
  });
  stores.push(store);
  return store;
};
const add = (
  s: DurableMemoryStore,
  e: MemoryEntry,
  revision = 0,
  context = c,
) => s.batch(context, revision, [{ operation: "add", entry: e }]);
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("corrections require identical target and scope and never publish hidden IDs", async () => {
  const s = open(),
    w = ctx("p", "w"),
    other = ctx("p", "other");
  await add(s, entry("hidden-predecessor", "hidden fact", w), 0, w);
  for (const [writer, replacementScope] of [
    [w, c],
    [other, other],
  ] as const) {
    await expect(
      add(
        s,
        {
          ...entry("rejected", "correction", replacementScope),
          supersedes: "hidden-predecessor",
        },
        (await s.snapshot(writer)).revision,
        writer,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  }
  expect((await s.snapshot(w)).revision).toBe(1);
  expect(await s.provenance(w, "hidden-predecessor")).toHaveLength(1);
  for (const viewer of [c, other]) {
    expect(await s.snapshot(viewer)).toEqual({ revision: 0, entries: [] });
    expect(await s.search(viewer, "correction")).toEqual([]);
    expect(
      Buffer.from(
        await s.readExport(viewer, await s.export(viewer)),
      ).toString(),
    ).not.toContain("hidden-predecessor");
    await expect(s.provenance(viewer, "rejected")).rejects.toMatchObject({
      code: "not_found",
    });
  }
  await add(
    s,
    {
      ...entry("same-workspace", "corrected", w),
      supersedes: "hidden-predecessor",
    },
    1,
    w,
  );
  expect((await s.snapshot(w)).entries.map((e) => e.entry_id)).toEqual([
    "same-workspace",
  ]);
  expect(
    (await s.provenance(w, "same-workspace")).map((e) => e.entry_id),
  ).toEqual(["hidden-predecessor", "hidden-predecessor", "same-workspace"]);
  await add(s, entry("wide-predecessor", "wide"), 0, c);
  await expect(
    add(
      s,
      {
        ...entry("overlay-correction", "narrow", w),
        supersedes: "wide-predecessor",
      },
      3,
      w,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  await add(s, entry("profile-predecessor", "profile", c, "profile"), 3, c);
  const b = ctx("b");
  await expect(
    add(
      s,
      {
        ...entry("cross-project", "changed", b, "profile"),
        supersedes: "profile-predecessor",
      },
      4,
      b,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    add(
      s,
      {
        ...entry("cross-target", "changed"),
        supersedes: "profile-predecessor",
      },
      4,
      c,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
});

test("lineage exports and mutation reports expose only the exact recording scope", async () => {
  for (const [a, b, target] of [
    [ctx("a"), ctx("b"), "profile"],
    [c, ctx("p", "w"), "project"],
    [ctx("p", "a"), ctx("p", "b"), "project"],
  ] as const) {
    for (const erase of ["forget", "delete"] as const) {
      const s = open();
      const evidenceContext = target === "profile" ? a : c;
      await add(
        s,
        entry("shared", "shared evidence", evidenceContext, target),
        0,
        evidenceContext,
      );
      await s.recordDatasetUse(a, "private-A-manifest", ["memory:shared"]);
      await s.recordDatasetUse(b, "own-B-manifest", ["memory:shared"]);
      const exported = JSON.parse(
        Buffer.from(await s.readExport(b, await s.export(b))).toString(),
      );
      expect(exported.dataset_use).toEqual([
        { manifest_id: "own-B-manifest", source_id: "memory:shared" },
      ]);
      expect(JSON.stringify(exported)).not.toContain("private-A-manifest");
      const report = await s.batchWithReport(b, 1, [
        {
          operation: "patch",
          entry_id: "shared",
          fact: "replacement evidence",
          source_event_ids: [],
        },
      ]);
      expect(report.affected_training_manifests).toEqual(["own-B-manifest"]);
      const removed =
        erase === "forget"
          ? await s.forgetEntry(b, "shared")
          : await s.delete(b);
      expect(removed.affected_training_manifests).toEqual(["own-B-manifest"]);
    }
  }
  const s = open();
  expect(
    (await s.batchWithReport(c, 0, [])).affected_training_manifests,
  ).toEqual([]);
  await expect(
    s.recordDatasetUse(c, "untrusted", ["memory:missing"]),
  ).rejects.toMatchObject({ code: "not_found" });
});

test("fresh, persistence in both process directions and stale writes", async () => {
  const dir = root();
  let s = open(dir);
  expect(await s.snapshot(c)).toEqual({ revision: 0, entries: [] });
  await add(s, entry("parent"));
  await s.close();
  const module = join(import.meta.dir, "index.ts");
  const worker = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import {createMemoryStore} from ${JSON.stringify(module)};const s=createMemoryStore({rootDir:process.argv[1]});const c=${JSON.stringify(c)};if((await s.snapshot(c)).entries.length!==1)process.exit(2);await s.batch(c,1,[{operation:'add',entry:${JSON.stringify(entry("child"))}}]);await s.close();`,
      dir,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await worker.exited).toBe(0);
  s = open(dir);
  expect((await s.snapshot(c)).entries.map((e) => e.entry_id)).toEqual([
    "parent",
    "child",
  ]);
  await expect(add(s, entry("stale"), 1)).rejects.toMatchObject({
    code: "conflict",
    details: { current_revision: 2 },
  });
});

test("eight proposals serialize, retry without lost updates", async () => {
  const s = open();
  const proposals = Array.from({ length: 8 }, (_, i) => entry(`e${i}`));
  const results = await Promise.allSettled(proposals.map((e) => add(s, e)));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  await Promise.all(
    proposals.map(async (e, i) => {
      if (results[i]?.status === "fulfilled") return;
      for (;;) {
        const snap = await s.snapshot(c);
        try {
          await add(s, e, snap.revision);
          return;
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "conflict"
            )
          )
            throw error;
        }
      }
    }),
  );
  expect((await s.snapshot(c)).entries).toHaveLength(8);
});

test("cross-process concurrent writers share a global sequence", async () => {
  const dir = root();
  const s = open(dir);
  const module = join(import.meta.dir, "index.ts");
  const workers = Array.from({ length: 4 }, (_, i) =>
    Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import {createMemoryStore} from ${JSON.stringify(module)};const s=createMemoryStore({rootDir:process.argv[1]});const c=${JSON.stringify(c)};for(;;){let v=await s.snapshot(c);try{await s.batch(c,v.revision,[{operation:'add',entry:${JSON.stringify(entry(`process${i}`))}}]);break;}catch(e){if(e.code!=='conflict')throw e;}}await s.close();`,
        dir,
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
  );
  expect(await Promise.all(workers.map((w) => w.exited))).toEqual([0, 0, 0, 0]);
  expect((await s.snapshot(c)).entries).toHaveLength(4);
  expect((await s.snapshot(c)).revision).toBe(4);
});

test("atomic overflow including FTS, final-state replacement, code points and defaults", async () => {
  expect(DEFAULT_BUDGETS).toEqual({ profile: 1375, project: 2200 });
  const s = open(undefined, { project: 5, profile: 3 });
  await add(s, entry("a", "😀😀😀😀😀"));
  await expect(add(s, entry("b", "badmarker"), 1)).rejects.toMatchObject({
    code: "budget_exceeded",
    details: {
      target: "project",
      final_chars: 17,
      limit: 5,
      over_by: 12,
      workspace_scoped: false,
    },
  });
  expect(await s.search(c, "badmarker")).toEqual([]);
  expect((await s.snapshot(c)).revision).toBe(1);
  await s.batch(c, 1, [
    { operation: "add", entry: entry("b", "abcde") },
    { operation: "remove", entry_id: "a" },
  ]);
  expect((await s.snapshot(c)).entries.map((e) => e.fact)).toEqual(["abcde"]);
  expect(formatSnapshot(await s.snapshot(c), { project: 5 })).toContain(
    "<project 5/5>",
  );
  const defaults = open();
  await add(defaults, entry("profile", "x".repeat(1375), c, "profile"));
  await expect(
    add(defaults, entry("extra", "z", c, "profile"), 1),
  ).rejects.toMatchObject({ code: "budget_exceeded" });
  await add(defaults, entry("project", "x".repeat(2200)), 1);
  await expect(
    add(defaults, entry("extra-project", "z"), 2),
  ).rejects.toMatchObject({ code: "budget_exceeded" });
});

test("workspace overlay budgets include overlays other than writer", async () => {
  const s = open(undefined, { project: 10 });
  await add(s, entry("overlay", "12345", ctx("p", "w")), 0, ctx("p", "w"));
  for (const writer of [c, ctx("p", "other")]) {
    try {
      await add(s, entry("wide", "12345"), 0, writer);
      throw new Error("Unexpected successful batch");
    } catch (error) {
      expect(error).toMatchObject({ code: "budget_exceeded" });
      expect((error as { details: unknown }).details).toEqual({
        target: "project",
        workspace_scoped: true,
        foreign_workspace: true,
        limit: 10,
      });
    }
  }
  await expect(
    add(s, entry("wide", "12345"), 1, ctx("p", "w")),
  ).rejects.toMatchObject({
    code: "budget_exceeded",
    details: {
      target: "project",
      workspace_scoped: true,
      final_chars: 13,
      limit: 10,
      over_by: 3,
    },
  });
  expect((await s.snapshot(c)).entries).toEqual([]);
});

test("read APIs do not acquire the SQLite cross-process writer lock", async () => {
  const dir = root(),
    s = open(dir);
  await add(s, entry("readable", "searchable"));
  await s.indexJournal(c, journal("read-session", "historykeyword"));
  const ref = await s.export(c);
  const writer = new Database(join(dir, "memory.sqlite"));
  writer.exec("BEGIN IMMEDIATE");
  try {
    expect((await s.snapshot(c)).entries).toHaveLength(1);
    expect((await s.snapshotAt(c, 1)).entries).toHaveLength(1);
    expect(await s.search(c, "searchable")).toHaveLength(1);
    expect(await s.provenance(c, "readable")).toHaveLength(1);
    expect(await s.searchHistory(c, "historykeyword")).toHaveLength(1);
    expect(await s.datasetCandidates(c)).toHaveLength(2);
    expect((await s.readExport(c, ref)).byteLength).toBe(ref.byte_length);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
});

test("scope isolation across read/write/export/delete and profile provenance", async () => {
  const s = open();
  const a = ctx("p", "a"),
    b = ctx("p", "b");
  await add(s, entry("wide", "common"));
  await add(s, entry("a", "alpha", a), 1, a);
  await add(s, entry("b", "bravo", b), 1, b);
  await add(s, entry("profile", "universal", c, "profile"), 1);
  expect((await s.snapshot(a)).entries.map((e) => e.entry_id)).toEqual([
    "wide",
    "a",
    "profile",
  ]);
  expect(
    (await s.snapshot(ctx("else"))).entries.map((e) => e.entry_id),
  ).toEqual(["profile"]);
  expect((await s.snapshot(ctx("p", undefined, "other"))).entries).toEqual([]);
  for (const denied of [b, ctx("else"), ctx("p", undefined, "other")]) {
    expect(await s.search(denied, "alpha")).toEqual([]);
    await expect(s.provenance(denied, "a")).rejects.toMatchObject({
      code: "not_found",
    });
    for (const operation of [
      {
        operation: "patch" as const,
        entry_id: "a",
        fact: "changed",
        source_event_ids: [],
      },
      { operation: "remove" as const, entry_id: "a" },
    ])
      await expect(
        s.batch(denied, (await s.snapshot(denied)).revision, [operation]),
      ).rejects.toMatchObject({ code: "not_found" });
    const ref = await s.export(denied);
    expect(
      Buffer.from(await s.readExport(denied, ref)).toString(),
    ).not.toContain("alpha");
  }
  await expect(add(s, entry("wrong", "x", b), 4, a)).rejects.toMatchObject({
    code: "scope_denied",
  });
  await expect(
    add(s, entry("bad-profile", "x", a, "profile"), 4, a),
  ).rejects.toMatchObject({ code: "scope_denied" });
  await s.delete(b);
  expect((await s.snapshot(a)).entries.map((e) => e.entry_id)).toEqual(["a"]);
});

test("correction chain, soft deletion, frozen snapshot, irrelevant recall", async () => {
  const s = open();
  await add(s, entry("old", "oldfact"));
  await add(s, { ...entry("new", "newfact"), supersedes: "old" }, 1);
  expect(await s.search(c, "oldfact")).toEqual([]);
  expect(
    (await s.provenance(c, "new")).map((e) => [
      e.entry_id,
      e.revision,
      e.deleted,
    ]),
  ).toEqual([
    ["old", 1, false],
    ["old", 2, true],
    ["new", 1, false],
  ]);
  expect((await s.snapshotAt(c, 1)).entries.map((e) => e.fact)).toEqual([
    "oldfact",
  ]);
  await s.batch(c, 2, [
    {
      operation: "patch",
      entry_id: "new",
      fact: "replacement",
      source_event_ids: ["changed"],
    },
  ]);
  await s.batch(c, 3, [{ operation: "remove", entry_id: "new" }]);
  expect((await s.snapshot(c)).entries).toEqual([]);
  expect(await s.search(c, "replacement")).toEqual([]);
  expect(await s.datasetCandidates(c)).toEqual([]);
  expect((await s.provenance(c, "new")).at(-1)?.deleted).toBe(true);
  expect(await s.search(c, "irrelevant")).toEqual([]);
  expect(await s.search(c, "the and")).toEqual([]);
});

test("invalid facts, contexts and failed multi-op batches fail closed", async () => {
  const s = open();
  for (const text of [
    " ",
    "x\u200by",
    "x\u202ey",
    "x\u2064y",
    "x\ufeffy",
    "x\u0000y",
    "x\n§\ny",
  ])
    await expect(add(s, entry("bad", text))).rejects.toMatchObject({
      code: "invalid_input",
    });
  await expect(
    s.snapshot({ ...c, schema_version: 2 } as unknown as RequestContext),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    s.snapshot({ ...c, scope: { ...c.scope, extra: true } } as RequestContext),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    s.batch(c, 0, [
      { operation: "add", entry: entry("ok") },
      { operation: "remove", entry_id: "missing" },
    ]),
  ).rejects.toMatchObject({ code: "not_found" });
  expect((await s.snapshot(c)).revision).toBe(0);
  expect(await s.search(c, "ok")).toEqual([]);
  await add(s, entry("ok", " line\n\ttext "));
  expect((await s.snapshot(c)).entries[0]?.fact).toBe("line\n\ttext");
});

const journal = (session_id = "session", text = "journalmarker") => ({
  session_id,
  entries: [
    {
      type: "session",
      version: 3,
      id: session_id,
      cwd: "HEADER_SECRET_PATH",
      additionalDirectories: ["ANOTHER_SECRET"],
    },
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: text },
    },
  ],
});

test("journal source identities and exclusions distinguish delimiters exactly", async () => {
  for (const [firstSession, firstEntry, secondSession, secondEntry] of [
    ["S", "m1", "S:child", "m1"],
    ["A", "B:C", "A:B", "C"],
    ['雪:"', 'E:["', "雪:", '"E:["'],
  ] as const) {
    for (const entryOnly of [false, true]) {
      const s = open();
      const input = (session: string, id: string) => {
        const j = journal(session);
        return {
          ...j,
          entries: j.entries.map((record) =>
            record.type === "message" ? { ...record, id } : record,
          ),
        };
      };
      const first = input(firstSession, firstEntry),
        second = input(secondSession, secondEntry);
      await s.indexJournal(c, first);
      await s.indexJournal(c, second);
      const sources = (await s.datasetCandidates(c)).map(
        (candidate) => candidate.source_id,
      );
      expect(new Set(sources).size).toBe(2);
      await s.recordDatasetUse(c, "first-model", [
        journalSource(firstSession, firstEntry),
      ]);
      await s.recordDatasetUse(c, "second-model", [
        journalSource(secondSession, secondEntry),
      ]);
      await s.dropHistory(c, firstSession);
      expect(
        (
          await s.excludeJournal(
            c,
            firstSession,
            entryOnly ? [firstEntry] : undefined,
          )
        ).affected_training_manifests,
      ).toEqual(["first-model"]);
      await s.indexJournal(c, first);
      await s.indexJournal(c, second);
      expect(
        (await s.datasetCandidates(c)).map((candidate) => candidate.source_id),
      ).toEqual([journalSource(secondSession, secondEntry)]);
      expect((await s.delete(c)).affected_training_manifests).toEqual([
        "second-model",
      ]);
      expect((await s.delete(c)).affected_training_manifests).toEqual([]);
    }
  }
  const s = open(),
    duplicate = journal("duplicate");
  await expect(
    s.indexJournal(c, {
      ...duplicate,
      entries: [...duplicate.entries, duplicate.entries[1]],
    }),
  ).rejects.toMatchObject({ code: "journal_incompatible" });
  expect(await s.datasetCandidates(c)).toEqual([]);
  await s.indexJournal(ctx("other"), duplicate);
});

test("format 1 stores fail closed without changing their version or data", async () => {
  const dir = root(),
    db = new Database(join(dir, "memory.sqlite"));
  db.exec(
    "CREATE TABLE legacy(marker TEXT); INSERT INTO legacy VALUES ('retained'); PRAGMA user_version=1",
  );
  db.close();
  expect(() => open(dir)).toThrow(
    expect.objectContaining({ code: "unknown_format" }),
  );
  const retained = new Database(join(dir, "memory.sqlite"));
  try {
    expect(retained.query("PRAGMA user_version").get()).toEqual({
      user_version: 1,
    });
    expect(retained.query("SELECT marker FROM legacy").get()).toEqual({
      marker: "retained",
    });
  } finally {
    retained.close();
  }
});

test("erasure reports dropped and replaced journal lineage and cleans only its recording scope", async () => {
  for (const replacement of [false, true]) {
    for (const operation of ["delete", "session", "message"] as const) {
      const dir = root(),
        s = open(dir),
        other = ctx("other");
      await s.indexJournal(c, journal("retired"));
      await s.recordDatasetUse(c, "training-1", [
        journalSource("retired", "m1"),
      ]);
      await s.indexJournal(other, journal("other-session"));
      await s.recordDatasetUse(other, "training-other", [
        journalSource("other-session", "m1"),
      ]);
      if (replacement) {
        const input = journal("retired");
        input.entries = input.entries.slice(0, 1);
        await s.indexJournal(c, input);
      } else await s.dropHistory(c, "retired");
      expect(await s.searchHistory(c, "journalmarker")).toEqual([]);
      const result =
        operation === "delete"
          ? await s.delete(c)
          : await s.excludeJournal(
              c,
              "retired",
              operation === "message" ? ["m1"] : undefined,
            );
      expect(result.affected_training_manifests).toEqual(["training-1"]);
      const db = new Database(join(dir, "memory.sqlite"));
      try {
        expect(
          db
            .query("SELECT manifest_id FROM dataset_use ORDER BY manifest_id")
            .all(),
        ).toEqual([{ manifest_id: "training-other" }]);
      } finally {
        db.close();
      }
      expect(
        (await s.excludeJournal(other, "other-session"))
          .affected_training_manifests,
      ).toEqual(["training-other"]);
      if (operation !== "delete")
        expect(
          (await s.excludeJournal(c, "retired")).affected_training_manifests,
        ).toEqual([]);
    }
  }
});

test("profile hard erasure cleans only the caller's recorded lineage", async () => {
  for (const operation of ["forget", "delete"] as const) {
    const dir = root(),
      s = open(dir),
      a = ctx("a"),
      b = ctx("b");
    await add(s, entry("shared", "shared fact", a, "profile"), 0, a);
    await s.recordDatasetUse(a, "training-a", ["memory:shared"]);
    await s.recordDatasetUse(b, "training-b", ["memory:shared"]);
    const result =
      operation === "forget"
        ? await s.forgetEntry(b, "shared")
        : await s.delete(b);
    expect(result.affected_training_manifests).toEqual(["training-b"]);
    const db = new Database(join(dir, "memory.sqlite"));
    try {
      expect(db.query("SELECT manifest_id FROM dataset_use").all()).toEqual([
        { manifest_id: "training-a" },
      ]);
    } finally {
      db.close();
    }
  }
});

test("orphaned profile and project-wide lineage remains erasable by its recording scope", async () => {
  for (const [a, b, target] of [
    [ctx("a"), ctx("b"), "profile"],
    [ctx("p", "w1"), ctx("p", "w2"), "project"],
  ] as const) {
    for (const operation of ["delete", "forget"] as const) {
      const dir = root(),
        s = open(dir),
        writer = target === "profile" ? a : c;
      await add(s, entry("shared", "shared", writer, target), 0, writer);
      await s.recordDatasetUse(a, "model-A", ["memory:shared"]);
      await s.recordDatasetUse(b, "model-B", ["memory:shared"]);
      expect((await s.delete(b)).affected_training_manifests).toEqual([
        "model-B",
      ]);
      expect((await s.snapshot(a)).entries).toEqual([]);
      const result =
        operation === "delete"
          ? await s.delete(a)
          : await s.forgetEntry(a, "shared");
      expect(result.affected_training_manifests).toEqual(["model-A"]);
      const db = new Database(join(dir, "memory.sqlite"));
      try {
        expect(db.query("SELECT * FROM dataset_use").all()).toEqual([]);
      } finally {
        db.close();
      }
      await expect(s.forgetEntry(a, "shared")).rejects.toMatchObject({
        code: "not_found",
      });
    }
  }
});

test("hard forget and delete scrub sqlite/WAL, invalidate exports and suppress reindex", async () => {
  const dir = root(),
    s = open(dir);
  const marker = "ERASE_SECRET_MARKER_019823";
  await add(s, entry("secret", marker));
  await s.indexJournal(c, journal("session", marker));
  await expect(
    s.indexJournal(ctx("different"), journal("session", marker)),
  ).rejects.toMatchObject({ code: "scope_denied" });
  await s.recordDatasetUse(c, "training-manifest", [
    "memory:secret",
    journalSource("session", "m1"),
  ]);
  const ref = await s.export(c);
  expect(Buffer.from(await s.readExport(c, ref)).toString()).toContain(marker);
  await expect(s.readExport(ctx("other"), ref)).rejects.toMatchObject({
    code: "not_found",
  });
  const forgotten = await s.forgetEntry(c, "secret");
  expect(forgotten.affected_training_manifests).toEqual(["training-manifest"]);
  expect(forgotten.disclosure).toContain("already-trained model weights");
  await expect(s.readExport(c, ref)).rejects.toMatchObject({
    code: "not_found",
  });
  const deleted = await s.delete(c);
  expect(deleted.affected_training_manifests).toEqual(["training-manifest"]);
  await s.indexJournal(c, journal("session", marker));
  expect(await s.searchHistory(c, marker)).toEqual([]);
  expect(await s.search(c, marker)).toEqual([]);
  expect(await s.datasetCandidates(c)).toEqual([]);
  for (const suffix of ["", "-wal"])
    if (existsSync(join(dir, `memory.sqlite${suffix}`)))
      expect(
        readFileSync(join(dir, `memory.sqlite${suffix}`)).includes(
          Buffer.from(marker),
        ),
      ).toBe(false);
  const exported = JSON.parse(
    Buffer.from(await s.readExport(c, await s.export(c))).toString(),
  );
  expect(exported.entries).toEqual([]);
  expect(exported.sessions).toEqual([]);
});

test("journal compatibility, scope, redaction, exclusions and rebuildable drop", async () => {
  const dir = root(),
    s = createMemoryStore({
      rootDir: dir,
      hostPrivateRoots: ["/host/private"],
    });
  stores.push(s);
  await expect(
    s.indexJournal(c, {
      session_id: "bad",
      entries: [{ type: "session", version: 2, id: "bad" }],
    }),
  ).rejects.toMatchObject({ code: "journal_incompatible" });
  await expect(
    s.indexJournal(c, {
      session_id: "bad",
      entries: [...journal("bad").entries, { type: "message" }],
    }),
  ).rejects.toMatchObject({ code: "journal_incompatible" });
  const input = journal("session", "keyword /host/private/file");
  await s.indexJournal(c, input);
  await s.indexJournal(c, input);
  expect((await s.searchHistory(c, "keyword"))[0]?.text).toBe(
    "keyword <private-path>/file",
  );
  expect(await s.searchHistory(c, "irrelevant")).toEqual([]);
  expect(await s.searchHistory(c, "the and")).toEqual([]);
  expect(await s.datasetCandidates(c)).toHaveLength(1);
  for (const other of [ctx("p", "w", "other"), ctx("other")]) {
    expect(await s.searchHistory(other, "keyword")).toEqual([]);
    await expect(s.indexJournal(other, input)).rejects.toMatchObject({
      code: "scope_denied",
    });
    await s.delete(other);
    expect(await s.searchHistory(c, "keyword")).toHaveLength(1);
  }
  await s.recordDatasetUse(c, "manifest", [journalSource("session", "m1")]);
  expect(
    (await s.excludeJournal(c, "session", ["m1"])).affected_training_manifests,
  ).toEqual(["manifest"]);
  await s.indexJournal(c, input);
  expect(await s.searchHistory(c, "keyword")).toEqual([]);
  await s.indexJournal(c, journal("rebuild", "rebuildable"));
  await s.dropHistory(c, "rebuild");
  expect(await s.searchHistory(c, "rebuildable")).toEqual([]);
  await s.indexJournal(c, journal("rebuild", "rebuildable"));
  expect(await s.searchHistory(c, "rebuildable")).toHaveLength(1);
  await s.close();
  const bytes = readFileSync(join(dir, "memory.sqlite")).toString();
  expect(bytes).not.toContain("HEADER_SECRET_PATH");
  expect(bytes).not.toContain("ANOTHER_SECRET");
  expect(bytes).not.toContain("/host/private");
});

test("real pinned Oh My Pi journal preserves source IDs and surrounding chain", async () => {
  const dir = root(),
    writer = SessionManager.create(dir, join(dir, "sessions"));
  const first = writer.appendMessage({
    role: "user",
    content: "first context",
    timestamp: 1,
  });
  const second = writer.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "exact recall needle" }],
    api: "fixture",
    provider: "fixture",
    model: "stub",
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 2,
  });
  const third = writer.appendMessage({
    role: "user",
    content: "following context",
    timestamp: 3,
  });
  await writer.ensureOnDisk();
  const file = writer.getSessionFile();
  if (!file) throw new Error("missing fixture");
  await writer.close();
  const reader = await SessionManager.open(file);
  try {
    const header = reader.getHeader();
    if (!header) throw new Error("missing header");
    const s = open();
    await s.indexJournal(c, {
      session_id: header.id,
      entries: [header, ...reader.getEntries()],
    });
    const hits = await s.searchHistory(c, "recall needle", {
      before: 2,
      after: 2,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      source: { session_id: header.id, entry_id: second },
      text: "exact recall needle",
    });
    expect(hits[0]?.surrounding.before.map((m) => m.entry_id)).toEqual([first]);
    expect(hits[0]?.surrounding.after.map((m) => m.entry_id)).toEqual([third]);
  } finally {
    await reader.close();
  }
});

test("corrupt hashes and unknown format fail closed", async () => {
  const dir = root(),
    s = open(dir);
  await add(s, entry("hash"));
  await s.close();
  let db = new Database(join(dir, "memory.sqlite"));
  db.query("UPDATE entry_revisions SET row_hash='bad'").run();
  db.close();
  const reopened = open(dir);
  await expect(reopened.snapshot(c)).rejects.toMatchObject({
    code: "corrupt_record",
  });
  await reopened.close();
  db = new Database(join(dir, "memory.sqlite"));
  db.exec("PRAGMA user_version=999");
  db.close();
  expect(() => open(dir)).toThrow(
    expect.objectContaining({ code: "unknown_format" }),
  );
});

test("soft removal reports affected manifests and alias IDs cannot leak other scopes", async () => {
  const s = open();
  const other = ctx("else", undefined, "other");
  await add(s, { ...entry("mine"), source_event_ids: ["shared-event"] });
  await add(
    s,
    { ...entry("theirs", "secret", other), source_event_ids: ["shared-event"] },
    0,
    other,
  );
  await s.recordDatasetUse(c, "mine-manifest", ["shared-event"]);
  await s.recordDatasetUse(other, "private-manifest", ["shared-event"]);
  const result = await s.batchWithReport(c, 1, [
    { operation: "remove", entry_id: "mine" },
  ]);
  expect(result.affected_training_manifests).toEqual(["mine-manifest"]);
  expect(result.revision).toBe(3);
  expect((await s.provenance(c, "mine")).at(-1)?.deleted).toBe(true);
});

test("forgetEntry alone erases history and FTS text bytes", async () => {
  const dir = root(),
    s = open(dir);
  const marker = "FORGET_ONLY_SECRET_985720";
  await add(s, entry("forgotten", marker));
  await s.batch(c, 1, [
    {
      operation: "patch",
      entry_id: "forgotten",
      fact: `${marker} next`,
      source_event_ids: [],
    },
  ]);
  await s.forgetEntry(c, "forgotten");
  expect(await s.search(c, "FORGET_ONLY_SECRET_985720")).toEqual([]);
  await expect(s.provenance(c, "forgotten")).rejects.toMatchObject({
    code: "not_found",
  });
  for (const suffix of ["", "-wal"])
    if (existsSync(join(dir, `memory.sqlite${suffix}`)))
      expect(
        readFileSync(join(dir, `memory.sqlite${suffix}`)).includes(
          Buffer.from(marker),
        ),
      ).toBe(false);
});

test("journal evidence is exact-scope only, never owner/profile memory", async () => {
  const s = open(),
    w = ctx("p", "w");
  await s.indexJournal(w, journal("workspace-session", "isolatedkeyword"));
  await s.indexJournal(c, journal("wide-session", "widekeyword"));
  for (const denied of [
    c,
    ctx("p", "other"),
    ctx("other", "w"),
    ctx("p", "w", "other"),
  ]) {
    expect(await s.searchHistory(denied, "isolatedkeyword")).toEqual([]);
    expect(
      (await s.datasetCandidates(denied)).map((e) => e.text),
    ).not.toContain("isolatedkeyword");
    expect(
      Buffer.from(
        await s.readExport(denied, await s.export(denied)),
      ).toString(),
    ).not.toContain("isolatedkeyword");
  }
  expect(await s.searchHistory(w, "widekeyword")).toEqual([]);
  expect(await s.search(w, "isolatedkeyword")).toEqual([]);
  await s.delete(c);
  expect(await s.searchHistory(w, "isolatedkeyword")).toHaveLength(1);
  await s.delete(w);
  await expect(
    s.indexJournal(
      ctx("p", "other"),
      journal("workspace-session", "isolatedkeyword"),
    ),
  ).rejects.toMatchObject({ code: "scope_denied" });
});

test("project-only soft and hard erasure leave the owner profile intact", async () => {
  const s = open(),
    w = ctx("p", "w");
  await add(s, entry("profile", "owner-profile", c, "profile"));
  await add(s, entry("wide", "project-evidence"), 1);
  await add(s, entry("overlay", "overlay-evidence", w), 2, w);
  const snapshot = await s.snapshot(w);
  await s.batch(
    w,
    snapshot.revision,
    snapshot.entries
      .filter((e) => e.target === "project")
      .map((e) => ({ operation: "remove" as const, entry_id: e.entry_id })),
  );
  expect((await s.snapshot(w)).entries.map((e) => e.fact)).toEqual([
    "owner-profile",
  ]);
  expect((await s.provenance(w, "wide")).at(-1)?.deleted).toBe(true);
  await s.forgetEntry(w, "wide");
  await s.forgetEntry(w, "overlay");
  expect((await s.snapshot(w)).entries.map((e) => e.fact)).toEqual([
    "owner-profile",
  ]);
  expect((await s.snapshot(ctx("other"))).entries.map((e) => e.fact)).toEqual([
    "owner-profile",
  ]);
  const exported = Buffer.from(
    await s.readExport(w, await s.export(w)),
  ).toString();
  expect(exported).not.toContain("project-evidence");
  expect(exported).not.toContain("overlay-evidence");
  await expect(s.provenance(w, "wide")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("private facts reject without echoes, erased journal text absent from bytes and exports", async () => {
  const dir = root(),
    privateRoot = "/host/PRIVATE_ROOT_182738",
    marker = "EXCLUDED_MARKER_019282";
  const s = createMemoryStore({
    rootDir: dir,
    hostPrivateRoots: [privateRoot],
  });
  stores.push(s);
  for (const secret of [privateRoot, dir]) {
    try {
      await add(s, entry("bad", `fact ${secret}/file`));
      throw new Error("unexpected success");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
      expect((error as Error).message).not.toContain(secret);
    }
  }
  await add(s, entry("safe", "safe fact"));
  await expect(
    s.batch(c, 1, [
      {
        operation: "patch",
        entry_id: "safe",
        fact: `${privateRoot}/file`,
        source_event_ids: [],
      },
    ]),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await s.indexJournal(
    c,
    journal("private-session", `${marker} ${privateRoot}/file ${dir}/other`),
  );
  expect((await s.searchHistory(c, marker))[0]?.text).toBe(
    `${marker} <private-path>/file <private-path>/other`,
  );
  await s.excludeJournal(c, "private-session");
  const data = Buffer.from(await s.readExport(c, await s.export(c))).toString();
  for (const secret of [marker, privateRoot, dir])
    expect(data).not.toContain(secret);
  expect(await s.datasetCandidates(c)).toHaveLength(1);
  for (const suffix of ["", "-wal"])
    if (existsSync(join(dir, `memory.sqlite${suffix}`)))
      for (const secret of [marker, privateRoot, dir])
        expect(
          readFileSync(join(dir, `memory.sqlite${suffix}`)).includes(
            Buffer.from(secret),
          ),
        ).toBe(false);
});
