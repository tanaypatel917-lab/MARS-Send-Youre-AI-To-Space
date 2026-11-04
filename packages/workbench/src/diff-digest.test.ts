import { expect, test } from "bun:test";
import { diffDigest } from "./diff-digest";

const base = {
  files: [
    { path: "b.ts", status: "modified" as const, patch: "-a\n+b\n" },
    { path: "a.ts", status: "added" as const, patch: "+x\n" },
  ],
};

test("diff digest is stable for identical diffs, order-insensitive and LF-normalised", () => {
  const digest = diffDigest(base);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(diffDigest(structuredClone(base))).toBe(digest);
  expect(diffDigest({ files: [...base.files].reverse() })).toBe(digest);
  expect(
    diffDigest({
      files: base.files.map((file) => ({
        ...file,
        patch: file.patch.replaceAll("\n", "\r\n"),
      })),
    }),
  ).toBe(digest);
  expect(diffDigest({ files: [] })).not.toBe(digest);
});

test("diff digest changes on any byte of path, status or patch", () => {
  const digest = diffDigest(base);
  const variants = [
    { files: [base.files[0]!, { ...base.files[1]!, patch: "+y\n" }] },
    { files: [base.files[0]!, { ...base.files[1]!, path: "a.tsx" }] },
    {
      files: [
        base.files[0]!,
        { ...base.files[1]!, status: "modified" as const },
      ],
    },
    { files: [base.files[0]!] },
    { files: [base.files[0]!, { ...base.files[1]!, patch: "+x\n\n" }] },
  ];
  const digests = new Set(variants.map((variant) => diffDigest(variant)));
  expect(digests.size).toBe(variants.length);
  expect(digests.has(digest)).toBe(false);
  expect(() =>
    diffDigest({ files: [base.files[0]!, base.files[0]!] }),
  ).toThrow();
});
