import { expect, test } from "bun:test";
import { delimiter } from "node:path";
import { resolveDockerPath } from "../src/main/docker-path";

const fallbacks = [
  "/usr/local/bin/docker",
  "/opt/homebrew/bin/docker",
  "/Applications/Docker.app/Contents/Resources/bin/docker",
  "/usr/bin/docker",
];

test("Docker resolution prefers the first executable on PATH over GUI fallbacks", () => {
  const visited: string[] = [];
  expect(
    resolveDockerPath({
      path: ["/missing", "/custom", "/other"].join(delimiter),
      isExecutable(candidate) {
        visited.push(candidate);
        return candidate !== "/missing/docker";
      },
    }),
  ).toBe("/custom/docker");
  expect(visited).toEqual(["/missing/docker", "/custom/docker"]);
});

test.each(fallbacks)(
  "Docker GUI fallback resolves executable %s in order",
  (available) => {
    const visited: string[] = [];
    expect(
      resolveDockerPath({
        path: "",
        isExecutable(candidate) {
          visited.push(candidate);
          return candidate === available;
        },
      }),
    ).toBe(available);
    expect(visited).toEqual(
      fallbacks.slice(0, fallbacks.indexOf(available) + 1),
    );
  },
);

test("Docker resolution returns unavailable when no candidate is executable", () => {
  expect(
    resolveDockerPath({ path: "/missing", isExecutable: () => false }),
  ).toBeUndefined();
});
