#!/usr/bin/env bun
/**
 * Offline stand-in for the `watch-skill` CLI. Behaviour comes from the JSON
 * scenario file named by FAKE_WATCH_SKILL_SCENARIO; every invocation (argv,
 * cwd, environment) is appended to FAKE_WATCH_SKILL_LOG so tests can assert
 * the sandbox contract. No network, no Python, no model.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

interface Rule {
  match: string[];
  exit?: number;
  stdout?: string;
  stderr?: string;
  sleep_ms?: number;
  /** Print stdout first, then hang this long before exiting (timeout tests). */
  hang_after_stdout_ms?: number;
  /** Written to <data>/loops/<loop_id>/state.json before exiting. */
  loop_state?: Record<string, unknown>;
}
interface Scenario {
  version?: string;
  doctor?: { ok: boolean; checks?: unknown[] };
  rules?: Rule[];
}

const scenarioPath = process.env.FAKE_WATCH_SKILL_SCENARIO;
const scenario: Scenario = scenarioPath
  ? (JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario)
  : {};
const args = process.argv.slice(2);
const dataDir = process.env.WATCHSKILL_DATA_DIR ?? "";

if (process.env.FAKE_WATCH_SKILL_LOG) {
  const contract =
    args[0] === "verify" && args[1] === "run" && args[2]
      ? readFileSync(args[2], "utf8")
      : null;
  appendFileSync(
    process.env.FAKE_WATCH_SKILL_LOG,
    `${JSON.stringify({ args, cwd: process.cwd(), env: process.env, contract })}\n`,
  );
}

function finish(code: number, stdout?: string, stderr?: string): never {
  if (stdout)
    process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  if (stderr) process.stderr.write(stderr);
  return process.exit(code);
}

if (args[0] === "version") finish(0, scenario.version ?? "1.4.3");
if (args[0] === "doctor") {
  const report = scenario.doctor ?? { ok: true, checks: [] };
  finish(report.ok ? 0 : 1, JSON.stringify(report));
}
const rule = (scenario.rules ?? []).find((candidate) =>
  candidate.match.every((part, index) => part === "*" || args[index] === part),
);
if (!rule) {
  finish(
    1,
    JSON.stringify({
      error: "fixture.unmatched",
      message: `no scenario rule for ${args.join(" ")}`,
      fix: "add a rule to the scenario",
      details: {},
    }),
  );
}
if (rule.sleep_ms) await Bun.sleep(rule.sleep_ms);
if (rule.loop_state && dataDir) {
  const loopId = String(rule.loop_state.loop_id);
  mkdirSync(join(dataDir, "loops", loopId), { recursive: true });
  writeFileSync(
    join(dataDir, "loops", loopId, "state.json"),
    JSON.stringify(rule.loop_state),
  );
}
if (rule.hang_after_stdout_ms && rule.stdout) {
  process.stdout.write(`${rule.stdout}\n`);
  await Bun.sleep(rule.hang_after_stdout_ms);
  finish(rule.exit ?? 0);
}
finish(rule.exit ?? 0, rule.stdout, rule.stderr);
