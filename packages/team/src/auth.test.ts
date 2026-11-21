import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCompositeAuthenticator,
  createGitHubAuthenticator,
  createVerifiedTokenAuthenticator,
  issueVerifiedToken,
} from "./auth";
import { createTeamStore } from "./store";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mars-team-auth-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("verified token authenticator", () => {
  const secret = "test-hmac-secret-at-least-32-bytes-long!!";

  test("issues and verifies HS256 tokens with server-derived team membership", async () => {
    const store = createTeamStore({ rootDir: join(tempDir(), "store") });
    try {
      store.setTeamMember({
        team_id: "team_alpha",
        user_id: "user_ada",
        role: "admin",
      });
      store.setTeamMember({
        team_id: "team_beta",
        user_id: "user_ada",
        role: "member",
      });
      store.setTeamMember({
        team_id: "team_alpha",
        user_id: "user_grace",
        role: "member",
      });
      store.removeTeamMember({ team_id: "team_beta", user_id: "user_ada" });

      expect(store.activeTeamIds("user_ada")).toEqual(["team_alpha"]);
      expect(store.activeTeamIds("user_grace")).toEqual(["team_alpha"]);
      expect(store.activeTeamIds("user_unknown")).toEqual([]);

      const now = 1_700_000_000;
      const token = issueVerifiedToken(
        {
          sub: "user_ada",
          exp: now + 600,
          iss: "mars-team",
          aud: "team-chat",
        },
        secret,
      );

      const auth = createVerifiedTokenAuthenticator({
        secret,
        issuer: "mars-team",
        audience: "team-chat",
        nowSeconds: () => now,
        resolveTeams: (userId) => store.activeTeamIds(userId),
      });

      const principal = await auth.authenticate(token);
      expect(principal).toEqual({
        user_id: "user_ada",
        team_ids: ["team_alpha"],
      });
    } finally {
      store.close();
    }
  });

  test("rejects expired, tampered, wrong-issuer, and wrong-audience tokens", async () => {
    const now = 1_700_000_000;
    const auth = createVerifiedTokenAuthenticator({
      secret,
      issuer: "mars-team",
      audience: "team-chat",
      nowSeconds: () => now,
    });

    const valid = issueVerifiedToken(
      {
        sub: "user_ada",
        team_ids: ["team_alpha"],
        exp: now + 60,
        iss: "mars-team",
        aud: "team-chat",
      },
      secret,
    );
    expect(await auth.authenticate(valid)).toEqual({
      user_id: "user_ada",
      team_ids: ["team_alpha"],
    });

    // Tampered signature
    const parts = valid.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]?.slice(0, -2)}aa`;
    expect(await auth.authenticate(tampered)).toBeNull();

    // Wrong secret
    const wrongSecret = issueVerifiedToken(
      {
        sub: "user_ada",
        team_ids: ["team_alpha"],
        exp: now + 60,
        iss: "mars-team",
        aud: "team-chat",
      },
      "different-secret-that-must-fail-verification",
    );
    expect(await auth.authenticate(wrongSecret)).toBeNull();

    // Expired
    const expired = issueVerifiedToken(
      {
        sub: "user_ada",
        team_ids: ["team_alpha"],
        exp: now - 120,
        iss: "mars-team",
        aud: "team-chat",
      },
      secret,
    );
    expect(await auth.authenticate(expired)).toBeNull();

    // Wrong issuer
    const wrongIss = issueVerifiedToken(
      {
        sub: "user_ada",
        team_ids: ["team_alpha"],
        exp: now + 60,
        iss: "other-issuer",
        aud: "team-chat",
      },
      secret,
    );
    expect(await auth.authenticate(wrongIss)).toBeNull();

    // Wrong audience
    const wrongAud = issueVerifiedToken(
      {
        sub: "user_ada",
        team_ids: ["team_alpha"],
        exp: now + 60,
        iss: "mars-team",
        aud: "wrong-aud",
      },
      secret,
    );
    expect(await auth.authenticate(wrongAud)).toBeNull();
  });
});

describe("GitHub OAuth authenticator", () => {
  test("verifies bearer token against GitHub /user, caches by digest, and enforces allowlist", async () => {
    let fetchCount = 0;
    let now = 1_700_000_000_000;
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCount++;
      expect(String(input)).toBe("https://api.github.com/user");
      const headers = new Headers(init?.headers);
      const authHeader = headers.get("authorization");
      if (authHeader === "Bearer gho_valid_ada") {
        return new Response(
          JSON.stringify({ id: 101, login: "ada", name: "Ada Lovelace" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (authHeader === "Bearer gho_blocked_mallory") {
        return new Response(JSON.stringify({ id: 666, login: "mallory" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;

    const auth = createGitHubAuthenticator({
      fetch: mockFetch,
      nowMs: () => now,
      cacheTtlMs: 30_000,
      allowedLogins: ["ada"],
      resolveTeams: (profile) =>
        profile.login === "ada" ? ["team_alpha"] : [],
    });

    const first = await auth.authenticate("gho_valid_ada");
    expect(first).toEqual({ user_id: "ada", team_ids: ["team_alpha"] });
    expect(fetchCount).toBe(1);

    // Cached within TTL
    const second = await auth.authenticate("gho_valid_ada");
    expect(second).toEqual({ user_id: "ada", team_ids: ["team_alpha"] });
    expect(fetchCount).toBe(1);

    // Re-fetches after TTL expires
    now += 31_000;
    const third = await auth.authenticate("gho_valid_ada");
    expect(third).toEqual({ user_id: "ada", team_ids: ["team_alpha"] });
    expect(fetchCount).toBe(2);

    // Non-allowlisted GitHub user is rejected
    expect(await auth.authenticate("gho_blocked_mallory")).toBeNull();
    // Invalid token fails closed
    expect(await auth.authenticate("gho_invalid")).toBeNull();
  });

  test("rejects non-HTTPS non-loopback apiBaseUrl", () => {
    expect(() =>
      createGitHubAuthenticator({
        apiBaseUrl: "http://evil.example.com",
        resolveTeams: () => [],
      }),
    ).toThrow(/https/i);
  });

  test("composite authenticator tries providers in order", async () => {
    const secret = "composite-test-secret-with-enough-entropy";
    const now = 1_700_000_000;
    const jwtAuth = createVerifiedTokenAuthenticator({
      secret,
      nowSeconds: () => now,
    });
    const fallbackAuth = {
      async authenticate(token: string) {
        return token === "dev_token"
          ? { user_id: "user_dev", team_ids: ["team_dev"] }
          : null;
      },
    };

    const composite = createCompositeAuthenticator([jwtAuth, fallbackAuth]);
    const jwt = issueVerifiedToken(
      {
        sub: "user_ada",
        team_ids: ["team_alpha"],
        exp: now + 60,
      },
      secret,
    );

    expect(await composite.authenticate(jwt)).toEqual({
      user_id: "user_ada",
      team_ids: ["team_alpha"],
    });
    expect(await composite.authenticate("dev_token")).toEqual({
      user_id: "user_dev",
      team_ids: ["team_dev"],
    });
    expect(await composite.authenticate("unknown")).toBeNull();
  });
});
