import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTeam, TeamUsageError } from "./team";

const entrypoint = join(import.meta.dir, "main.ts");

interface Served {
  child: ReturnType<typeof Bun.spawn>;
  report: Record<string, unknown>;
  /** Everything written to stdout so far (startup line included). */
  stdout: () => string;
  /** Resolves when stdout closes; stderr is read then. */
  drained: Promise<void>;
  stderr: () => string;
}

async function spawnServe(
  args: string[],
  env: Record<string, string>,
): Promise<Served> {
  const child = Bun.spawn(
    [process.execPath, entrypoint, "team", "serve", ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env,
    },
  );
  const reader = child.stdout.getReader();
  let output = "";
  let errorOutput = "";
  let ready: () => void = () => {};
  let failed: (error: Error) => void = () => {};
  const firstLine = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const drained = (async () => {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      output += new TextDecoder().decode(part.value);
      if (output.includes("\n")) ready();
    }
    errorOutput = await new Response(child.stderr).text();
    failed(new Error(`CLI exited before ready: ${errorOutput}`));
  })();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      firstLine,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("CLI did not start")),
          20000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return {
    child,
    report: JSON.parse(output.slice(0, output.indexOf("\n"))),
    stdout: () => output,
    drained,
    stderr: () => errorOutput,
  };
}

