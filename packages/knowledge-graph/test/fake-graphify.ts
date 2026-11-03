#!/usr/bin/env bun
/**
 * Offline stand-in for the pinned `graphify` CLI. Behaviour comes from the
 * JSON scenario named by FAKE_GRAPHIFY_SCENARIO; every invocation (argv, cwd,
 * environment) is appended to FAKE_GRAPHIFY_LOG so tests can assert the
 * sandbox contract. No network, no Python, no model.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Scenario {
  version?: string;
  version_exit?: number;
  extract_exit?: number;
  extract_stdout?: string;
  extract_stderr?: string;
  hang_ms?: number;
  /** Written verbatim as graphify-out/graph.json; omit to write nothing. */
  graph?: unknown;
  graph_text?: string;
  analysis?: unknown;
}

const scenarioPath = process.env.FAKE_GRAPHIFY_SCENARIO;
const scenario: Scenario = scenarioPath
  ? (JSON.parse(await Bun.file(scenarioPath).text()) as Scenario)
  : {};
const args = process.argv.slice(2);

if (process.env.FAKE_GRAPHIFY_LOG)
  appendFileSync(
    process.env.FAKE_GRAPHIFY_LOG,
    `${JSON.stringify({ args, cwd: process.cwd(), env: process.env })}\n`,
  );

function finish(code: number, stdout?: string, stderr?: string): never {
  if (stdout)
    process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  if (stderr) process.stderr.write(stderr);
  return process.exit(code);
}

if (args[0] === "--version")
  finish(
    scenario.version_exit ?? 0,
    `graphify ${scenario.version ?? "0.9.101"}`,
  );

if (args[0] === "extract") {
  if (scenario.hang_ms) {
    process.stdout.write("[graphify extract] scanning\n");
    await Bun.sleep(scenario.hang_ms);
  }
  const outFlag = args.indexOf("--out");
  const out = outFlag >= 0 ? args[outFlag + 1] : process.env.GRAPHIFY_OUT;
  if (
    out &&
    (scenario.graph !== undefined || scenario.graph_text !== undefined)
  ) {
    const dir = join(out, "graphify-out");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "graph.json"),
      scenario.graph_text ?? JSON.stringify(scenario.graph),
    );
    if (scenario.analysis !== undefined)
      writeFileSync(
        join(dir, ".graphify_analysis.json"),
        JSON.stringify(scenario.analysis),
      );
  }
  finish(
    scenario.extract_exit ?? 0,
    scenario.extract_stdout ??
      "[graphify extract] found 3 code, 0 docs, 0 papers, 0 images\n[graphify extract] wrote graph.json: 5 nodes, 3 edges, 2 communities",
    scenario.extract_stderr,
  );
}

finish(2, undefined, `fake graphify: unsupported command ${args.join(" ")}\n`);
