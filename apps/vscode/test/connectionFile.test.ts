import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ImportHost,
  importConnection,
  MAX_CONNECTION_FILE_BYTES,
  parseConnectionFile,
  readConnectionFile,
} from "../src/connectionFile";

const TOKEN = "dummyTokenNotReal_0123456789-abcdefghijklmn"; // 43 chars, fake
const SCOPE = { owner_id: "owner-1", project_id: "project-1" };
const enc = (value: unknown) =>
  new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  );
const valid = {
  schema_version: 1,
  url: "http://127.0.0.1:7331",
  token: TOKEN,
  scope: SCOPE,
};

function reason(value: unknown): string {
  const result = parseConnectionFile(enc(value));
  if (result.ok) throw new Error("expected rejection");
  expect(result.reason).not.toContain(TOKEN);
  return result.reason;
}

describe("parseConnectionFile", () => {
  test("accepts the exact mars serve shape and normalizes the URL", () => {
    expect(parseConnectionFile(enc(valid))).toEqual({
      ok: true,
      connection: { url: "http://127.0.0.1:7331", token: TOKEN, scope: SCOPE },
    });
    for (const url of ["http://localhost:9000/", "http://[::1]:7331"]) {
      const result = parseConnectionFile(enc({ ...valid, url }));
      expect(result.ok).toBe(true);
    }
  });

  test("rejects extra, missing or wrongly typed keys", () => {
    expect(reason({ ...valid, extra: 1 })).toContain("exactly");
    expect(
      reason({ ...valid, scope: { ...SCOPE, workspace_id: "w" } }),
    ).toContain("exactly");
    const { token: _t, ...noToken } = valid;
    expect(reason(noToken)).toContain("exactly");
    expect(reason({ ...valid, schema_version: 2 })).toContain("exactly");
    expect(
      reason({ ...valid, scope: { owner_id: "", project_id: "p" } }),
    ).toContain("exactly");
    expect(reason([valid])).toContain("exactly");
    expect(
      reason(`{"__proto__":{"x":1},${JSON.stringify(valid).slice(1)}`),
    ).toContain("exactly");
  });

  test("enforces the token format", () => {
    for (const token of [
      "short",
      `${TOKEN}=`,
      "a".repeat(257),
      `${TOKEN.slice(1)} `,
    ])
      expect(reason({ ...valid, token })).toContain("token");
    expect(
      parseConnectionFile(enc({ ...valid, token: "a".repeat(32) })).ok,
    ).toBe(true);
  });

  test("requires a root HTTP loopback URL", () => {
    for (const url of [
      "https://127.0.0.1:7331",
      "http://example.com:7331",
      "http://10.0.0.1:7331",
      "http://127.0.0.1.nip.io",
      "http://user:pw@127.0.0.1:7331",
      "http://127.0.0.1:7331/api",
      "http://127.0.0.1:7331/?a=1",
      "http://127.0.0.1:7331/#x",
      "http://127.0.0.1:7331?",
      "file:///etc/passwd",
      "not a url",
    ])
      expect(reason({ ...valid, url })).toMatch(/url/);
  });

  test("rejects oversized, non-UTF-8 and non-JSON input without echoing it", () => {
    const big = new Uint8Array(MAX_CONNECTION_FILE_BYTES + 1).fill(0x20);
    expect(parseConnectionFile(big)).toEqual({
      ok: false,
      reason: "Connection file is larger than 16 KiB.",
    });
    expect(parseConnectionFile(new Uint8Array([0xff, 0xfe]))).toMatchObject({
      ok: false,
      reason: "Connection file is not valid UTF-8.",
    });
    expect(reason(`{"token":"${TOKEN}"`)).toBe(
      "Connection file is not valid JSON.",
    );
  });
});

describe("readConnectionFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "mars-conn-"));
  const file = (name: string, body: string | Uint8Array, mode = 0o600) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, mode);
    return path;
  };

  test("reads a private regular file", async () => {
    const result = await readConnectionFile(
      file("ok.json", JSON.stringify(valid)),
    );
    expect(result.ok && parseConnectionFile(result.bytes).ok).toBe(true);
  });

  test("rejects group/other-accessible files on POSIX only", async () => {
    const path = file("open.json", JSON.stringify(valid), 0o644);
    expect((await readConnectionFile(path)).ok).toBe(false);
    expect((await readConnectionFile(path, undefined, "win32")).ok).toBe(true);
  });

  test("rejects oversized files, directories, symlinks and missing paths", async () => {
    const big = file("big.json", new Uint8Array(MAX_CONNECTION_FILE_BYTES + 1));
    expect(await readConnectionFile(big)).toEqual({
      ok: false,
      reason: "Connection file is larger than 16 KiB.",
    });
    const sub = join(dir, "sub");
    mkdirSync(sub, { mode: 0o700 });
    expect((await readConnectionFile(sub)).ok).toBe(false);
    const link = join(dir, "link.json");
    symlinkSync(file("target.json", JSON.stringify(valid)), link);
    expect((await readConnectionFile(link)).ok).toBe(false);
    expect((await readConnectionFile(join(dir, "missing.json"))).ok).toBe(
      false,
    );
  });
});

