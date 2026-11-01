import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { conservativeTokenCounter, createRepositoryMapProvider } from "../src";
import { inventory } from "../src/inventory";
import { DEFAULT_REPOSITORY_MAP_LIMITS } from "../src/provider";
import type { RepositoryMap, TokenCounter } from "../src/types";
import type { NavigationTask } from "./fixture";
import {
  createScaledFixtureFiles,
  FIXTURE_FILES,
  NAVIGATION_TASKS,
} from "./fixture";

export interface Metrics {
  id: string;
  fixture: "small" | "scaled";
  budget: number;
  mode: "enabled" | "disabled";
  target_file_recall: number;
  target_symbol_recall: number;
  target_line_provenance: number;
  tokens_used: number;
  budget_utilization: number;
  target_token_share: number;
  first_target_position: number | null;
  deterministic: boolean;
}

export interface ComparisonReport {
  metrics: Metrics[];
  means: Array<
    Omit<Metrics, "id" | "deterministic"> & {
      tasks: number;
      deterministic: boolean;
    }
  >;
  table: string;
}

export interface TimingSample {
  fixture: "small" | "scaled";
  cold_ms: number;
  warm_ms: number;
  cold_files_parsed: number;
  warm_files_parsed: number;
}

interface FixtureEnvironment {
  root: string;
  dispose(): Promise<void>;
}

export async function runComparison(): Promise<ComparisonReport> {
  const metrics: Metrics[] = [];
  const fixtures = [
    { id: "small" as const, files: FIXTURE_FILES },
    { id: "scaled" as const, files: createScaledFixtureFiles() },
  ];
  for (const definition of fixtures) {
    const fixture = await materializeFixture(definition.files);
    try {
      const context = {
        schema_version: 1 as const,
        scope: {
          owner_id: "bench-owner",
          project_id: "fixture",
          workspace_id: "fixture-workspace",
        },
        request_id: "fixture-navigation-benchmark",
      };
      const workspace = {
        workspace_id: "fixture-workspace",
        provider: "fixture",
        revision: "fixture-revision",
      };
      const createProvider = () =>
        createRepositoryMapProvider({
          resolveRoot: async () => ({
            root: fixture.root,
            revision: workspace.revision,
          }),
        });
      const provider = createProvider();
      try {
        const scanned = await inventory({
          root: fixture.root,
          limits: DEFAULT_REPOSITORY_MAP_LIMITS,
          previous: new Map(),
          check: () => {},
        });
        const paths = scanned.files.map((file) => file.path).sort(compare);
        for (const budget of [256, 512, 1024]) {
          for (const task of NAVIGATION_TASKS) {
            const request = {
              workspace,
              query: task.query,
              ...(task.mentioned_symbols
                ? { mentioned_symbols: task.mentioned_symbols }
                : {}),
              max_output_tokens: budget,
            };
            const map = await provider.map(context, request);
            const repeatedProvider = createProvider();
            let repeated: RepositoryMap;
            try {
              repeated = await repeatedProvider.map(context, request);
            } finally {
              repeatedProvider.close();
            }
            metrics.push(
              measureEnabled(definition.id, task, budget, map, repeated),
            );
            metrics.push(
              measureDisabled(
                definition.id,
                task,
                budget,
                paths,
                conservativeTokenCounter,
              ),
            );
          }
        }
      } finally {
        provider.close();
      }
    } finally {
      await fixture.dispose();
    }
  }
  const means = aggregate(metrics);
  return { metrics, means, table: renderTable(means) };
}

export async function runTimingSample(): Promise<TimingSample[]> {
  const samples: TimingSample[] = [];
  const fixtures = [
    { id: "small" as const, files: FIXTURE_FILES },
    { id: "scaled" as const, files: createScaledFixtureFiles() },
  ];
  for (const definition of fixtures) {
    const fixture = await materializeFixture(definition.files);
    try {
      const workspace = {
        workspace_id: "fixture-workspace",
        provider: "fixture",
        revision: "fixture-revision",
      };
      const context = {
        schema_version: 1 as const,
        scope: {
          owner_id: "bench-owner",
          project_id: "fixture",
          workspace_id: workspace.workspace_id,
        },
        request_id: "fixture-timing-sample",
      };
      const provider = createRepositoryMapProvider({
        resolveRoot: async () => ({
          root: fixture.root,
          revision: workspace.revision,
        }),
      });
      try {
        const request = {
          workspace,
          query: NAVIGATION_TASKS[0]?.query ?? "",
          max_output_tokens: 512,
        };
        const coldStarted = performance.now();
        const cold = await provider.map(context, request);
        const cold_ms = performance.now() - coldStarted;
        const warmStarted = performance.now();
        const warm = await provider.map(context, request);
        const warm_ms = performance.now() - warmStarted;
        samples.push({
          fixture: definition.id,
          cold_ms: round(cold_ms),
          warm_ms: round(warm_ms),
          cold_files_parsed: cold.stats.files_parsed,
          warm_files_parsed: warm.stats.files_parsed,
        });
      } finally {
        provider.close();
      }
    } finally {
      await fixture.dispose();
    }
  }
  return samples;
}

