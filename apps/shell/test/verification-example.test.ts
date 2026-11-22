import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadHostChecks } from "@mars/workbench";
import { ResultSchema } from "../src/main/protocol";
import {
  EXAMPLE_BUG,
  seedVerificationExample,
} from "../src/main/verification-example";

test("verification example preserves user data and rewrites private protected checks outside the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-example-"));
  try {
    const { source, checksFile } = await seedVerificationExample(root);
    expect(await readFile(join(source, "total.sh"), "utf8")).toBe(EXAMPLE_BUG);
    expect(await readFile(join(source, "README.md"), "utf8")).toContain(
      "Read + Write + Execute",
    );
    const checks = await loadHostChecks(checksFile);
    const protectedFile = checks[0]?.protected_files[0]?.source ?? "";
    expect(relative(source, protectedFile).startsWith("../")).toBe(true);
    expect((await stat(source)).mode & 0o777).toBe(0o700);
    expect((await stat(checksFile)).mode & 0o777).toBe(0o600);
    expect((await stat(protectedFile)).mode & 0o777).toBe(0o600);
    await writeFile(join(source, "total.sh"), "user edit");
    await writeFile(protectedFile, "tampered");
    await seedVerificationExample(root);
    expect(await readFile(join(source, "total.sh"), "utf8")).toBe("user edit");
    expect(await readFile(protectedFile, "utf8")).toContain(
      "amount totals passed",
    );
    expect(await loadHostChecks(checksFile)).toEqual(checks);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { dockerPath: undefined, verificationUnavailableReason: undefined },
  {
    dockerPath: "/missing-mars-docker",
    verificationUnavailableReason: undefined,
  },
  {
    dockerPath: undefined,
    verificationUnavailableReason:
      "Verification needs a private workspace path without spaces or special characters.",
  },
])(
  "runtime stdin start preserves checks and reports prerequisite readiness: %o",
  async ({ dockerPath, verificationUnavailableReason }) => {
    const root = await mkdtemp(join(tmpdir(), "mars-example-runtime-"));
    const seeded = await seedVerificationExample(root);
    const state = join(root, "state");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "apps/shell/src/runtime/workbench.ts",
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      child.stdin.write(
        `${JSON.stringify({ source: seeded.source, state, checksFile: seeded.checksFile, dockerPath, verificationUnavailableReason, ...(!verificationUnavailableReason ? { image: `mirror.gcr.io/library/busybox@sha256:${"0".repeat(64)}` } : {}) })}\n`,
      );
      const reader = child.stdout.getReader();
      let output = "";
      while (!output.includes("MARS_WORKBENCH_READY")) {
        const result = await reader.read();
        if (result.done)
          throw new Error(
            `Runtime exited: ${await new Response(child.stderr).text()}`,
          );
        output += new TextDecoder().decode(result.value);
      }
      reader.releaseLock();
      const connection = JSON.parse(
        await readFile(join(state, "connection.json"), "utf8"),
      );
      const response = await fetch(`${connection.url}/v1/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          method: "workbench.describe",
          params: {},
        }),
      });
      const body = (await response.json()) as { result: unknown };
      const described = ResultSchema["workbench.describe"].parse(body.result);
      expect(described.capabilities.execute).toBe(false);
      expect(described.checks?.[0]?.id).toBe("amount-totals");
      expect(described.verification_readiness?.status).toBe("unavailable");
      if (dockerPath)
        expect(described.verification_readiness?.reason).toBe(
          "Docker CLI is not installed or executable",
        );
      if (verificationUnavailableReason)
        expect(described.verification_readiness?.reason).toBe(
          verificationUnavailableReason,
        );
    } finally {
      child.stdin.end();
      child.kill();
      await child.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
