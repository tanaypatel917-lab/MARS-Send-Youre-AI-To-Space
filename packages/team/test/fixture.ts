import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoRegistry } from "@mars/code-refs";
import { createDevAuthenticator } from "../src/auth";
import type { TeamLimits } from "../src/schemas";
import { serveTeam } from "../src/server";
import { createTeamStore, type TeamStore } from "../src/store";

export const TEAM = "team-1";
export const OTHER_TEAM = "team-2";
export const TOKENS = {
  alice: "alice_dev_token_not_a_secret_000000000001",
  bob: "bob_dev_token_not_a_secret_00000000000002",
  carol: "carol_dev_token_not_a_secret_000000000003",
  dave: "dave_dev_token_not_a_secret_0000000000004",
  stranger: "stranger_dev_token_not_a_secret_00000005",
} as const;
export type User = keyof typeof TOKENS;

export interface RpcResult {
  status: number;
  body: { result?: unknown; error?: { code: string; message: string } };
}

export interface FixtureOptions {
  limits?: Partial<TeamLimits>;
  /** Host registry; when given, `references.*` are served. */
  repos?: RepoRegistry;
}

export function fixture(options: Partial<TeamLimits> | FixtureOptions = {}) {
  const resolved: FixtureOptions =
    "limits" in options || "repos" in options
      ? (options as FixtureOptions)
      : { limits: options as Partial<TeamLimits> };
  const limits = resolved.limits ?? {};
  const rootDir = mkdtempSync(join(tmpdir(), "mars-team-"));
  const store = createTeamStore({ rootDir, limits });
  for (const user of ["alice", "bob", "carol"])
    store.setTeamMember({ team_id: TEAM, user_id: user, role: "member" });
  store.setTeamMember({ team_id: OTHER_TEAM, user_id: "dave", role: "admin" });
  const authenticator = createDevAuthenticator([
    { token: TOKENS.alice, user_id: "alice", team_ids: [TEAM] },
    { token: TOKENS.bob, user_id: "bob", team_ids: [TEAM] },
    { token: TOKENS.carol, user_id: "carol", team_ids: [TEAM] },
    { token: TOKENS.dave, user_id: "dave", team_ids: [OTHER_TEAM] },
    // Authenticated but never added to the team store.
    { token: TOKENS.stranger, user_id: "stranger", team_ids: [TEAM] },
  ]);
  const server = serveTeam({
    store,
    authenticator,
    port: 0,
    ...(resolved.repos ? { repos: resolved.repos } : {}),
  });
  const url = `http://127.0.0.1:${server.port}/v1/rpc`;
  let counter = 0;
  const raw = (
    body: unknown,
    headers: Record<string, string> = {},
    init: RequestInit = {},
  ) =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKENS.alice}`,
        "content-type": "application/json",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    });
  const rpc = async (
    user: User,
    method: string,
    params: unknown,
    options: { request_id?: string; team_id?: string } = {},
  ): Promise<RpcResult> => {
    const response = await raw(
      {
        method,
        context: {
          schema_version: 1,
          team_id: options.team_id ?? TEAM,
          request_id: options.request_id ?? `req-${++counter}`,
        },
        params,
      },
      { authorization: `Bearer ${TOKENS[user]}` },
    );
    return {
      status: response.status,
      body: (await response.json()) as RpcResult["body"],
    };
  };
  const ok = async <T>(
    user: User,
    method: string,
    params: unknown,
    options?: { request_id?: string; team_id?: string },
  ): Promise<T> => {
    const response = await rpc(user, method, params, options);
    if (response.status !== 200)
      throw new Error(
        `${method} failed: ${response.status} ${JSON.stringify(response.body)}`,
      );
    return response.body.result as T;
  };
  const close = async () => {
    await server.stop(true);
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
  };
  return {
    rootDir,
    store: store as TeamStore,
    server,
    url,
    raw,
    rpc,
    ok,
    close,
  };
}