function measureEnabled(
  fixture: Metrics["fixture"],
  task: NavigationTask,
  budget: number,
  map: RepositoryMap,
  repeated: RepositoryMap,
): Metrics {
  const targetFiles = new Set(task.targets.map((target) => target.path));
  const presentFiles = new Set(map.files.map((file) => file.path));
  const symbolHits = task.targets.filter((target) =>
    map.files
      .find((file) => file.path === target.path)
      ?.symbols.some((symbol) => symbol.name === target.symbol),
  );
  const lineHits = symbolHits.filter((target) => {
    return (
      map.files
        .find((file) => file.path === target.path)
        ?.symbols.some(
          (symbol) =>
            symbol.name === target.symbol &&
            symbol.line === target.expected_line,
        ) ?? false
    );
  });
  const first = map.files.findIndex((file) => targetFiles.has(file.path));
  const targetLines = [...targetFiles].flatMap((path) =>
    linesForFile(map.text, path),
  );
  const targetTokens = conservativeTokenCounter.count(
    targetLines.length > 0 ? `${targetLines.join("\n")}\n` : "",
  );
  return {
    id: task.id,
    fixture,
    budget,
    mode: "enabled",
    target_file_recall: ratio(
      [...targetFiles].filter((path) => presentFiles.has(path)).length,
      targetFiles.size,
    ),
    target_symbol_recall: ratio(symbolHits.length, task.targets.length),
    target_line_provenance: ratio(lineHits.length, symbolHits.length),
    tokens_used: map.token_count,
    budget_utilization: ratio(map.token_count, budget),
    target_token_share: ratio(targetTokens, map.token_count),
    first_target_position: first >= 0 ? first + 1 : null,
    deterministic:
      map.text === repeated.text &&
      JSON.stringify(map.files) === JSON.stringify(repeated.files),
  };
}

function measureDisabled(
  fixture: Metrics["fixture"],
  task: NavigationTask,
  budget: number,
  paths: readonly string[],
  counter: TokenCounter,
): Metrics {
  const selected: string[] = [];
  for (const path of paths) {
    const candidate = `${selected.join("\n")}${selected.length > 0 ? "\n" : ""}${path}\n`;
    if (counter.count(candidate) <= budget) selected.push(path);
  }
  const targetFiles = new Set(task.targets.map((target) => target.path));
  const targetCount = [...targetFiles].filter((path) =>
    selected.includes(path),
  ).length;
  const first = selected.findIndex((path) => targetFiles.has(path));
  const text = selected.length > 0 ? `${selected.join("\n")}\n` : "";
  const targetLines = selected
    .filter((path) => targetFiles.has(path))
    .map((path) => `${path}\n`);
  const tokens_used = counter.count(text);
  return {
    id: task.id,
    fixture,
    budget,
    mode: "disabled",
    target_file_recall: ratio(targetCount, targetFiles.size),
    target_symbol_recall: 0,
    target_line_provenance: 0,
    tokens_used,
    budget_utilization: ratio(tokens_used, budget),
    target_token_share: ratio(counter.count(targetLines.join("")), tokens_used),
    first_target_position: first >= 0 ? first + 1 : null,
    deterministic: true,
  };
}

function aggregate(metrics: readonly Metrics[]): ComparisonReport["means"] {
  return (["small", "scaled"] as const).flatMap((fixture) =>
    [256, 512, 1024].flatMap((budget) =>
      (["enabled", "disabled"] as const).map((mode) => {
        const rows = metrics.filter(
          (row) =>
            row.fixture === fixture &&
            row.budget === budget &&
            row.mode === mode,
        );
        const mean = (selector: (row: Metrics) => number) =>
          round(
            rows.reduce((sum, row) => sum + selector(row), 0) / rows.length,
          );
        const positions = rows
          .map((row) => row.first_target_position)
          .filter((position): position is number => position !== null);
        return {
          fixture,
          budget,
          mode,
          target_file_recall: mean((row) => row.target_file_recall),
          target_symbol_recall: mean((row) => row.target_symbol_recall),
          target_line_provenance: mean((row) => row.target_line_provenance),
          tokens_used: mean((row) => row.tokens_used),
          budget_utilization: mean((row) => row.budget_utilization),
          target_token_share: mean((row) => row.target_token_share),
          first_target_position:
            positions.length > 0
              ? round(positions.reduce((a, b) => a + b, 0) / positions.length)
              : null,
          tasks: rows.length,
          deterministic: rows.every((row) => row.deterministic),
        };
      }),
    ),
  );
}

function renderTable(means: ComparisonReport["means"]): string {
  const rows = [
    "| Fixture | Budget | Mode | File recall | Symbol recall | Line provenance | Tokens used | Utilization | Target token share | First target |",
    "| :--- | ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...means.map(
      (row) =>
        `| ${row.fixture} | ${row.budget} | ${row.mode} | ${percent(row.target_file_recall)} | ${percent(row.target_symbol_recall)} | ${percent(row.target_line_provenance)} | ${row.tokens_used} | ${percent(row.budget_utilization)} | ${percent(row.target_token_share)} | ${row.first_target_position ?? "—"} |`,
    ),
  ];
  return rows.join("\n");
}

function linesForFile(text: string, path: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === path || line === `${path}:`);
  if (start < 0) return [];
  const output = [lines[start] ?? ""];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line && !line.startsWith(" ") && line.endsWith(":")) break;
    output.push(line);
  }
  return output.filter(Boolean);
}

async function materializeFixture(
  files: Readonly<Record<string, string>>,
): Promise<FixtureEnvironment> {
  const root = await mkdtemp(join(tmpdir(), "mars-context-bench-"));
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source, "utf8");
  }
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (import.meta.main) {
  const report = await runComparison();
  const timing = await runTimingSample();
  process.stdout.write(
    `${JSON.stringify({ ...report, timing }, null, 2)}\n\n${report.table}\n`,
  );
}
