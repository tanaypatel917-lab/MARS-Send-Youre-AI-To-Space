import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadHostChecks } from "@mars/workbench";
import { startLocalWorkbench } from "../src/main/local-workbench";
import {
  projectChecksFile,
  removeProjectChecks,
  saveProjectChecks,
  suggestProjectChecks,
} from "../src/main/project-verification";
import { ResultSchema } from "../src/main/protocol";

let root: string;
let source: string;
let approvals: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mars-project-checks-")));
  source = join(root, "checkout");
  approvals = join(root, "approvals");
  await mkdir(source);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("detects supported scripts without enabling them and persists only those approved", async () => {
  const manifest = JSON.stringify({
    scripts: {
      test: "bun test",
      lint: "echo lint",
      typecheck: "",
      deploy: "echo deploy",
    },
  });
  await writeFile(join(source, "package.json"), manifest);
  const candidate = await suggestProjectChecks(source);
  expect(candidate?.checks).toEqual([
    { name: "test", steps: [{ name: "test", command: "bun test" }] },
    { name: "lint", steps: [{ name: "lint", command: "echo lint" }] },
  ]);
  expect(await projectChecksFile(approvals, source)).toBeUndefined();
  if (!candidate) throw new Error("Missing proposal");
  await expect(
    saveProjectChecks(approvals, source, candidate, new Set()),
  ).rejects.toThrow();
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ scripts: { test: "true" } }),
  );
  await saveProjectChecks(
    approvals,
    source,
    candidate,
    new Set(["test", "deploy"]),
  );
  const path = await projectChecksFile(approvals, source);
  if (!path) throw new Error("Missing saved checks");
  const checks = await loadHostChecks(path);
  expect(checks.map(({ id, argv }) => ({ id, argv }))).toEqual([
    {
      id: "project-test",
      argv: ["bun", "run", "--no-env-file", "--no-install", "test"],
    },
  ]);
  const overlay = checks[0]?.protected_files[0];
  expect(overlay?.path).toBe("package.json");
  expect(await readFile(overlay?.source ?? "", "utf8")).toBe(manifest);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(overlay?.source ?? "")).mode & 0o777).toBe(0o600);
  await removeProjectChecks(approvals, source);
  expect(await projectChecksFile(approvals, source)).toBeUndefined();
});

test("proposes lifecycle scripts in the same order Bun runs them", async () => {
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      scripts: {
        pretest: "echo before",
        test: "echo during",
        posttest: "echo after",
        prelint: "x".repeat(1001),
        lint: "echo lint",
      },
    }),
  );
  expect((await suggestProjectChecks(source))?.checks).toEqual([
    {
      name: "test",
      steps: [
        { name: "pretest", command: "echo before" },
        { name: "test", command: "echo during" },
        { name: "posttest", command: "echo after" },
      ],
    },
  ]);
  const result = Bun.spawnSync(
    [process.execPath, "run", "--no-env-file", "--no-install", "test"],
    { cwd: source },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("before\nduring\nafter\n");
});

test("does not read symlink manifests or transfer approvals to a replacement checkout", async () => {
  const manifest = JSON.stringify({ scripts: { test: "bun test" } });
  const external = join(root, "external.json");
  const packagePath = join(source, "package.json");
  await writeFile(external, manifest);
  await symlink(external, packagePath);
  expect(await suggestProjectChecks(source)).toBeUndefined();
  await rm(packagePath);
  await writeFile(packagePath, manifest);
  const candidate = await suggestProjectChecks(source);
  if (!candidate) throw new Error("Missing proposal");
  await saveProjectChecks(approvals, source, candidate, new Set(["test"]));
  await rename(source, join(root, "old-checkout"));
  await mkdir(source);
  await writeFile(packagePath, manifest);
  expect(await projectChecksFile(approvals, source)).toBeUndefined();
  await expect(
    saveProjectChecks(approvals, source, candidate, new Set(["test"])),
  ).rejects.toThrow("same folder");
});

test("the local workbench advertises approved checks and reports when Docker is unavailable", async () => {
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ scripts: { test: "bun test" } }),
  );
  const candidate = await suggestProjectChecks(source);
  if (!candidate) throw new Error("Missing proposal");
  const resources = join(root, "resources");
  await mkdir(resources);
  await symlink(process.execPath, join(resources, "bun"));
  await symlink(resolve("apps"), join(resources, "apps"));
  await saveProjectChecks(approvals, source, candidate, new Set(["test"]));
  const other = join(root, "other");
  await mkdir(other);
  for (const project of [source, other]) {
    const workbench = startLocalWorkbench({
      resources,
      source: project,
      state: join(root, "Application Support", "state"),
      projectVerificationRoot: approvals,
      dockerPath: join(root, "missing-docker"),
    });
    try {
      const connection = await workbench.connection();
      if (!connection.ok) throw new Error(connection.reason);
      const response = await fetch(`${connection.connection.url}/v1/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.connection.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ method: "workbench.describe", params: {} }),
      });
      const payload = ResultSchema["workbench.describe"].parse(
        (await response.json()).result,
      );
      if (project === source) {
        expect(payload.checks?.map(({ id }) => id)).toEqual(["project-test"]);
        expect(payload.verification_readiness?.reason).toBe(
          "Docker CLI is not installed or executable",
        );
      } else {
        expect(payload.checks ?? []).toEqual([]);
        expect(payload.verification_readiness).toBeUndefined();
      }
    } finally {
      await workbench.stop();
    }
  }
});