function fakeHost(
  overrides: Partial<ImportHost> & {
    file?: unknown;
    token?: string;
    url?: string;
  } = {},
) {
  const state = {
    token: overrides.token,
    url: overrides.url,
    confirms: [] as string[],
    answer: true,
  };
  const host: ImportHost = {
    pickFile: async () => "/tmp/connection.json",
    readFile: async () => ({ ok: true, bytes: enc(overrides.file ?? valid) }),
    globalServerUrl: () => state.url,
    getToken: async () => state.token,
    storeToken: async (token) => {
      state.token = token;
    },
    deleteToken: async () => {
      state.token = undefined;
    },
    storeGlobalServerUrl: async (url) => {
      state.url = url;
    },
    confirm: async (message, detail) => {
      state.confirms.push(`${message}\n${detail}`);
      return state.answer;
    },
    ...overrides,
  };
  return { host, state };
}

describe("importConnection", () => {
  test("first import stores token and global URL without a prompt", async () => {
    const { host, state } = fakeHost();
    expect(await importConnection(host)).toEqual({
      status: "imported",
      url: "http://127.0.0.1:7331",
      scope: SCOPE,
    });
    expect(state).toMatchObject({ token: TOKEN, url: "http://127.0.0.1:7331" });
    expect(state.confirms).toEqual([]);
  });

  test("replacing an existing token or URL needs confirmation that never shows the token", async () => {
    const declined = fakeHost({
      token: "old-token-value",
      url: "http://127.0.0.1:9999",
    });
    declined.state.answer = false;
    expect(await importConnection(declined.host)).toEqual({
      status: "cancelled",
    });
    expect(declined.state).toMatchObject({
      token: "old-token-value",
      url: "http://127.0.0.1:9999",
    });
    const prompt = declined.state.confirms.join("\n");
    expect(prompt).toContain("http://127.0.0.1:9999 → http://127.0.0.1:7331");
    expect(prompt).not.toContain(TOKEN);
    expect(prompt).not.toContain("old-token-value");

    const accepted = fakeHost({ url: "http://127.0.0.1:9999" });
    expect((await importConnection(accepted.host)).status).toBe("imported");
    expect(accepted.state.confirms).toHaveLength(1);
    expect(accepted.state.url).toBe("http://127.0.0.1:7331");

    const same = fakeHost({ url: "http://127.0.0.1:7331/" });
    expect((await importConnection(same.host)).status).toBe("imported");
    expect(same.state.confirms).toEqual([]);
  });

  test("cancelled picker, unreadable or invalid files change nothing", async () => {
    const picker = fakeHost({ pickFile: async () => undefined });
    expect(await importConnection(picker.host)).toEqual({
      status: "cancelled",
    });
    const unreadable = fakeHost({
      readFile: async () => ({ ok: false, reason: "nope" }),
    });
    expect(await importConnection(unreadable.host)).toEqual({
      status: "rejected",
      reason: "nope",
    });
    const remote = fakeHost({ file: { ...valid, url: "http://example.com" } });
    const outcome = await importConnection(remote.host);
    expect(outcome.status).toBe("rejected");
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    for (const ctx of [picker, unreadable, remote])
      expect(ctx.state).toMatchObject({ token: undefined, url: undefined });
  });

  test("a failed URL save rolls the token back", async () => {
    const failing = fakeHost({
      token: "old-token-value",
      storeGlobalServerUrl: async () => {
        throw new Error(`boom ${TOKEN}`);
      },
    });
    const outcome = await importConnection(failing.host);
    expect(outcome.status).toBe("failed");
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    expect(failing.state.token).toBe("old-token-value");
    const fresh = fakeHost({
      storeGlobalServerUrl: async () => {
        throw new Error("boom");
      },
    });
    await importConnection(fresh.host);
    expect(fresh.state.token).toBeUndefined();
  });
});
