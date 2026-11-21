import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createRemoteRepoMirror, createRepoRegistry } from "@mars/code-refs";
import { registerRuntimeCleanup } from "@mars/execution";
import { scanThreat } from "@mars/memory";
import { loadModelRegistry } from "@mars/providers";
import {
  type Authenticator,
  createAgentReferencePort,
  createCompositeAuthenticator,
  createDevAuthenticator,
  createGitHubAuthenticator,
  createTeamStore,
  createVerifiedTokenAuthenticator,
  type DevUser,
  serveTeam,
  TEAM_MIGRATIONS,
  TEAM_STORE_FORMAT_VERSION,
  type TeamStore,
  TeamStoreSnapshotSchema,
} from "@mars/team";
import { z } from "zod";
import {
  createTeamAgentWorker,
  runTeamAgentRequest,
  type TeamAgentWorker,
} from "../../../packages/team-agent/src/index";
import { CliUsageError } from "./cli-errors";

/**
 * `mars team`: the pilot operator entry point for the Team Chat service
 * (`@mars/team`). Loopback Bun process + SQLite store under
 * `<state>/team`; identity is the development authenticator only (tokens in
 * `<state>/team-dev-tokens.json`, mode 0600, hashed in memory by the
 * authenticator); repositories are host-trusted `--repo id=DIR` mappings.
 * Nothing here calls a model: `--agent-model` only lets `agent.*` queue
 * requests for a `@mars/team-agent` worker.
 */

export const TEAM_USAGE = [
  "Usage: mars team serve --state DIR [--port 7332] [--team ID] (--dev-users a,b,c | --auth-provider token|github|none) [--members a,b,c] [--auth-secret-env VAR] [--auth-issuer ISS] [--auth-audience AUD] [--github-api-url URL] [--github-allowed-ids 101,102] [--repo ID=DIR]... [--remote-repo ID=URL]... [--remote-auth-host HOST] [--repo-access ID=user,user]... [--agent-model ID] [--enable] [--quiet]",
  "       mars team enable|disable --state DIR",
  "       mars team stats --state DIR",
  "       mars team export --state DIR --out FILE [--force]",
  "       mars team import --state DIR --in FILE",
  "       mars team revoke --state DIR --user ID [--repo ID]",
  "       mars team readmit --state DIR --user ID",
  "       mars team grant --state DIR --user ID --repo ID",
  "       mars team rotate-tokens --state DIR",
  "  serve        open the store (pending migrations run first), register local/remote repos, start @MARS worker when --agent-model is set, listen on loopback, write <state>/team-connection.json (0600, no token)",
  "  enable/disable  flip the server-side team.enabled kill switch (default off; disable never deletes data, open streams are closed)",
  "  stats        print the redacted counters (team.metrics) and the flag state",
  "  export/import  JSON snapshot of every durable row (no tokens); import refuses a non-empty store",
  "  revoke       remove a user's repo access (--repo) or their team membership and dev token (no --repo)",
  "  rotate-tokens  replace every dev token; clients must re-import the new file",
  "  Auth providers: token (HS256 verified bearer tokens via MARS_TEAM_AUTH_SECRET), github (GitHub OAuth/PAT via /user), dev (--dev-users offline fallback), or none.",
].join("\n");

export class TeamUsageError extends CliUsageError {}

export const DEV_TOKENS_FILE = "team-dev-tokens.json";
export const CONNECTION_FILE = "team-connection.json";
const DEFAULT_TEAM_ID = "team-local";
const DEFAULT_PORT = 7332;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const DevTokensFileSchema = z
  .object({
    schema_version: z.literal(1),
    team_id: z.string().regex(ID_PATTERN),
    users: z
      .array(
        z
          .object({
            user_id: z.string().regex(ID_PATTERN),
            token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
            role: z.enum(["admin", "member"]),
          })
          .strict(),
      )
      .max(256),
    /** Users removed by `mars team revoke`; never re-added by `serve` until `mars team readmit`. */
    revoked: z.array(z.string().regex(ID_PATTERN)).max(256).default([]),
  })
  .strict();
export type DevTokensFile = z.infer<typeof DevTokensFileSchema>;

