import { expect, test } from "bun:test";
import { resolve } from "node:path";

const entrypoint = resolve(import.meta.dir, "main.ts");
test("CLI doctor reports actual initialization and explicit limitations", async () => {
  const child = Bun.spawn([process.execPath, entrypoint, "doctor"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, errors, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(0);
  expect(errors).toBe("");
  const report = JSON.parse(output);
  expect(report.execution.session_initialized).toBe(true);
  expect(report.execution.model_requests).toBe(0);
  expect(report.limitations.join(" ")).toContain("not implemented");
}, 30_000);

test("CLI rejects unknown commands with a usage error", async () => {
  const child = Bun.spawn([process.execPath, entrypoint, "unknown"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, errors, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(2);
  expect(output).toBe("");
  expect(errors).toContain("<doctor|smoke|models|serve|render|commands>");
}, 30_000);
