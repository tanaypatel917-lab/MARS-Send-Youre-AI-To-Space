import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpPackageStore } from "./package-store";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "mars-package-"));
  cleanup.push(base);
  const src = join(base, "src"),
    directory = join(base, "store");
  await mkdir(src);
  return {
    src,
    base,
    directory,
    store: new McpPackageStore({ directory, workspaceRoots: [src] }),
  };
}

test("installs the same private revision once and preserves layout and modes", async () => {
  const { src, directory, store } = await fixture();
  await mkdir(join(src, "lib"));
  await writeFile(join(src, "lib", "entry"), "original", { mode: 0o700 });
  await symlink("lib/entry", join(src, "main"));
  const data = join(src, "database");
  await writeFile(data, "user data");
  const a = await store.inspect({ path: src, exclude: [data] });
  await Promise.all([a.install(), a.install()]);
  const before = await lstat(join(a.directory, "lib/entry"));
  expect(before.mode & 0o777).toBe(0o500);
  await writeFile(data, "new data");
  const b = await store.inspect({ path: src, exclude: [data] });
  await b.install();
  expect(b.sha).toBe(a.sha);
  expect((await lstat(join(b.directory, "lib/entry"))).ino).toBe(before.ino);
  expect((await readdir(b.directory)).sort()).toEqual(["lib", "main"]);
  await writeFile(join(src, "lib/entry"), "changed");
  expect(await readFile(join(a.directory, "main"), "utf8")).toBe("original");
  expect((await store.inspect({ path: src, exclude: [data] })).sha).not.toBe(
    a.sha,
  );
  expect(await readdir(directory)).toEqual([a.sha]);
});

test("live SQLite journals next to a data file do not change the program revision", async () => {
  const { src, store } = await fixture();
  const path = join(src, "user.db");
  const inspect = () => store.inspect({ path: src, exclude: [path] });
  const program = join(src, "user.db-wal.js");
  await writeFile(program, "v1");
  const before = await inspect();
  const db = new Database(path, { create: true });
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE notes(body);");
    expect(await readdir(src)).toEqual(
      expect.arrayContaining(["user.db-wal", "user.db-shm"]),
    );
    const active = await inspect();
    expect(active.sha).toBe(before.sha);
    await active.install();
    expect(await readdir(active.directory)).toEqual(["user.db-wal.js"]);
    db.exec("INSERT INTO notes VALUES (1)");
    expect((await inspect()).sha).toBe(before.sha);
    db.exec("PRAGMA journal_mode=DELETE; BEGIN; INSERT INTO notes VALUES (2);");
    expect(await readdir(src)).toContain("user.db-journal");
    expect((await inspect()).sha).toBe(before.sha);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  expect((await inspect()).sha).toBe(before.sha);
  await writeFile(program, "v2");
  expect((await inspect()).sha).not.toBe(before.sha);
});

test("a link into an excluded folder cannot publish a broken package", async () => {
  const { src, store } = await fixture();
  const data = join(src, "data");
  await mkdir(data);
  await writeFile(join(data, "record"), "mutable");
  await symlink("data/record", join(src, "alias"));
  await expect(store.inspect({ path: src, exclude: [data] })).rejects.toThrow(
    "excluded data",
  );
});

test("data exclusions follow directory links before parent components", async () => {
  const { src, base, store } = await fixture();
  await mkdir(join(src, "nested"));
  await symlink(join(src, "nested"), join(base, "alias"));
  await writeFile(join(src, "record"), "mutable data");
  const rev = await store.inspect({
    path: src,
    exclude: [`${base}/alias/../record`],
  });
  await rev.install();
  expect(await readdir(rev.directory)).toEqual(["nested"]);
});

test("failed installs publish nothing and reclaim dead but not live staging directories", async () => {
  const { src, directory, store } = await fixture();
  const file = join(src, "entry");
  await writeFile(file, "v1");
  const rev = await store.inspect({ path: file });
  const live = `.stage-${process.pid}-live`;
  await mkdir(join(directory, live));
  await mkdir(join(directory, ".stage-2147483647-dead"));
  await writeFile(file, "v2");
  await expect(rev.install()).rejects.toMatchObject({ code: "drift" });
  expect(await readdir(directory)).toEqual([live]);
});

test("rejects unsafe locations, broad store permissions and links outside a package", async () => {
  const { src, base, directory, store } = await fixture();
  const link = join(base, "alias");
  await symlink(src, link);
  await expect(
    new McpPackageStore({
      directory: join(link, "packages"),
      workspaceRoots: [src],
    }).inspect({ path: src }),
  ).rejects.toMatchObject({ code: "store_location_unsafe" });
  await mkdir(directory);
  await chmod(directory, 0o755);
  await expect(store.inspect({ path: src })).rejects.toMatchObject({
    code: "store_location_unsafe",
  });
  await chmod(directory, 0o700);
  await symlink(base, join(src, "escape"));
  await expect(store.inspect({ path: src })).rejects.toThrow(
    "leaves the selected folder",
  );
});
