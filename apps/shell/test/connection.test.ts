import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseConnectionFile,
  readConnectionFile,
  resolveConnection,
} from "../src/main/connection";

const token = "fixture-token-0123456789abcdefghijklmnopqrstuvwxyz";
const connection = {
  schema_version: 1,
  url: "http://127.0.0.1:7331/",
  token,
  scope: { owner_id: "owner", project_id: "project" },
};

async function writeConnection(path: string, value = connection, mode = 0o600) {
  await writeFile(path, JSON.stringify(value), { mode });
  await chmod(path, mode);
}

test("connection bytes enforce the schema, loopback root, UTF-8, and size limit", () => {
  expect(
    parseConnectionFile(new TextEncoder().encode(JSON.stringify(connection)))
      .ok,
  ).toBe(true);
  expect(
    parseConnectionFile(
      new TextEncoder().encode(JSON.stringify({ ...connection, extra: true })),
    ).ok,
  ).toBe(false);
  expect(
    parseConnectionFile(
      new TextEncoder().encode(
        JSON.stringify({ ...connection, url: "http://example.com/" }),
      ),
    ).ok,
  ).toBe(false);
  expect(
    parseConnectionFile(
      new TextEncoder().encode(
        JSON.stringify({ ...connection, url: "http://127.0.0.1/v1" }),
      ),
    ).ok,
  ).toBe(false);
  expect(parseConnectionFile(new Uint8Array([0xff])).ok).toBe(false);
  expect(parseConnectionFile(new Uint8Array(16 * 1024 + 1)).ok).toBe(false);
});

test("file reads reject broad permissions and symlinks; discovery handles none, one, and several", async () => {
  const home = await mkdtemp(join(tmpdir(), "mars-shell-connection-"));
  const base = join(home, ".mars", "workbench");
  const directory = join(base, "one");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "connection.json");
  await writeConnection(path, connection, 0o644);
  expect(await readConnectionFile(path)).toMatchObject({
    ok: false,
    reason: expect.stringContaining("chmod 600"),
  });
  await writeConnection(path);
  const link = join(directory, "connection-link.json");
  await symlink(path, link);
  expect(await readConnectionFile(link)).toMatchObject({ ok: false });

  const noneHome = join(home, "none");
  expect(
    await resolveConnection({ argv: [], env: {}, homeDir: noneHome }),
  ).toMatchObject({
    ok: false,
    reason: expect.stringContaining("No workbench"),
  });
  const one = await resolveConnection({ argv: [], env: {}, homeDir: home });
  expect(one.ok).toBe(true);
  if (one.ok) {
    expect(one.connection.scope).toEqual({
      owner_id: "owner",
      project_id: "project",
    });
  }
  await mkdir(join(base, "two"), { recursive: true });
  await writeConnection(join(base, "two", "connection.json"));
  expect(
    await resolveConnection({ argv: [], env: {}, homeDir: home }),
  ).toMatchObject({
    ok: false,
    reason: expect.stringContaining("Several workbench"),
  });
  expect(
    await resolveConnection({
      argv: [`--connection=${path}`],
      env: {},
      homeDir: noneHome,
    }),
  ).toMatchObject({ ok: true });
  expect(
    await readFile(path, "utf8").then((contents) =>
      parseConnectionFile(new TextEncoder().encode(contents)),
    ),
  ).toMatchObject({ ok: true });
});
