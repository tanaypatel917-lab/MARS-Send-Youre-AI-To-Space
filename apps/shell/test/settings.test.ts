import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_WINDOW_LAYOUT,
  layoutPath,
  loadWindowLayout,
  saveWindowLayout,
} from "../src/main/settings";

test("layout persistence is bounded, private, and defaults on missing or invalid data", async () => {
  const home = await mkdtemp(join(tmpdir(), "mars-shell-settings-"));
  const path = layoutPath(home);
  expect(path).toBe(join(home, ".mars", "shell", "layout.json"));
  expect(await loadWindowLayout(path)).toEqual(DEFAULT_WINDOW_LAYOUT);
  await saveWindowLayout(path, { width: 1440, height: 900 });
  expect(await loadWindowLayout(path)).toEqual({ width: 1440, height: 900 });
  expect((await stat(join(home, ".mars", "shell"))).mode & 0o777).toBe(0o700);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await expect(
    saveWindowLayout(path, { width: 40, height: 900 }),
  ).rejects.toThrow();
  await writeFile(
    path,
    JSON.stringify({ schema_version: 1, window: { width: 20, height: 20 } }),
  );
  await chmod(path, 0o600);
  expect(await loadWindowLayout(path)).toEqual(DEFAULT_WINDOW_LAYOUT);
  expect(JSON.parse(await readFile(path, "utf8")).window.width).toBe(20);
});