const rpc = (
  url: string,
  token: string,
  method: string,
  params: unknown,
  team_id: string,
) =>
  fetch(`${url}/v1/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      method,
      context: { schema_version: 1, team_id, request_id: crypto.randomUUID() },
      params,
    }),
  });

test("mars team serve: dev users, private files, flag default off, enable/disable/stats/export/import/revoke round trip, clean SIGTERM", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-cli-team-"));
  const state = join(root, "state");
  const env = { PATH: process.env.PATH ?? "", HOME: root };
  let served: Served | null = null;
  try {
    served = await spawnServe(
      ["--state", state, "--port", "0", "--dev-users", "ada,grace,linus"],
      env,
    );
    const { report } = served;
    const startupOutput = served.stdout();
    expect(report.status).toBe("listening");
    expect(report.service).toBe("team");
    expect(report.auth_provider).toBe("dev");
    expect(report.enabled).toBe(false);
    expect(report.repos).toBe(0);
    expect(report.ledger_head).toBe("0005_metrics");
    expect(report.migrations_applied).toEqual([
      "0001_initial",
      "0002_task_links",
      "0003_references",
      "0004_agent_requests",
      "0005_metrics",
    ]);
    expect(report.connection_file).toBe(join(state, "team-connection.json"));
    expect(report.dev_tokens_file).toBe(join(state, "team-dev-tokens.json"));
    const connection = JSON.parse(
      await readFile(String(report.connection_file), "utf8"),
    );
    expect(Object.keys(connection).sort()).toEqual([
      "schema_version",
      "team_id",
      "url",
    ]);
    expect(connection.team_id).toBe("team-local");
    expect((await stat(String(report.connection_file))).mode & 0o777).toBe(
      0o600,
    );
    expect((await stat(String(report.dev_tokens_file))).mode & 0o777).toBe(
      0o600,
    );
    expect((await stat(join(state, "team"))).mode & 0o777).toBe(0o700);
    const tokens = JSON.parse(
      await readFile(String(report.dev_tokens_file), "utf8"),
    );
    expect(
      tokens.users.map((u: { user_id: string; role: string }) => [
        u.user_id,
        u.role,
      ]),
    ).toEqual([
      ["ada", "admin"],
      ["grace", "member"],
      ["linus", "member"],
    ]);
    const ada = tokens.users[0].token as string;
    // No token ever reaches stdout.
    for (const user of tokens.users)
      expect(startupOutput.includes(user.token)).toBe(false);
    const url = String(report.url);

    // Flag off: describe answers with enabled: false, everything else is unavailable.
    const described = await rpc(url, ada, "team.describe", {}, "team-local");
    expect(described.status).toBe(200);
    expect(
      (
        (await described.json()) as {
          result: { enabled: boolean; role: string };
        }
      ).result,
    ).toMatchObject({ enabled: false, role: "admin" });
    const refused = await rpc(url, ada, "conversations.list", {}, "team-local");
    expect(refused.status).toBe(503);

    // Enable from another process; the serving process re-reads the flag.
    const lines: string[] = [];
    await runTeam(["enable", "--state", state], (line) => lines.push(line));
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      enabled: true,
      changed: true,
      migrations_applied: [],
    });
    const dm = await rpc(
      url,
      ada,
      "conversations.create_dm",
      { peer_user_id: "grace" },
      "team-local",
    );
    expect(dm.status).toBe(200);
    const conversationId = (
      (await dm.json()) as {
        result: { conversation: { conversation_id: string } };
      }
    ).result.conversation.conversation_id;
    const sent = await rpc(
      url,
      ada,
      "messages.send",
      {
        conversation_id: conversationId,
        client_message_id: "m1",
        body: "hello grace",
      },
      "team-local",
    );
    expect(sent.status).toBe(200);

    // Stats are readable cross-process and redacted.
    lines.length = 0;
    await runTeam(["stats", "--state", state], (line) => lines.push(line));
    const stats = JSON.parse(lines.join("\n"));
    expect(stats.enabled).toBe(true);
    expect(stats.metrics.sends).toBe(1);
    expect(stats.metrics.rpc_errors.unavailable).toBe(1);
    expect(JSON.stringify(stats)).not.toContain("hello grace");

    // Export (private file), import refuses the live non-empty store, restores into a fresh one.
    const exported = join(root, "snapshot.json");
    lines.length = 0;
    await runTeam(["export", "--state", state, "--out", exported], (line) =>
      lines.push(line),
    );
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      exported: true,
      ledger_head: "0005_metrics",
    });
    expect((await stat(exported)).mode & 0o777).toBe(0o600);
    const snapshotText = await readFile(exported, "utf8");
    expect(snapshotText).toContain("hello grace");
    expect(snapshotText.includes(ada)).toBe(false);
    await expect(
      runTeam(["export", "--state", state, "--out", exported], () => {}),
    ).rejects.toBeInstanceOf(TeamUsageError);
    await expect(
      runTeam(["import", "--state", state, "--in", exported], () => {}),
    ).rejects.toThrow(/non-empty/);
    const restoredState = join(root, "restored");
    lines.length = 0;
    await runTeam(
      ["import", "--state", restoredState, "--in", exported],
      (line) => lines.push(line),
    );
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      imported: true,
      tables: 15,
      enabled: false,
    });
    lines.length = 0;
    await runTeam(["stats", "--state", restoredState], (line) =>
      lines.push(line),
    );
    expect(JSON.parse(lines.join("\n")).metrics.sends).toBe(1);

    // Revoke linus from the team: membership and dev token are gone.
    lines.length = 0;
    await runTeam(["revoke", "--state", state, "--user", "linus"], (line) =>
      lines.push(line),
    );
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      revoked: "team_membership",
      dev_token_removed: true,
    });
    const afterRevoke = JSON.parse(
      await readFile(String(report.dev_tokens_file), "utf8"),
    );
    expect(
      afterRevoke.users.map((u: { user_id: string }) => u.user_id),
    ).toEqual(["ada", "grace"]);
    const linusToken = tokens.users[2].token as string;
    // The serving process still accepts the old token (hashed at start) but the store denies the removed member.
    expect(
      (await rpc(url, linusToken, "conversations.list", {}, "team-local"))
        .status,
    ).toBe(403);

    // Disable from another process: the next call is refused, data stays.
    lines.length = 0;
    await runTeam(["disable", "--state", state], (line) => lines.push(line));
    expect(
      (
        await rpc(
          url,
          ada,
          "messages.history",
          { conversation_id: conversationId },
          "team-local",
        )
      ).status,
    ).toBe(503);
    await runTeam(["enable", "--state", state], () => {});
    const history = await rpc(
      url,
      ada,
      "messages.history",
      { conversation_id: conversationId },
      "team-local",
    );
    expect(
      ((await history.json()) as { result: { body: string }[] }).result.map(
        (m) => m.body,
      ),
    ).toEqual(["hello grace"]);

    served.child.kill("SIGTERM");
    expect(await served.child.exited).toBe(143);
    await served.drained;
    expect(served.stderr()).toBe("");
    // Log lines on stdout carry operation ids and codes only.
    const rest = served.stdout();
    expect(rest).not.toContain("hello grace");
    expect(rest.includes(ada)).toBe(false);
    expect(rest).toContain('"log":"team"');

    // Restart reuses the same tokens and does not re-run migrations.
    const again = await spawnServe(
      ["--state", state, "--port", "0", "--dev-users", "ada,grace"],
      env,
    );
    try {
      expect(again.report.migrations_applied).toEqual([]);
      expect(again.report.enabled).toBe(true);
      expect(
        JSON.parse(await readFile(String(report.dev_tokens_file), "utf8"))
          .users[0].token,
      ).toBe(ada);
      expect(
        (
          await rpc(
            String(again.report.url),
            ada,
            "conversations.list",
            {},
            "team-local",
          )
        ).status,
      ).toBe(200);
    } finally {
      again.child.kill("SIGKILL");
      await again.child.exited;
    }
  } finally {
    served?.child.kill("SIGKILL");
    await served?.child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

test("mars team serve requires an identity option, rejects bad repo specs, and --auth-provider none authenticates nobody", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-cli-team-none-"));
  const state = join(root, "state");
  try {
    await expect(
      runTeam(["serve", "--state", state, "--port", "0"], () => {}),
    ).rejects.toBeInstanceOf(TeamUsageError);
    await expect(
      runTeam(
        [
          "serve",
          "--state",
          state,
          "--port",
          "0",
          "--dev-users",
          "ada",
          "--repo",
          "bad",
        ],
        () => {},
      ),
    ).rejects.toBeInstanceOf(TeamUsageError);
    await expect(
      runTeam(
        ["serve", "--state", state, "--port", "0", "--dev-users", "ada,mars"],
        () => {},
      ),
    ).rejects.toBeInstanceOf(TeamUsageError);
    await expect(
      runTeam(
        [
          "serve",
          "--state",
          state,
          "--port",
          "0",
          "--dev-users",
          "ada",
          "--repo-access",
          "nope=ada",
        ],
        () => {},
      ),
    ).rejects.toBeInstanceOf(TeamUsageError);
    const child = Bun.spawn(
      [
        process.execPath,
        entrypoint,
        "team",
        "serve",
        "--state",
        state,
        "--port",
        "0",
        "--auth-provider",
        "none",
        "--enable",
        "--quiet",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: { PATH: process.env.PATH ?? "", HOME: root },
      },
    );
    try {
      const reader = child.stdout.getReader();
      let output = "";
      while (!output.includes("\n")) {
        const part = await reader.read();
        if (part.done) throw new Error("CLI exited before ready");
        output += new TextDecoder().decode(part.value);
      }
      const report = JSON.parse(output);
      expect(report.auth_provider).toBe("none");
      expect(report.dev_tokens_file).toBeNull();
      expect(report.enabled).toBe(true);
      const response = await rpc(
        String(report.url),
        "a".repeat(40),
        "team.describe",
        {},
        "team-local",
      );
      expect(response.status).toBe(401);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("mars doctor --team-state reports the flag and ledger without paths or tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-cli-team-doctor-"));
  const state = join(root, "state");
  try {
    await runTeam(["enable", "--state", state], () => {});
    const child = Bun.spawn(
      [process.execPath, entrypoint, "doctor", "--team-state", state],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: { PATH: process.env.PATH ?? "", HOME: root },
      },
    );
    const [output, exit] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    expect(exit).toBe(0);
    const report = JSON.parse(output);
    expect(report.team).toMatchObject({
      state: "inspected",
      enabled: true,
      store_ledger_head: "0005_metrics",
      pending_migrations: 0,
      repos: 0,
      flag_default: "off",
      live_verified: false,
    });
    expect(JSON.stringify(report.team)).not.toContain(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
