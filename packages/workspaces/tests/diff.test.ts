import { expect, test } from "bun:test";
import { createWorkspaceDiff } from "../src/diff";
import { sha256, type TreeFile } from "../src/tree";

const file = (
  path: string,
  bytes: number[],
  mode: 420 | 493 = 420,
): TreeFile => {
  const data = Uint8Array.from(bytes);
  return { path, mode, size: data.byteLength, sha256: sha256(data), data };
};

test("binary patches record both content hashes so different bytes never render the same patch", () => {
  const base = [file("image.png", [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])];
  const versionA = [file("image.png", [0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9])];
  const versionB = [file("image.png", [0x89, 0x50, 0x4e, 0x47, 0, 8, 8, 8])];
  const a = createWorkspaceDiff(base, versionA).files[0];
  const b = createWorkspaceDiff(base, versionB).files[0];
  expect(a?.status).toBe("modified");
  expect(a?.patch).toContain("Binary files a/image.png and b/image.png differ");
  expect(a?.patch).toContain(
    `index ${base[0]?.sha256}..${versionA[0]?.sha256}\n`,
  );
  expect(a?.patch).not.toBe(b?.patch);
  const added = createWorkspaceDiff([], versionA).files[0];
  const addedB = createWorkspaceDiff([], versionB).files[0];
  expect(added?.patch).toContain(
    `index ${"0".repeat(64)}..${versionA[0]?.sha256}\n`,
  );
  expect(added?.patch).not.toBe(addedB?.patch);
  const deleted = createWorkspaceDiff(base, []).files[0];
  expect(deleted?.patch).toContain(
    `index ${base[0]?.sha256}..${"0".repeat(64)}\n`,
  );
  expect(createWorkspaceDiff(base, base).files).toEqual([]);
});
