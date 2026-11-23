import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verificationStateRoot } from "../src/main/verification-state";

test("verification state keeps a safe root", async () => {
  expect(await verificationStateRoot("/safe/state", "/home/user")).toEqual({
    state: "/safe/state",
  });
});

test("unsafe macOS-style state uses a private space-free home fallback", async () => {
  const home = await mkdtemp(join(tmpdir(), "mars-safe-home-"));
  try {
    const selected = await verificationStateRoot(
      "/Users/user/Library/Application Support/MARS/projects",
      home,
    );
    expect(selected.state).toBe(join(home, ".mars", "desktop-workbench"));
    expect(selected.reason).toBeUndefined();
    expect((await stat(selected.state)).mode & 0o777).toBe(0o700);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("unsafe state and home keep browsing available but disable verification with a reason", async () => {
  const state = "/Users/user/Library/Application Support/MARS/projects";
  expect(await verificationStateRoot(state, "/Users/User Name")).toMatchObject({
    state,
    reason: expect.stringContaining("without spaces or special characters"),
  });
});