function stateDir(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TeamUsageError(`Missing required option --state.\n${TEAM_USAGE}`);
  const dir = resolve(value);
  if (existsSync(dir)) {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new TeamUsageError("--state must be a real directory.");
  } else mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function teamId(value: unknown): string {
  const id = value === undefined ? DEFAULT_TEAM_ID : value;
  if (typeof id !== "string" || !ID_PATTERN.test(id))
    throw new TeamUsageError(
      "--team must be 1 to 64 letters, digits, '.', '_' or '-'.",
    );
  return id;
}

/** Atomic private write: `wx` temporary file at 0600, fsync, rename over the target. */
async function writePrivate(file: string, body: string): Promise<void> {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function readDevTokens(state: string): Promise<DevTokensFile | null> {
  const file = Bun.file(join(state, DEV_TOKENS_FILE));
  if (!(await file.exists())) return null;
  const parsed = DevTokensFileSchema.safeParse(await file.json());
  if (!parsed.success)
    throw new TeamUsageError(
      `${DEV_TOKENS_FILE} in the state directory is not a valid dev token file; remove it to start over.`,
    );
  return parsed.data;
}

const newToken = () => randomBytes(32).toString("base64url");

/**
 * Dev users for this run: tokens are reused from the file so restarts keep
 * clients working; new users get fresh tokens; the first user is the admin.
 */
async function ensureDevTokens(
  state: string,
  team: string,
  userIds: string[],
  storedRole?: (userId: string) => "admin" | "member" | null,
): Promise<DevTokensFile> {
  const existing = await readDevTokens(state);
  if (existing && existing.team_id !== team)
    throw new TeamUsageError(
      `${DEV_TOKENS_FILE} belongs to another team id; remove it or pass --team ${existing.team_id}.`,
    );
  const known = new Map(existing?.users.map((u) => [u.user_id, u]) ?? []);
  const revoked = existing?.revoked ?? [];
  const users = userIds
    .filter((user_id) => !revoked.includes(user_id))
    .map((user_id, index) => {
      const persisted = storedRole?.(user_id) ?? null;
      const fileRole = known.get(user_id)?.role ?? null;
      const role: "admin" | "member" =
        persisted === "admin" ||
        fileRole === "admin" ||
        (!existing && index === 0)
          ? "admin"
          : "member";
      return {
        user_id,
        token: known.get(user_id)?.token ?? newToken(),
        role,
      };
    });
  const next: DevTokensFile = {
    schema_version: 1,
    team_id: team,
    users,
    revoked,
  };
  await writePrivate(join(state, DEV_TOKENS_FILE), JSON.stringify(next));
  return next;
}

/** `--team` must name the team the dev token file was issued for. */
async function assertTokenTeam(state: string, team: string): Promise<void> {
  const tokens = await readDevTokens(state);
  if (tokens && tokens.team_id !== team)
    throw new TeamUsageError(
      `${DEV_TOKENS_FILE} belongs to another team id; remove it or pass --team ${tokens.team_id}.`,
    );
}

function parseUsers(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0)
    throw new TeamUsageError(
      "--dev-users needs a comma-separated list of 1 to 64 user ids.",
    );
  const ids = value.split(",").map((id) => id.trim());
  if (
    ids.length === 0 ||
    ids.length > 64 ||
    ids.some((id) => !ID_PATTERN.test(id) || id === "mars") ||
    new Set(ids).size !== ids.length
  )
    throw new TeamUsageError(
      "--dev-users must list distinct ids of letters, digits, '.', '_' or '-' (never 'mars').",
    );
  return ids;
}

function parseRepos(
  values: string[] | undefined,
): { repo_id: string; dir: string }[] {
  const repos = (values ?? []).map((spec) => {
    const eq = spec.indexOf("=");
    const repo_id = eq < 0 ? "" : spec.slice(0, eq);
    const dir = eq < 0 ? "" : spec.slice(eq + 1);
    if (!ID_PATTERN.test(repo_id) || !isAbsolute(dir))
      throw new TeamUsageError("--repo expects ID=/absolute/path/to/checkout.");
    return { repo_id, dir: resolve(dir) };
  });
  if (new Set(repos.map((r) => r.repo_id)).size !== repos.length)
    throw new TeamUsageError("--repo ids must be distinct.");
  return repos;
}

function parseRemoteRepos(
  values: string[] | undefined,
): { repo_id: string; url: string }[] {
  const repos = (values ?? []).map((spec) => {
    const eq = spec.indexOf("=");
    const repo_id = eq < 0 ? "" : spec.slice(0, eq);
    const url = eq < 0 ? "" : spec.slice(eq + 1);
    if (!ID_PATTERN.test(repo_id) || url.length === 0)
      throw new TeamUsageError(
        "--remote-repo expects ID=https://... (or file://... with MARS_TEAM_ALLOW_FILE_REMOTE=1).",
      );
    return { repo_id, url };
  });
  if (new Set(repos.map((r) => r.repo_id)).size !== repos.length)
    throw new TeamUsageError("--remote-repo ids must be distinct.");
  return repos;
}

function parseRepoAccess(
  values: string[] | undefined,
  repos: ReadonlySet<string>,
  users: ReadonlySet<string>,
): Map<string, string[]> {
  const access = new Map<string, string[]>();
  for (const spec of values ?? []) {
    const eq = spec.indexOf("=");
    const repo_id = eq < 0 ? "" : spec.slice(0, eq);
    const list =
      eq < 0
        ? []
        : spec
            .slice(eq + 1)
            .split(",")
            .map((u) => u.trim())
            .filter(Boolean);
    if (!repos.has(repo_id) || access.has(repo_id))
      throw new TeamUsageError(
        "--repo-access expects REPO_ID=user,user for a repo given once with --repo or --remote-repo.",
      );
    if (users.size > 0 && list.some((user) => !users.has(user)))
      throw new TeamUsageError(
        "--repo-access may only name users from --dev-users or --members.",
      );
    access.set(repo_id, list);
  }
  return access;
}

export type TeamAuthProviderKind = "dev" | "token" | "github" | "none";

export interface TeamServeOptions {
  state: string;
  port: number;
  team: string;
  authProvider: TeamAuthProviderKind;
  devUsers: string[] | null;
  members: string[];
  authSecretEnv: string;
  authIssuer: string | null;
  authAudience: string | null;
  githubApiUrl: string | null;
  githubAllowedIds: number[] | null;
  repos: { repo_id: string; dir: string }[];
  remoteRepos: { repo_id: string; url: string }[];
  remoteAuthHost: string | null;
  repoAccess: Map<string, string[]>;
  enable: boolean;
  agentModel: string | null;
  quiet: boolean;
}

export function teamServeOptions(args: string[]): TeamServeOptions | null {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      state: { type: "string" },
      port: { type: "string" },
      team: { type: "string" },
      "dev-users": { type: "string" },
      members: { type: "string" },
      "auth-provider": { type: "string" },
      "auth-secret-env": { type: "string" },
      "auth-issuer": { type: "string" },
      "auth-audience": { type: "string" },
      "github-api-url": { type: "string" },
      "github-allowed-ids": { type: "string" },
      repo: { type: "string", multiple: true },
      "remote-repo": { type: "string", multiple: true },
      "remote-auth-host": { type: "string" },
      "repo-access": { type: "string", multiple: true },
      "agent-model": { type: "string" },
      enable: { type: "boolean" },
      quiet: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return null;
  const state = stateDir(values.state);
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new TeamUsageError("--port must be an integer between 0 and 65535.");
  const team = teamId(values.team);
  const rawProvider = values["auth-provider"];
  if (
    rawProvider !== undefined &&
    rawProvider !== "none" &&
    rawProvider !== "token" &&
    rawProvider !== "github"
  )
    throw new TeamUsageError(
      "--auth-provider must be 'token', 'github', or 'none'.",
    );
  if (values["dev-users"] !== undefined && rawProvider === "none")
    throw new TeamUsageError(
      "Pass either --dev-users or --auth-provider none, not both.",
    );
  if (values["dev-users"] === undefined && rawProvider === undefined)
    throw new TeamUsageError(
      `Identity is required: --auth-provider token|github|none or --dev-users a,b,c (local dev fallback).\n${TEAM_USAGE}`,
    );
  const authProvider: TeamAuthProviderKind =
    rawProvider === "token" ||
    rawProvider === "github" ||
    rawProvider === "none"
      ? rawProvider
      : "dev";
  const devUsers =
    values["dev-users"] === undefined ? null : parseUsers(values["dev-users"]);
  const members =
    values.members === undefined ? [] : parseUsers(values.members);
  const githubAllowedIds =
    values["github-allowed-ids"] === undefined
      ? null
      : values["github-allowed-ids"]
          .split(",")
          .map((raw) => raw.trim())
          .filter(Boolean)
          .map((raw) => {
            if (!/^[1-9][0-9]*$/.test(raw))
              throw new TeamUsageError(
                "--github-allowed-ids expects comma-separated positive GitHub numeric account IDs.",
              );
            const id = Number(raw);
            if (!Number.isSafeInteger(id) || id <= 0)
              throw new TeamUsageError(
                "--github-allowed-ids expects comma-separated positive GitHub numeric account IDs.",
              );
            return id;
          });
  if (githubAllowedIds !== null && githubAllowedIds.length === 0)
    throw new TeamUsageError(
      "--github-allowed-ids must list at least one GitHub numeric account ID.",
    );
  const repos = parseRepos(values.repo);
  const remoteRepos = parseRemoteRepos(values["remote-repo"]);
  const allRepoIds = new Set([
    ...repos.map((r) => r.repo_id),
    ...remoteRepos.map((r) => r.repo_id),
  ]);
  if (allRepoIds.size !== repos.length + remoteRepos.length)
    throw new TeamUsageError("--repo and --remote-repo ids must be distinct.");
  const knownUsers = new Set([
    ...(devUsers ?? []),
    ...members,
    ...(githubAllowedIds?.map((id) => `gh_${id}`) ?? []),
  ]);
  const repoAccess = parseRepoAccess(
    values["repo-access"],
    allRepoIds,
    knownUsers,
  );
  const agentModel = values["agent-model"] ?? null;
  if (
    agentModel !== null &&
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(agentModel)
  )
    throw new TeamUsageError("--agent-model must be a model id.");
  return {
    state,
    port,
    team,
    authProvider,
    devUsers,
    members,
    authSecretEnv: values["auth-secret-env"] ?? "MARS_TEAM_AUTH_SECRET",
    authIssuer: values["auth-issuer"] ?? null,
    authAudience: values["auth-audience"] ?? null,
    githubApiUrl: values["github-api-url"] ?? null,
    githubAllowedIds,
    repos,
    remoteRepos,
    remoteAuthHost: values["remote-auth-host"]?.trim().toLowerCase() || null,
    repoAccess,
    enable: values.enable === true,
    agentModel,
    quiet: values.quiet === true,
  };
}

const openStore = (
  state: string,
  agent?: Parameters<typeof createTeamStore>[0]["agent"],
) =>
  createTeamStore({
    rootDir: join(state, "team"),
    ...(agent ? { agent } : {}),
  });

async function runServe(
  args: string[],
  out: (line: string) => void,
): Promise<void> {
  const options = teamServeOptions(args);
  if (!options) {
    out(TEAM_USAGE);
    return;
  }
  const registry = createRepoRegistry();
  for (const repo of options.repos)
    await registry.register({
      repo_id: repo.repo_id,
      dir: repo.dir,
      label: repo.repo_id,
    });
  if (options.remoteRepos.length > 0) {
    const mirror = createRemoteRepoMirror({
      cacheDir: join(options.state, "repos"),
      registry,
      allowLocalFileUrl: process.env.MARS_TEAM_ALLOW_FILE_REMOTE === "1",
    });
    registry.ensureCommit = mirror.ensureCommit;
    const globalAuthHeader = process.env.MARS_TEAM_GIT_AUTH_HEADER;
    const repoEnvKeyOf = (repoId: string) =>
      `MARS_TEAM_GIT_AUTH_HEADER_${repoId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    const envKeyOwners = new Map<string, string[]>();
    for (const remote of options.remoteRepos) {
      let isHttps = false;
      try {
        isHttps = new URL(remote.url).protocol === "https:";
      } catch {
        // invalid URLs are rejected by mirror.registerRemote
      }
      if (!isHttps) continue;
      const key = repoEnvKeyOf(remote.repo_id);
      const owners = envKeyOwners.get(key) ?? [];
      owners.push(remote.repo_id);
      envKeyOwners.set(key, owners);
    }
    for (const [key, owners] of envKeyOwners) {
      if (owners.length > 1 && process.env[key]) {
        throw new TeamUsageError(
          `Ambiguous per-repo credential ${key} matches multiple --remote-repo ids (${owners.join(", ")}); rename repo ids so each has a distinct env key.`,
        );
      }
    }
    const fallbackHttpsHosts = new Set<string>();
    for (const remote of options.remoteRepos) {
      if (process.env[repoEnvKeyOf(remote.repo_id)]) continue;
      try {
        const parsed = new URL(remote.url);
        if (parsed.protocol === "https:")
          fallbackHttpsHosts.add(parsed.hostname.toLowerCase());
      } catch {
        // invalid URLs are rejected by mirror.registerRemote
      }
    }
    if (
      globalAuthHeader &&
      fallbackHttpsHosts.size > 1 &&
      !options.remoteAuthHost
    ) {
      throw new TeamUsageError(
        "MARS_TEAM_GIT_AUTH_HEADER cannot be shared across multiple HTTPS remote hosts; set --remote-auth-host or per-repo MARS_TEAM_GIT_AUTH_HEADER_<REPO_ID>.",
      );
    }
    for (const remote of options.remoteRepos) {
      const perRepoHeader = process.env[repoEnvKeyOf(remote.repo_id)];
      let remoteHost: string | null = null;
      try {
        const parsed = new URL(remote.url);
        if (parsed.protocol === "https:")
          remoteHost = parsed.hostname.toLowerCase();
      } catch {
        // invalid URLs are rejected by mirror.registerRemote
      }
      const scopedGlobalHeader =
        globalAuthHeader &&
        remoteHost !== null &&
        (!options.remoteAuthHost || options.remoteAuthHost === remoteHost)
          ? globalAuthHeader
          : undefined;
      const authHeader = perRepoHeader ?? scopedGlobalHeader;
      await mirror.registerRemote({
        repo_id: remote.repo_id,
        url: remote.url,
        label: remote.repo_id,
        ...(authHeader ? { auth_header: authHeader } : {}),
      });
    }
  }
  let store: TeamStore | null = null;
  const port = createAgentReferencePort({
    repos: registry,
    store: () => {
      if (!store) throw new Error("Team store is not open.");
      return store;
    },
  });
  const agentModel = options.agentModel;
  store = openStore(
    options.state,
    agentModel
      ? {
          model: () => ({ model_id: agentModel, tier: "free" as const }),
          scan: scanThreat,
          references: port,
        }
      : undefined,
  );
  const opened: TeamStore = store;
  const authenticators: Authenticator[] = [];
  let devTokensFile: string | null = null;
  let activeDevUsers = 0;
  const provisionedUsers = new Set<string>();
  // Initial provisioning only: a member removed via removeTeamMember stays
  // removed across restarts until explicitly re-added.
  const ensureMember = (user_id: string, isFirst: boolean) => {
    provisionedUsers.add(user_id);
    if (opened.teamMemberState({ team_id: options.team, user_id }) === null) {
      opened.setTeamMember({
        team_id: options.team,
        user_id,
        role: isFirst ? "admin" : "member",
      });
    }
  };
  for (const [index, user_id] of options.members.entries())
    ensureMember(user_id, index === 0);
  // Register local authenticators (dev, HS256 token) before remote providers
  // (GitHub) so local credentials are never forwarded to upstream APIs.
  if (options.devUsers) {
    const tokens = await ensureDevTokens(
      options.state,
      options.team,
      options.devUsers,
      (userId) =>
        opened.teamMemberRole({ team_id: options.team, user_id: userId }),
    );
    devTokensFile = join(options.state, DEV_TOKENS_FILE);
    activeDevUsers = tokens.users.length;
    const users: DevUser[] = tokens.users.map((user) => ({
      token: user.token,
      user_id: user.user_id,
      team_ids: [options.team],
    }));
    authenticators.push(createDevAuthenticator(users));
    for (const user of tokens.users) {
      provisionedUsers.add(user.user_id);
      // `ensureDevTokens` already omits revoked users until `mars team readmit`,
      // so every user in `tokens.users` is active and keeps their token-file role.
      opened.setTeamMember({
        team_id: options.team,
        user_id: user.user_id,
        role: user.role,
      });
    }
  }
  if (options.authProvider === "token") {
    const secret = process.env[options.authSecretEnv];
    if (!secret || Buffer.byteLength(secret, "utf8") < 32)
      throw new TeamUsageError(
        `--auth-provider token requires ${options.authSecretEnv} to be set to at least 32 bytes.`,
      );
    authenticators.push(
      createVerifiedTokenAuthenticator({
        secret,
        ...(options.authIssuer ? { issuer: options.authIssuer } : {}),
        ...(options.authAudience ? { audience: options.authAudience } : {}),
        resolveTeams: (userId) => opened.activeTeamIds(userId),
      }),
    );
  } else if (options.authProvider === "github") {
    if (options.githubAllowedIds) {
      for (const [index, ghId] of options.githubAllowedIds.entries()) {
        const userId = `gh_${ghId}`;
        if (!provisionedUsers.has(userId))
          ensureMember(userId, provisionedUsers.size === 0 && index === 0);
      }
    }
    authenticators.push(
      createGitHubAuthenticator({
        ...(options.githubApiUrl ? { apiBaseUrl: options.githubApiUrl } : {}),
        ...(options.githubAllowedIds
          ? { allowedIds: options.githubAllowedIds }
          : {}),
        mapUserId: (profile) => `gh_${profile.id}`,
        resolveTeams: (_profile, userId) => opened.activeTeamIds(userId),
      }),
    );
  }
  const authenticator: Authenticator =
    authenticators.length === 0
      ? { authenticate: async () => null }
      : authenticators.length === 1
        ? (authenticators[0] as Authenticator)
        : createCompositeAuthenticator(authenticators);
  const allRepoIds = [
    ...options.repos.map((r) => r.repo_id),
    ...options.remoteRepos.map((r) => r.repo_id),
  ];
  const defaultGrantUsers = [...provisionedUsers];
  for (const repo_id of allRepoIds) {
    opened.setRepo({
      team_id: options.team,
      repo_id,
      label: repo_id,
    });
    const grant = options.repoAccess.get(repo_id) ?? defaultGrantUsers;
    // Initial provisioning only: a row revoked by `mars team revoke --repo`
    // stays removed across restarts until `mars team grant`.
    for (const user_id of grant) {
      const access = { team_id: options.team, repo_id, user_id };
      if (opened.repoAccessState(access) === null) opened.setRepoAccess(access);
    }
  }
  if (options.enable) opened.setEnabled(true);
  let agentWorker: TeamAgentWorker | null = null;
  if (agentModel !== null) {
    const modelRegistry = await loadModelRegistry({
      cwd: options.state,
      env: process.env,
    });
    const agentRootDir = join(options.state, "agent");
    mkdirSync(agentRootDir, { recursive: true, mode: 0o700 });
    chmodSync(agentRootDir, 0o700);
    agentWorker = createTeamAgentWorker({
      host: opened.agentHost,
      run: (claimed) =>
        runTeamAgentRequest({
          request: claimed.request,
          input: claimed.input,
          signal: claimed.signal,
          registry: modelRegistry,
          rootDir: agentRootDir,
          scan: scanThreat,
          env: process.env,
          ...(options.quiet
            ? {}
            : {
                onError: (notice) =>
                  out(JSON.stringify({ log: "team-agent", ...notice })),
              }),
        }),
      ...(options.quiet
        ? {}
        : {
            onError: () =>
              out(
                JSON.stringify({
                  log: "team-agent",
                  reason_code: "worker_error",
                }),
              ),
          }),
    });
  }
  let server: ReturnType<typeof serveTeam>;
  try {
    server = serveTeam({
      store: opened,
      authenticator,
      port: options.port,
      repos: registry,
      agentReferences: port,
      ...(options.quiet
        ? {}
        : { log: (entry) => out(JSON.stringify({ log: "team", ...entry })) }),
    });
  } catch (error) {
    opened.close();
    throw error;
  }
  const url = `http://127.0.0.1:${server.port}`;
  const connectionFile = join(options.state, CONNECTION_FILE);
  try {
    await writePrivate(
      connectionFile,
      JSON.stringify({ schema_version: 1, url, team_id: options.team }),
    );
  } catch (error) {
    await server.stop(true);
    opened.close();
    throw error;
  }
  if (agentWorker) agentWorker.start();
  await new Promise<void>((resolve, reject) => {
    registerRuntimeCleanup("mars-team", async () => {
      try {
        if (agentWorker) await agentWorker.stop();
        // `stop(true)` ends every open stream before the process exits.
        await server.stop(true);
        opened.close();
        resolve();
      } catch {
        reject(new Error("Team service shutdown failed."));
      }
    });
    out(
      JSON.stringify({
        status: "listening",
        service: "team",
        url,
        team_id: options.team,
        connection_file: connectionFile,
        auth_provider: options.authProvider,
        dev_tokens_file: devTokensFile,
        dev_users: activeDevUsers,
        migrations_applied: opened.migrationsApplied,
        ledger_head: opened.ledgerHead,
        repos: allRepoIds.length,
        remote_repos: options.remoteRepos.length,
        enabled: opened.isEnabled(),
        agent: agentModel !== null,
      }),
    );
  });
}

function simpleArgs(
  args: string[],
  extra: Record<string, { type: "string" | "boolean" }> = {},
): Record<string, string | boolean | undefined> {
  return parseArgs({
    args,
    strict: true,
    options: { state: { type: "string" }, help: { type: "boolean" }, ...extra },
  }).values as Record<string, string | boolean | undefined>;
}

/** `mars team`: operator commands for the Team Chat pilot. */
export async function runTeam(
  args: string[],
  out: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  const subcommand = args[0];
  const rest = args.slice(1);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    out(TEAM_USAGE);
    return;
  }
  if (subcommand === "serve") {
    await runServe(rest, out);
    return;
  }
  if (subcommand === "enable" || subcommand === "disable") {
    const values = simpleArgs(rest);
    if (values.help) return out(TEAM_USAGE);
    const store = openStore(stateDir(values.state));
    try {
      const result = store.setEnabled(subcommand === "enable");
      out(
        JSON.stringify({
          ...result,
          migrations_applied: store.migrationsApplied,
        }),
      );
    } finally {
      store.close();
    }
    return;
  }
  if (subcommand === "stats") {
    const values = simpleArgs(rest);
    if (values.help) return out(TEAM_USAGE);
    const store = openStore(stateDir(values.state));
    try {
      out(
        JSON.stringify(
          {
            enabled: store.isEnabled(),
            ledger_head: store.ledgerHead,
            format_version: TEAM_STORE_FORMAT_VERSION,
            metrics: store.metrics.snapshot(),
          },
          null,
          2,
        ),
      );
    } finally {
      store.close();
    }
    return;
  }
  if (subcommand === "export") {
    const values = simpleArgs(rest, {
      out: { type: "string" },
      force: { type: "boolean" },
    });
    if (values.help) return out(TEAM_USAGE);
    if (typeof values.out !== "string" || values.out.length === 0)
      throw new TeamUsageError("export needs --out FILE.");
    const target = resolve(values.out);
    if (existsSync(target) && values.force !== true)
      throw new TeamUsageError(
        "export refuses to overwrite an existing file; pass --force.",
      );
    const store = openStore(stateDir(values.state));
    try {
      const snapshot = store.exportSnapshot();
      await writePrivate(target, JSON.stringify(snapshot));
      out(
        JSON.stringify({
          exported: true,
          ledger_head: snapshot.ledger[snapshot.ledger.length - 1] ?? null,
          enabled_at_export: snapshot.enabled,
          rows: Object.values(snapshot.tables).reduce(
            (sum, rows) => sum + rows.length,
            0,
          ),
        }),
      );
    } finally {
      store.close();
    }
    return;
  }
  if (subcommand === "import") {
    const values = simpleArgs(rest, { in: { type: "string" } });
    if (values.help) return out(TEAM_USAGE);
    if (typeof values.in !== "string" || values.in.length === 0)
      throw new TeamUsageError("import needs --in FILE.");
    const source = Bun.file(resolve(values.in));
    if (!(await source.exists()))
      throw new TeamUsageError("import: snapshot file not found.");
    let raw: unknown;
    try {
      raw = await source.json();
    } catch {
      throw new TeamUsageError("import: snapshot file is not valid JSON.");
    }
    const parsed = TeamStoreSnapshotSchema.safeParse(raw);
    if (!parsed.success)
      throw new TeamUsageError("import: not a team store snapshot.");
    const store = openStore(stateDir(values.state));
    try {
      const report = store.importSnapshot(parsed.data);
      out(
        JSON.stringify({
          imported: true,
          ...report,
          enabled: store.isEnabled(),
        }),
      );
    } finally {
      store.close();
    }
    return;
  }
  if (subcommand === "readmit" || subcommand === "grant") {
    const values = simpleArgs(rest, {
      user: { type: "string" },
      repo: { type: "string" },
      team: { type: "string" },
    });
    if (values.help) return out(TEAM_USAGE);
    const userId = values.user;
    if (typeof userId !== "string" || !ID_PATTERN.test(userId))
      throw new TeamUsageError(`${subcommand} needs --user ID.`);
    const state = stateDir(values.state);
    const team = teamId(
      typeof values.team === "string"
        ? values.team
        : (await readDevTokens(state))?.team_id,
    );
    await assertTokenTeam(state, team);
    if (subcommand === "grant") {
      const repo = values.repo;
      if (typeof repo !== "string" || !ID_PATTERN.test(repo))
        throw new TeamUsageError("grant needs --repo ID.");
      const store = openStore(state);
      try {
        store.setRepoAccess({ team_id: team, repo_id: repo, user_id: userId });
      } finally {
        store.close();
      }
      out(JSON.stringify({ granted: "repo_access", team_id: team }));
      return;
    }
    // Membership and a fresh dev token come back on the next `serve` with the user listed in --dev-users.
    const tokens = await readDevTokens(state);
    if (!tokens)
      throw new TeamUsageError("readmit: no dev token file in this state dir.");
    const revoked = tokens.revoked.filter((id) => id !== userId);
    await writePrivate(
      join(state, DEV_TOKENS_FILE),
      JSON.stringify({ ...tokens, revoked }),
    );
    out(
      JSON.stringify({
        readmitted: true,
        team_id: team,
        was_revoked: revoked.length !== tokens.revoked.length,
      }),
    );
    return;
  }
  if (subcommand === "revoke") {
    const values = simpleArgs(rest, {
      user: { type: "string" },
      repo: { type: "string" },
      team: { type: "string" },
    });
    if (values.help) return out(TEAM_USAGE);
    const userId = values.user;
    if (typeof userId !== "string" || !ID_PATTERN.test(userId))
      throw new TeamUsageError("revoke needs --user ID.");
    const state = stateDir(values.state);
    const team = teamId(
      typeof values.team === "string"
        ? values.team
        : (await readDevTokens(state))?.team_id,
    );
    await assertTokenTeam(state, team);
    const store = openStore(state);
    try {
      const user = userId;
      const repo = values.repo;
      if (repo !== undefined) {
        if (typeof repo !== "string" || !ID_PATTERN.test(repo))
          throw new TeamUsageError("--repo must be a repo id.");
        store.revokeRepoAccess({ team_id: team, repo_id: repo, user_id: user });
        out(JSON.stringify({ revoked: "repo_access", team_id: team }));
      } else {
        store.removeTeamMember({ team_id: team, user_id: user });
        const tokens = await readDevTokens(state);
        if (tokens) {
          const users = tokens.users.filter((u) => u.user_id !== user);
          const revoked = [...new Set([...tokens.revoked, user])];
          await writePrivate(
            join(state, DEV_TOKENS_FILE),
            JSON.stringify({ ...tokens, users, revoked }),
          );
        }
        out(
          JSON.stringify({
            revoked: "team_membership",
            team_id: team,
            dev_token_removed: tokens !== null,
          }),
        );
      }
    } finally {
      store.close();
    }
    return;
  }
  if (subcommand === "rotate-tokens") {
    const values = simpleArgs(rest);
    if (values.help) return out(TEAM_USAGE);
    const state = stateDir(values.state);
    const tokens = await readDevTokens(state);
    if (!tokens)
      throw new TeamUsageError(
        "rotate-tokens: no dev token file in the state directory.",
      );
    const users = tokens.users.map((u) => ({ ...u, token: newToken() }));
    await writePrivate(
      join(state, DEV_TOKENS_FILE),
      JSON.stringify({ ...tokens, users }),
    );
    out(JSON.stringify({ rotated: users.length, restart_required: true }));
    return;
  }
  throw new TeamUsageError(
    `Unknown team subcommand "${subcommand}".\n${TEAM_USAGE}`,
  );
}

/** `mars doctor` team section: static facts plus, with a state directory, the flag and ledger read without running migrations. */
export function teamDoctorReport(teamState?: string) {
  const base = {
    service: "@mars/team (loopback RPC + SSE over SQLite, pilot only)",
    enabled_by:
      "mars team serve --state DIR --dev-users a,b,c [--enable]; mars team enable|disable",
    store_format_version: TEAM_STORE_FORMAT_VERSION,
    ledger_head: TEAM_MIGRATIONS[TEAM_MIGRATIONS.length - 1]?.id ?? null,
    migrations_known: TEAM_MIGRATIONS.length,
    flag_default: "off",
    identity: "dev authenticator only (no real identity provider)",
    verified:
      "offline only (loopback tests, temp git repos; no live window or second machine)",
    live_verified: false,
  };
  if (!teamState)
    return { ...base, state: "not inspected (pass --team-state DIR)" };
  const file = join(resolve(teamState), "team", "team.sqlite");
  if (!existsSync(file))
    return { ...base, state: "no store in the given state directory" };
  const db = new Database(file, { readonly: true });
  try {
    const ledger = db
      .query<{ id: string }, []>("SELECT id FROM migrations ORDER BY position")
      .all()
      .map((row) => row.id);
    const enabled =
      db
        .query<{ value: string }, []>(
          "SELECT value FROM meta WHERE key = 'team.enabled'",
        )
        .get()?.value === "1";
    const hasRepos =
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'repos'",
        )
        .get()?.n === 1;
    const repos = hasRepos
      ? (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM repos").get()
          ?.n ?? 0)
      : 0;
    return {
      ...base,
      state: "inspected",
      store_ledger_head: ledger[ledger.length - 1] ?? null,
      pending_migrations: TEAM_MIGRATIONS.length - ledger.length,
      enabled,
      repos,
    };
  } finally {
    db.close();
  }
}
