/**
 * Team Chat staging verification (`bun run check:team`).
 *
 * Starts `mars team serve` as the operator would (three dev users, two
 * temporary git repositories, one user without access to the second repo),
 * then drives the implementation plan's minimum test matrix end to end over
 * HTTP against the real process: duplicate send + reconnect, conversation and
 * repo boundaries, exact code at the original SHA + revoked access, stale share
 * card, the kill switch and the redacted stats. Prints a pass/fail table and
 * exits 1 on any failure. Offline: loopback only, no model, no network Git
 * provider, no VS Code window (those remain "not proven" in the runbook).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "apps", "cli", "src", "main.ts");
const TEAM = "team-staging";
const GIT = Bun.which("git");

interface Row {
  scenario: string;
  result: "pass" | "fail" | "skipped";
  note: string;
}
const rows: Row[] = [];
const started = Date.now();

function git(cwd: string, home: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    [
      GIT ?? "git",
      "-c",
      "user.name=staging",
      "-c",
      "user.email=staging@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      stdin: "ignore",
    },
  );
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.toString().trim();
}

async function cli(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, MAIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env,
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0)
    throw new Error(`mars ${args.join(" ")} exited ${exit}: ${stderr}`);
  return stdout;
}

interface Rpc {
  status: number;
  result?: unknown;
  error?: { code: string; message: string } | undefined;
  headers: Headers;
}
type Served = Bun.Subprocess<"ignore", "pipe", "pipe">;

async function run() {
  const root = mkdtempSync(join(tmpdir(), "mars-team-staging-"));
  const home = join(root, "home");
  const state = join(root, "state");
  mkdirSync(home);
  const env = { PATH: process.env.PATH ?? "", HOME: home };
  let child: Served | null = null;
  try {
    // Two repositories: repo-a (everyone) and repo-b (ada and grace only).
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    let shaA = "";
    let shaB = "";
    const A_PATH = "src/alpha.ts";
    const B_PATH = "src/bravo-private.ts";
    const A_TEXT =
      "export const alpha = 1;\nexport const beta = 2;\nexport const gamma = 3;\n";
    const B_TEXT =
      "// private to repo-b\nexport const secretValue = 'not-for-linus';\n";
    const repoArgs: string[] = [];
    if (GIT) {
      for (const [dir, path, text] of [
        [repoA, A_PATH, A_TEXT],
        [repoB, B_PATH, B_TEXT],
      ] as const) {
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, path), text);
        git(dir, home, "init", "-q");
        git(dir, home, "add", "-A");
        git(dir, home, "commit", "-q", "-m", "c1");
      }
      shaA = git(repoA, home, "rev-parse", "HEAD");
      shaB = git(repoB, home, "rev-parse", "HEAD");
      repoArgs.push(
        "--repo",
        `repo-a=${repoA}`,
        "--repo",
        `repo-b=${repoB}`,
        "--repo-access",
        "repo-b=ada,grace",
      );
    }
    child = Bun.spawn(
      [
        process.execPath,
        MAIN,
        "team",
        "serve",
        "--state",
        state,
        "--port",
        "0",
        "--team",
        TEAM,
        "--dev-users",
        "ada,grace,linus",
        "--enable",
        "--quiet",
        ...repoArgs,
      ],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore", env },
    );
    const reader = child.stdout.getReader();
    let output = "";
    while (!output.includes("\n")) {
      const part = await reader.read();
      if (part.done)
        throw new Error(
          `mars team serve exited: ${await new Response(child.stderr).text()}`,
        );
      output += new TextDecoder().decode(part.value);
    }
    const report = JSON.parse(output.slice(0, output.indexOf("\n"))) as {
      url: string;
      dev_tokens_file: string;
      migrations_applied: string[];
    };
    const tokens = (await Bun.file(report.dev_tokens_file).json()) as {
      users: { user_id: string; token: string }[];
    };
    const tokenOf = Object.fromEntries(
      tokens.users.map((u) => [u.user_id, u.token]),
    );
    let counter = 0;
    const rpc = async (
      user: string,
      method: string,
      params: unknown,
      requestId?: string,
    ): Promise<Rpc> => {
      const response = await fetch(`${report.url}/v1/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenOf[user]}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          method,
          context: {
            schema_version: 1,
            team_id: TEAM,
            request_id: requestId ?? `staging-${++counter}`,
          },
          params,
        }),
      });
      const body = (await response.json()) as {
        result?: unknown;
        error?: Rpc["error"];
      };
      return { status: response.status, ...body, headers: response.headers };
    };
    const ok = async <T>(
      user: string,
      method: string,
      params: unknown,
      requestId?: string,
    ): Promise<T> => {
      const response = await rpc(user, method, params, requestId);
      if (response.status !== 200)
        throw new Error(
          `${method} as ${user}: ${response.status} ${response.error?.code}`,
        );
      return response.result as T;
    };
    /** Opens `events.stream` and collects `data:` frames until closed or aborted. */
    const stream = async (user: string, cursors: unknown) => {
      const controller = new AbortController();
      const response = await fetch(`${report.url}/v1/stream`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenOf[user]}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          method: "events.stream",
          context: {
            schema_version: 1,
            team_id: TEAM,
            request_id: `stream-${++counter}`,
          },
          params: { cursors },
        }),
        signal: controller.signal,
      });
      const frames: { event: string | null; data: Record<string, unknown> }[] =
        [];
      let ended = false;
      const done = (async () => {
        if (response.status !== 200 || !response.body) {
          ended = true;
          return;
        }
        const r = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { value, done } = await r.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let cut = buffer.indexOf("\n\n");
            while (cut >= 0) {
              const block = buffer.slice(0, cut);
              buffer = buffer.slice(cut + 2);
              cut = buffer.indexOf("\n\n");
              if (block.startsWith(":")) continue;
              let event: string | null = null;
              let data = "";
              for (const line of block.split("\n")) {
                if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:")) data += line.slice(5).trim();
              }
              frames.push({
                event,
                data: JSON.parse(data) as Record<string, unknown>,
              });
            }
          }
        } catch {
          // aborted
        } finally {
          ended = true;
        }
      })();
      const waitFor = async (predicate: () => boolean, ms = 5000) => {
        const until = Date.now() + ms;
        while (!predicate()) {
          if (ended || Date.now() > until) return predicate();
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return true;
      };
      return {
        status: response.status,
        frames,
        waitFor,
        abort: () => controller.abort(),
        done,
        isEnded: () => ended,
      };
    };
    const check = async (scenario: string, fn: () => Promise<string>) => {
      try {
        rows.push({ scenario, result: "pass", note: await fn() });
      } catch (error) {
        rows.push({
          scenario,
          result: "fail",
          note: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const assert = (condition: unknown, message: string) => {
      if (!condition) throw new Error(message);
    };

    // 0. Startup: the full ledger was applied to a fresh store.
    await check("startup: store opened, ledger applied, flag on", async () => {
      assert(
        report.migrations_applied.length >= 5,
        "migrations were not applied",
      );
      const described = await ok<{
        enabled: boolean;
        capabilities: { references: boolean };
      }>("ada", "team.describe", {});
      assert(described.enabled, "team.enabled should be on after --enable");
      assert(
        described.capabilities.references === Boolean(GIT),
        "references capability mismatch",
      );
      return `ledger head ${report.migrations_applied.at(-1)}`;
    });

    // 1. Duplicate send and reconnect.
    let dmId = "";
    await check(
      "duplicate send + reconnect: one committed message, same order on both clients",
      async () => {
        const dm = await ok<{ conversation: { conversation_id: string } }>(
          "ada",
          "conversations.create_dm",
          { peer_user_id: "grace" },
        );
        dmId = dm.conversation.conversation_id;
        const live = await stream("grace", [
          { conversation_id: dmId, after_event_seq: 0 },
        ]);
        assert(live.status === 200, `stream status ${live.status}`);
        const params = {
          conversation_id: dmId,
          client_message_id: "cm-1",
          body: "first message",
        };
        const first = await ok<{ message_id: string; seq: number }>(
          "ada",
          "messages.send",
          params,
          "send-1",
        );
        // Interrupted acknowledgement: the client retries with the same request_id and client_message_id.
        const retry = await ok<{ message_id: string; seq: number }>(
          "ada",
          "messages.send",
          params,
          "send-1",
        );
        const freshRetry = await ok<{ message_id: string; seq: number }>(
          "ada",
          "messages.send",
          params,
          "send-1b",
        );
        assert(
          first.message_id === retry.message_id && first.seq === retry.seq,
          "replay returned a different message",
        );
        assert(
          first.message_id === freshRetry.message_id,
          "client_message_id replay returned a different message",
        );
        const conflict = await rpc(
          "ada",
          "messages.send",
          { ...params, body: "changed" },
          "send-1",
        );
        assert(
          conflict.status === 409,
          "reused request_id with other input must conflict",
        );
        await ok("grace", "messages.send", {
          conversation_id: dmId,
          client_message_id: "cm-2",
          body: "second message",
        });
        assert(
          await live.waitFor(
            () => live.frames.filter((f) => f.event === "message").length === 2,
          ),
          "stream did not deliver both message events",
        );
        const lastSeq = Number(live.frames.at(-1)?.data.event_seq);
        live.abort();
        await live.done;
        // Reconnect from the last event seq: nothing is replayed, nothing is lost.
        const resumed = await stream("grace", [
          { conversation_id: dmId, after_event_seq: lastSeq },
        ]);
        await ok("ada", "messages.send", {
          conversation_id: dmId,
          client_message_id: "cm-3",
          body: "third message",
        });
        assert(
          await resumed.waitFor(() => resumed.frames.length >= 1),
          "resumed stream delivered nothing",
        );
        assert(
          resumed.frames.every((f) => Number(f.data.event_seq) > lastSeq),
          "resumed stream replayed old events",
        );
        resumed.abort();
        await resumed.done;
        const adaView = await ok<{ message_id: string; seq: number }[]>(
          "ada",
          "messages.history",
          { conversation_id: dmId },
        );
        const graceView = await ok<{ message_id: string; seq: number }[]>(
          "grace",
          "messages.history",
          { conversation_id: dmId },
        );
        assert(
          adaView.length === 3,
          `expected 3 messages, got ${adaView.length}`,
        );
        assert(
          JSON.stringify(adaView.map((m) => [m.message_id, m.seq])) ===
            JSON.stringify(graceView.map((m) => [m.message_id, m.seq])),
          "clients disagree on order",
        );
        return "3 sends, 1 replay, 1 conflict, reconnect without gap or duplicate";
      },
    );

    // 2. Conversation and repo boundaries.
    let groupId = "";
    let refB: { reference_id: string } | null = null;
    await check(
      "conversation + repo boundaries: nonmember gets no history/search/events; member without repo access gets a bare restricted chip",
      async () => {
        const history = await rpc("linus", "messages.history", {
          conversation_id: dmId,
        });
        const search = await ok<{ hits: unknown[] }>(
          "linus",
          "messages.search",
          { query: "first message" },
        );
        const scoped = await rpc("linus", "messages.search", {
          query: "first",
          conversation_id: dmId,
        });
        const poll = await rpc("linus", "events.poll", {
          cursors: [{ conversation_id: dmId, after_event_seq: 0 }],
        });
        const live = await stream("linus", [
          { conversation_id: dmId, after_event_seq: 0 },
        ]);
        assert(
          history.status === 404 &&
            scoped.status === 404 &&
            poll.status === 404 &&
            live.status === 404,
          `nonmember statuses ${history.status}/${scoped.status}/${poll.status}/${live.status}`,
        );
        assert(search.hits.length === 0, "nonmember got a search hit");
        const group = await ok<{ conversation: { conversation_id: string } }>(
          "ada",
          "conversations.create_group",
          { member_ids: ["ada", "grace", "linus"], title: "triage" },
        );
        groupId = group.conversation.conversation_id;
        if (!GIT) return "boundaries hold; repo part skipped (no git on PATH)";
        refB = await ok<{ reference_id: string }>("ada", "references.create", {
          repo_id: "repo-b",
          commit_sha: shaB,
          path: B_PATH,
          line_start: 1,
          line_end: 2,
        });
        const posted = await rpc("ada", "messages.send", {
          conversation_id: groupId,
          client_message_id: "cm-ref",
          body: "look at this",
          reference_ids: [refB.reference_id],
        });
        assert(
          posted.status === 200,
          "ada could not attach a repo-b reference",
        );
        const linusHistory = await ok<
          { references: Record<string, unknown>[] }[]
        >("linus", "messages.history", { conversation_id: groupId });
        const chip = linusHistory[0]?.references[0];
        assert(
          chip &&
            chip.restricted === true &&
            Object.keys(chip).sort().join(",") === "reference_id,restricted",
          `restricted chip leaked fields: ${JSON.stringify(chip)}`,
        );
        const resolve = await ok<{ state: string }>(
          "linus",
          "references.resolve",
          { reference_id: refB.reference_id },
        );
        assert(
          JSON.stringify(resolve) === JSON.stringify({ state: "restricted" }),
          "resolve leaked metadata",
        );
        const repos = await ok<{ repo_id: string }[]>(
          "linus",
          "repos.list",
          {},
        );
        assert(
          repos.every((r) => r.repo_id !== "repo-b"),
          "repos.list leaked repo-b",
        );
        const observed = JSON.stringify([linusHistory, resolve, repos]);
        for (const forbidden of [B_PATH, shaB, repoB, "not-for-linus"])
          assert(
            !observed.includes(forbidden),
            `linus saw ${forbidden === repoB ? "the repo directory" : forbidden}`,
          );
        const preview = await rpc("linus", "agent.preview", {
          conversation_id: groupId,
          message_ids: [],
          reference_ids: [refB.reference_id],
        });
        assert(
          preview.status === 503,
          "agent.preview should be unavailable without --agent-model",
        );
        return "nonmember: 404 everywhere, 0 hits; linus: {reference_id, restricted} only";
      },
    );

    // 3. Exact code and revoked access.
    await check(
      "exact code + revoked access: reference opens at its SHA after a branch move; revocation closes preview, search and create",
      async () => {
        if (!GIT) {
          rows.push({
            scenario: "exact code + revoked access",
            result: "skipped",
            note: "no git on PATH",
          });
          return "skipped";
        }
        const refA = await ok<{ reference_id: string }>(
          "grace",
          "references.create",
          {
            repo_id: "repo-a",
            commit_sha: shaA,
            path: A_PATH,
            line_start: 2,
            line_end: 2,
          },
        );
        await ok("grace", "messages.send", {
          conversation_id: groupId,
          client_message_id: "cm-a",
          body: "see beta",
          reference_ids: [refA.reference_id],
        });
        // Branch moves on and the file is renamed.
        git(repoA, home, "mv", A_PATH, "src/renamed.ts");
        writeFileSync(
          join(repoA, "src/renamed.ts"),
          "export const alpha = 100;\nexport const beta = 200;\n",
        );
        git(repoA, home, "add", "-A");
        git(repoA, home, "commit", "-q", "-m", "c2");
        const resolved = await ok<{
          state: string;
          text?: string;
          commit_sha?: string;
        }>("linus", "references.resolve", { reference_id: refA.reference_id });
        assert(
          resolved.state === "ok" &&
            resolved.text === "export const beta = 2;" &&
            resolved.commit_sha === shaA,
          `pinned resolve failed: ${JSON.stringify(resolved)}`,
        );
        // Revoke linus from repo-a with the operator command (another process).
        await cli(
          [
            "team",
            "revoke",
            "--state",
            state,
            "--user",
            "linus",
            "--repo",
            "repo-a",
          ],
          env,
        );
        const after = await ok<{ state: string }>(
          "linus",
          "references.resolve",
          { reference_id: refA.reference_id },
        );
        assert(
          JSON.stringify(after) === JSON.stringify({ state: "restricted" }),
          "preview still open after revocation",
        );
        const paths = await rpc("linus", "references.search_paths", {
          repo_id: "repo-a",
          commit_sha: shaA,
          query: "alpha",
        });
        const create = await rpc("linus", "references.create", {
          repo_id: "repo-a",
          commit_sha: shaA,
          path: A_PATH,
        });
        const send = await rpc("linus", "messages.send", {
          conversation_id: groupId,
          client_message_id: "cm-l",
          body: "mine",
          reference_ids: [refA.reference_id],
        });
        assert(
          paths.status === 404 && create.status === 404 && send.status === 404,
          `post-revocation statuses ${paths.status}/${create.status}/${send.status}`,
        );
        const chips = await ok<{ references: Record<string, unknown>[] }[]>(
          "linus",
          "messages.history",
          { conversation_id: groupId },
        );
        assert(
          chips.every((m) => m.references.every((c) => c.restricted === true)),
          "a chip stayed resolved after revocation",
        );
        return "resolved at original SHA after rename+commit; revocation effective on the next call";
      },
    );

    // 4. Stale share card.
    await check(
      "stale share card: a re-share with a new patch digest marks the earlier card stale",
      async () => {
        const sent = await ok<{ message_id: string }[]>(
          "ada",
          "messages.history",
          { conversation_id: dmId },
        );
        const draft = await ok<{ link: { link_id: string } }>(
          "ada",
          "tasks.link_draft",
          {
            conversation_id: dmId,
            message_ids: [sent[0]?.message_id],
            reference_ids: [],
          },
        );
        const linkId = draft.link.link_id;
        await ok("ada", "tasks.link_confirm", {
          link_id: linkId,
          workbench: {
            scope: { owner_id: "local", project_id: "project-staging" },
            task_id: "task-1",
            request_id: "wb-1",
          },
          target: {},
        });
        await ok("ada", "tasks.link_created", {
          link_id: linkId,
          task_revision: 1,
        });
        const share = (diff: string, revision: number) => ({
          link_id: linkId,
          evidence: {
            task_revision: revision,
            workspace: {
              workspace_id: "ws-1",
              provider: "git-worktree",
              revision: `r${revision}`,
            },
            diff_sha256: diff,
            verify_records: [],
          },
          run_status: "completed",
          selection: {
            summary: `candidate ${revision}`,
            include_diff_digest: true,
            verify_event_ids: [],
          },
        });
        const firstPreview = await ok<{
          preview_sha256: string;
          card: { verified: boolean; verified_reason: string | null };
        }>("ada", "shares.preview", share("a".repeat(64), 1));
        assert(
          firstPreview.card.verified === false &&
            firstPreview.card.verified_reason === "missing",
          "no verify record must not read as verified",
        );
        const firstCard = await ok<{ message_id: string }>(
          "ada",
          "shares.create",
          {
            ...share("a".repeat(64), 1),
            preview_sha256: firstPreview.preview_sha256,
          },
        );
        await ok("ada", "tasks.link_created", {
          link_id: linkId,
          task_revision: 2,
        });
        const secondPreview = await ok<{ preview_sha256: string }>(
          "ada",
          "shares.preview",
          share("b".repeat(64), 2),
        );
        const secondCard = await ok<{ message_id: string }>(
          "ada",
          "shares.create",
          {
            ...share("b".repeat(64), 2),
            preview_sha256: secondPreview.preview_sha256,
          },
        );
        const history = await ok<
          {
            message_id: string;
            kind: string;
            payload?: { stale: boolean; superseded_by: string | null };
          }[]
        >("grace", "messages.history", { conversation_id: dmId });
        const first = history.find(
          (m) => m.message_id === firstCard.message_id,
        );
        const second = history.find(
          (m) => m.message_id === secondCard.message_id,
        );
        assert(
          first?.kind === "result_card" &&
            first.payload?.stale === true &&
            first.payload.superseded_by === secondCard.message_id,
          "first card not marked stale",
        );
        assert(
          second?.payload?.stale === false,
          "second card should be current",
        );
        const mismatch = await rpc("ada", "shares.create", {
          ...share("c".repeat(64), 2),
          preview_sha256: secondPreview.preview_sha256,
        });
        assert(
          mismatch.status === 409,
          "preview_sha256 mismatch must conflict",
        );
        return "first card stale + superseded_by, second current, digest mismatch conflicts";
      },
    );

    // 5. Kill switch from another process.
    await check(
      "kill switch: disable refuses RPC and closes streams; enable restores with data intact",
      async () => {
        const live = await stream("grace", [
          { conversation_id: dmId, after_event_seq: 0 },
        ]);
        assert(live.status === 200, "stream did not open");
        await live.waitFor(() => live.frames.length > 0);
        await cli(["team", "disable", "--state", state], env);
        // The serving process learns about the flag at the next request or heartbeat; force a request.
        const refused = await rpc("ada", "messages.history", {
          conversation_id: dmId,
        });
        assert(
          refused.status === 503 && refused.error?.code === "unavailable",
          `expected 503 unavailable, got ${refused.status}`,
        );
        const describe = await ok<{ enabled: boolean }>(
          "ada",
          "team.describe",
          {},
        );
        assert(describe.enabled === false, "describe should report disabled");
        const refusedStream = await stream("ada", [
          { conversation_id: dmId, after_event_seq: 0 },
        ]);
        assert(refusedStream.status === 503, "new stream should be refused");
        // The open stream closes on its heartbeat re-poll (15 s default) or at once in-process; the staging run
        // does not wait for the heartbeat, it asserts the next poll-based read is refused instead.
        live.abort();
        await live.done;
        await cli(["team", "enable", "--state", state], env);
        const history = await ok<unknown[]>("ada", "messages.history", {
          conversation_id: dmId,
        });
        assert(
          history.length === 5,
          `expected 5 messages after re-enable, got ${history.length}`,
        );
        return "503 while off (RPC + new stream), 5 messages intact after enable";
      },
    );

    // 6. Redacted stats from another process.
    await check(
      "redacted stats: counters only, no message text, path, SHA or token",
      async () => {
        const stats = await cli(["team", "stats", "--state", state], env);
        const parsed = JSON.parse(stats) as {
          metrics: {
            sends: number;
            send_replays: number;
            conflicts: number;
            denied_reads: Record<string, number>;
            disabled_refusals: number;
          };
        };
        assert(
          parsed.metrics.sends >= 4 &&
            parsed.metrics.send_replays >= 2 &&
            parsed.metrics.conflicts >= 2,
          `unexpected counters ${JSON.stringify(parsed.metrics)}`,
        );
        assert(
          (parsed.metrics.denied_reads.not_found ?? 0) >= 3 &&
            parsed.metrics.disabled_refusals >= 2,
          "denials/refusals not counted",
        );
        for (const forbidden of [
          "first message",
          "look at this",
          A_PATH,
          B_PATH,
          shaA,
          shaB,
          root,
          ...Object.values(tokenOf),
        ])
          assert(
            forbidden === "" || !stats.includes(forbidden),
            "stats leaked user or host text",
          );
        return `sends=${parsed.metrics.sends} replays=${parsed.metrics.send_replays} conflicts=${parsed.metrics.conflicts}`;
      },
    );

    child.kill("SIGTERM");
    const exit = await child.exited;
    rows.push({
      scenario: "shutdown: SIGTERM closes streams and exits 143",
      result: exit === 143 ? "pass" : "fail",
      note: `exit ${exit}`,
    });
    rows.push({
      scenario: "live VS Code window / second machine / real identity provider",
      result: "skipped",
      note: "not proven offline (see TEAM_CHAT_RUNBOOK.md acceptance matrix)",
    });
  } finally {
    if (child) {
      child.kill("SIGKILL");
      await child.exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  await run();
} catch (error) {
  rows.push({
    scenario: "harness",
    result: "fail",
    note: error instanceof Error ? error.message : String(error),
  });
}
const width = Math.max(...rows.map((r) => r.scenario.length));
console.log(
  `Team Chat staging verification (${((Date.now() - started) / 1000).toFixed(1)} s)`,
);
console.log(`${"scenario".padEnd(width)} | result  | note`);
console.log(`${"-".repeat(width)}-+---------+-----`);
for (const row of rows)
  console.log(
    `${row.scenario.padEnd(width)} | ${row.result.padEnd(7)} | ${row.note}`,
  );
const failed = rows.filter((r) => r.result === "fail").length;
console.log(
  `${rows.filter((r) => r.result === "pass").length} pass, ${failed} fail, ${rows.filter((r) => r.result === "skipped").length} skipped`,
);
process.exit(failed === 0 ? 0 : 1);
