import { createHash, timingSafeEqual } from "node:crypto";

export interface AuthenticatedUser {
  readonly user_id: string;
  readonly team_ids: readonly string[];
}

/**
 * Resolves a bearer token to a user. The team service never accepts `user_id`
 * from the client; it is derived from this interface on every request. Which
 * real provider backs it (GitHub OAuth, an OIDC issuer, MARS-managed accounts)
 * is an owner decision; only the development provider below exists today.
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
const digest = (value: string) => createHash("sha256").update(value).digest();

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
