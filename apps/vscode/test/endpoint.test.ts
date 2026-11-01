import { describe, expect, test } from "bun:test";
import {
  checkServerUrl,
  DEFAULT_SERVER_URL,
  isLoopbackHost,
} from "../src/endpoint";

describe("checkServerUrl", () => {
  test("accepts the loopback default and builds the RPC URL", () => {
    const result = checkServerUrl(DEFAULT_SERVER_URL, false);
    expect(result).toEqual({
      ok: true,
      rpcUrl: "http://127.0.0.1:7331/v1/rpc",
      origin: "http://127.0.0.1:7331",
      loopback: true,
    });
    expect(checkServerUrl("http://localhost:7331/mars/", false)).toMatchObject({
      ok: true,
      rpcUrl: "http://localhost:7331/mars/v1/rpc",
    });
    expect(checkServerUrl("http://[::1]:7331", false).ok).toBe(true);
  });

  test("rejects non-loopback hosts unless explicitly allowed, and then only over https", () => {
    expect(checkServerUrl("https://mars.example.com", false).ok).toBe(false);
    expect(checkServerUrl("http://mars.example.com", true).ok).toBe(false);
    expect(checkServerUrl("https://mars.example.com", true)).toMatchObject({
      ok: true,
      loopback: false,
    });
    expect(checkServerUrl("http://127.0.0.1.evil.com", false).ok).toBe(false);
    expect(checkServerUrl("http://0.0.0.0:7331", false).ok).toBe(false);
  });

  test("rejects credentials, query, fragment and other schemes", () => {
    for (const raw of [
      "http://user:pw@127.0.0.1:7331",
      "http://127.0.0.1:7331/?x=1",
      "http://127.0.0.1:7331/#frag",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "command:workbench.action.terminal.new",
      "not a url",
    ])
      expect(checkServerUrl(raw, true).ok).toBe(false);
  });

  test("isLoopbackHost", () => {
    expect(isLoopbackHost("127.10.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.256")).toBe(false);
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
  });
});
