import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface AuthenticatedUser {
  readonly user_id: string;
  readonly team_ids: readonly string[];
}

/**
 * Resolves a bearer token to a user. The team service never accepts `user_id`
 * from the client; it is derived from this interface on every request.
 */
export interface Authenticator {
  authenticate(bearerToken: string): Promise<AuthenticatedUser | null>;
}

export interface DevUser {
  readonly token: string;
  readonly user_id: string;
  readonly team_ids: readonly string[];
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MAX_BEARER_LENGTH = 4096;
const digest = (value: string) => createHash("sha256").update(value).digest();

function freezeUser(
  userId: string,
  teamIds: readonly string[],
): AuthenticatedUser | null {
  if (!userId || userId.length > 256) return null;
  const uniqueTeams = [
    ...new Set(
      teamIds.filter(
        (t) => typeof t === "string" && t.length > 0 && t.length <= 128,
      ),
    ),
  ];
  if (uniqueTeams.length === 0) return null;
  return Object.freeze({
    user_id: userId,
    team_ids: Object.freeze(uniqueTeams),
  });
}

/**
 * Pilot/test authenticator over a fixed token map. Tokens are hashed at
 * construction and compared as SHA-256 digests in constant time; plain tokens
 * are never retained. Not for production.
 */
export function createDevAuthenticator(
  users: readonly DevUser[],
): Authenticator {
  const entries = users.map((user) => {
    if (!TOKEN_PATTERN.test(user.token))
      throw new Error(
        "Dev authenticator requires random URL-safe tokens of 32 to 256 characters.",
      );
    if (!user.user_id || user.user_id.length > 256)
      throw new Error(
        "Dev authenticator requires a user id of 1 to 256 characters.",
      );
    return {
      hash: digest(user.token),
      user: Object.freeze({
        user_id: user.user_id,
        team_ids: Object.freeze([...new Set(user.team_ids)]),
      }),
    };
  });
  const hashes = new Set(entries.map((entry) => entry.hash.toString("hex")));
  if (hashes.size !== entries.length)
    throw new Error("Dev authenticator tokens must be unique.");
  return {
    async authenticate(bearerToken) {
      if (typeof bearerToken !== "string" || bearerToken.length > 256)
        return null;
      const candidate = digest(bearerToken);
      let match: AuthenticatedUser | null = null;
      for (const entry of entries) {
        if (timingSafeEqual(entry.hash, candidate)) match = entry.user;
      }
      return match;
    },
  };
}

export interface VerifiedTokenClaims {
  readonly sub: string;
  readonly team_ids?: readonly string[];
  readonly exp: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly iss?: string;
  readonly aud?: string;
}

export interface VerifiedTokenAuthenticatorOptions {
  /** Shared HMAC-SHA256 signing secret (at least 32 UTF-8 bytes). */
  readonly secret: string | Uint8Array;
  /** Expected `iss` claim; when set, tokens with a different issuer are rejected. */
  readonly issuer?: string;
  /** Expected `aud` claim; when set, tokens with a different audience are rejected. */
  readonly audience?: string;
  /** Allowed clock skew in seconds (default 30). */
  readonly clockSkewSeconds?: number;
  /** Clock returning current epoch seconds (tests inject). */
  readonly nowSeconds?: () => number;
  /**
   * Optional server-side team resolver. When provided, its result overrides
   * any `team_ids` claim in the token so team membership stays server-authoritative.
   */
  readonly resolveTeams?: (
    userId: string,
  ) => readonly string[] | Promise<readonly string[]>;
}

function base64UrlEncode(input: string | Uint8Array): string {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(input: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
  try {
    return Buffer.from(input, "base64url");
  } catch {
    return null;
  }
}

function toSecretKey(secret: string | Uint8Array): Buffer {
  const buf =
    typeof secret === "string"
      ? Buffer.from(secret, "utf8")
      : Buffer.from(secret);
  if (buf.byteLength < 32)
    throw new Error("Verified token secret must be at least 32 bytes.");
  return buf;
}

/**
 * Mints an HS256-signed verified bearer token compatible with
 * `createVerifiedTokenAuthenticator`.
 */
export function issueVerifiedToken(
  claims: VerifiedTokenClaims,
  secret: string | Uint8Array,
): string {
  const key = toSecretKey(secret);
  if (!claims.sub || claims.sub.length > 256)
    throw new Error("Token subject (sub) must be 1 to 256 characters.");
  if (!Number.isInteger(claims.exp) || claims.exp <= 0)
    throw new Error("Token expiration (exp) must be a positive integer.");
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", key)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * Production-capable HS256 JWT bearer authenticator. Validates signature in
 * constant time, enforces `exp`/`nbf`/`iss`/`aud`, and resolves team
 * membership either from verified claims or a host-side resolver.
 */
export function createVerifiedTokenAuthenticator(
  options: VerifiedTokenAuthenticatorOptions,
): Authenticator {
  const key = toSecretKey(options.secret);
  const skew = Math.max(0, options.clockSkewSeconds ?? 30);
  const nowSeconds =
    options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  return {
    async authenticate(bearerToken) {
      if (
        typeof bearerToken !== "string" ||
        bearerToken.length === 0 ||
        bearerToken.length > MAX_BEARER_LENGTH
      )
        return null;
      const parts = bearerToken.split(".");
      if (parts.length !== 3) return null;
      const [headerB64, payloadB64, sigB64] = parts;
      if (!headerB64 || !payloadB64 || !sigB64) return null;

      const headerBuf = base64UrlDecode(headerB64);
      const payloadBuf = base64UrlDecode(payloadB64);
      const sigBuf = base64UrlDecode(sigB64);
      if (!headerBuf || !payloadBuf || !sigBuf) return null;

      const expectedSig = createHmac("sha256", key)
        .update(`${headerB64}.${payloadB64}`)
        .digest();
      if (
        sigBuf.byteLength !== expectedSig.byteLength ||
        !timingSafeEqual(sigBuf, expectedSig)
      )
        return null;

      let header: unknown;
      let payload: unknown;
      try {
        header = JSON.parse(headerBuf.toString("utf8"));
        payload = JSON.parse(payloadBuf.toString("utf8"));
      } catch {
        return null;
      }
      if (
        typeof header !== "object" ||
        header === null ||
        (header as Record<string, unknown>).alg !== "HS256"
      )
        return null;
      if (typeof payload !== "object" || payload === null) return null;

      const record = payload as Record<string, unknown>;
      const sub = record.sub;
      const exp = record.exp;
      const nbf = record.nbf;
      if (typeof sub !== "string" || sub.length === 0 || sub.length > 256)
        return null;
      if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
      const now = nowSeconds();
      if (now - skew >= exp) return null;
      if (nbf !== undefined) {
        if (typeof nbf !== "number" || !Number.isFinite(nbf)) return null;
        if (now + skew < nbf) return null;
      }
      if (options.issuer !== undefined && record.iss !== options.issuer)
        return null;
      if (options.audience !== undefined && record.aud !== options.audience)
        return null;

      const teams = options.resolveTeams
        ? await options.resolveTeams(sub)
        : Array.isArray(record.team_ids) &&
            record.team_ids.every((t): t is string => typeof t === "string")
          ? record.team_ids
          : [];
      return freezeUser(sub, teams);
    },
  };
}

export interface GitHubUserProfile {
  readonly id: number;
  readonly login: string;
}

export interface GitHubAuthenticatorOptions {
  /** Base URL of the GitHub REST API (default `https://api.github.com`). */
  readonly apiBaseUrl?: string;
  /**
   * Resolves which teams an authenticated GitHub user may access. Return an
   * empty array to deny access.
   */
  readonly resolveTeams: (
    profile: GitHubUserProfile,
    userId: string,
  ) => readonly string[] | Promise<readonly string[]>;
  /**
   * Maps a verified GitHub profile to a MARS `user_id` (default: lowercase
   * GitHub login; use `(p) => \`gh_${p.id}\`` for reassignment-safe numeric IDs).
   */
  readonly mapUserId?: (profile: GitHubUserProfile) => string;
  /** Optional allowlist of GitHub logins (case-insensitive). */
  readonly allowedLogins?: readonly string[];
  /** Optional allowlist of immutable numeric GitHub account IDs. */
  readonly allowedIds?: readonly number[];
  /** HTTP request timeout in milliseconds (default 5000). */
  readonly timeoutMs?: number;
  /** Positive-cache TTL in milliseconds keyed by token SHA-256 (default 60000; 0 disables). */
  readonly cacheTtlMs?: number;
  /** Maximum cached token digests (default 1024). */
  readonly maxCacheEntries?: number;
  /** Clock in milliseconds (tests inject). */
  readonly nowMs?: () => number;
  /** Fetch implementation (tests inject for offline verification). */
  readonly fetch?: typeof fetch;
}

/**
 * GitHub OAuth / personal access token authenticator. Verifies the bearer
 * token against GitHub's `/user` endpoint, checks team membership via
 * `resolveTeams`, and caches verified identities by SHA-256 token digest
 * (never retaining plaintext tokens). Fails closed on any network or API error.
 */
export function createGitHubAuthenticator(
  options: GitHubAuthenticatorOptions,
): Authenticator {
  const apiBase = (options.apiBaseUrl ?? "https://api.github.com").replace(
    /\/+$/,
    "",
  );
  const parsedUrl = new URL(`${apiBase}/user`);
  if (
    parsedUrl.protocol !== "https:" &&
    !(
      parsedUrl.protocol === "http:" &&
      (parsedUrl.hostname === "127.0.0.1" ||
        parsedUrl.hostname === "localhost" ||
        parsedUrl.hostname === "::1")
    )
  )
    throw new Error(
      "GitHub authenticator apiBaseUrl must use https (or http on loopback).",
    );

  const timeoutMs = Math.max(250, options.timeoutMs ?? 5000);
  const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 60_000);
  const maxCacheEntries = Math.max(1, options.maxCacheEntries ?? 1024);
  const nowMs = options.nowMs ?? (() => Date.now());
  const doFetch = options.fetch ?? fetch;
  const mapUserId =
    options.mapUserId ??
    ((profile: GitHubUserProfile) => profile.login.toLowerCase());
  const allowed = options.allowedLogins
    ? new Set(options.allowedLogins.map((l) => l.toLowerCase()))
    : null;
  const allowedIdSet = options.allowedIds ? new Set(options.allowedIds) : null;

  const cache = new Map<
    string,
    { user: AuthenticatedUser; expiresAt: number }
  >();

  return {
    async authenticate(bearerToken) {
      if (
        typeof bearerToken !== "string" ||
        bearerToken.length < 10 ||
        bearerToken.length > MAX_BEARER_LENGTH ||
        /[\r\n\s]/.test(bearerToken)
      )
        return null;

      const tokenHash = digest(bearerToken).toString("hex");
      const now = nowMs();
      if (cacheTtlMs > 0) {
        const cached = cache.get(tokenHash);
        if (cached) {
          if (cached.expiresAt > now) return cached.user;
          cache.delete(tokenHash);
        }
      }

      let response: Response;
      try {
        response = await doFetch(parsedUrl.toString(), {
          method: "GET",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${bearerToken}`,
            "User-Agent": "mars-team-chat",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return null;
      }

      if (response.status !== 200) return null;
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return null;
      }
      if (typeof body !== "object" || body === null) return null;
      const record = body as Record<string, unknown>;
      if (
        typeof record.id !== "number" ||
        !Number.isInteger(record.id) ||
        record.id <= 0 ||
        typeof record.login !== "string" ||
        !GITHUB_LOGIN_PATTERN.test(record.login)
      )
        return null;

      const profile: GitHubUserProfile = Object.freeze({
        id: record.id,
        login: record.login,
      });
      if (allowedIdSet && !allowedIdSet.has(profile.id)) return null;
      if (allowed && !allowed.has(profile.login.toLowerCase())) return null;

      const userId = mapUserId(profile);
      const teams = await options.resolveTeams(profile, userId);
      const user = freezeUser(userId, teams);
      if (!user) return null;

      if (cacheTtlMs > 0) {
        if (cache.size >= maxCacheEntries) {
          const oldestKey = cache.keys().next().value;
          if (oldestKey !== undefined) cache.delete(oldestKey);
        }
        cache.set(tokenHash, { user, expiresAt: now + cacheTtlMs });
      }
      return user;
    },
  };
}

/**
 * Tries authenticators in order and returns the first verified identity.
 * Useful for combining a production provider (GitHub OAuth or verified JWT)
 * with a local-dev fallback when explicitly configured.
 */
export function createCompositeAuthenticator(
  authenticators: readonly Authenticator[],
): Authenticator {
  const list = [...authenticators];
  return {
    async authenticate(bearerToken) {
      for (const auth of list) {
        const user = await auth.authenticate(bearerToken);
        if (user) return user;
      }
      return null;
    },
  };
}
