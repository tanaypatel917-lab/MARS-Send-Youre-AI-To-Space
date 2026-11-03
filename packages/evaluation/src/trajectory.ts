import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ArtifactRef, RequestContext } from "@mars/contracts";
import type { TrialRecord } from "./harbor-records";

/** Minimal artifact sink (same shape as `ArtifactStore.put` in `@mars/tasks`). */
export interface ArtifactSink {
  put(
    context: RequestContext,
    data: Uint8Array,
    mediaType: string,
  ): Promise<ArtifactRef>;
}

export const TRIAL_BUNDLE_MEDIA_TYPE = "application/vnd.mars.harbor-trial+json";
const MAX_FILE_BYTES = 512 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
/** Verifier *inputs* (tests, solutions) never enter the bundle; only outputs do. */
const EXCLUDED_DIRS = new Set(["tests", "solution", "steps"]);
const INCLUDED_ROOTS = ["agent", "verifier", "artifacts"];
const INCLUDED_FILES = ["result.json", "config.json", "lock.json", "trial.log"];

export interface TrialBundleFile {
  path: string;
  bytes: number;
  truncated: boolean;
  /** UTF-8 text; binary files are recorded by size only (`content: null`). */
  content: string | null;
}
export interface TrialBundle {
  schema: "mars.harbor-trial-bundle/v1";
  trial_name: string;
  task_id: string;
  files: TrialBundleFile[];
  omitted: string[];
}

async function* walk(root: string, dir: string): AsyncGenerator<string> {
  for (const entry of (await readdir(dir)).sort()) {
    const path = join(dir, entry);
    const info = await stat(path).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      yield* walk(root, path);
    } else if (info.isFile()) yield relative(root, path);
  }
}

/** Packs a Harbor trial directory into a bounded, text-only JSON bundle. */
export async function packTrialDir(
  trialDir: string,
  record: TrialRecord,
): Promise<TrialBundle> {
  const files: TrialBundleFile[] = [];
  const omitted: string[] = [];
  let total = 0;
  const candidates: string[] = [];
  for (const file of INCLUDED_FILES) candidates.push(file);
  for (const root of INCLUDED_ROOTS) {
    const dir = join(trialDir, root);
    if (
      !(await stat(dir).then(
        (info) => info.isDirectory(),
        () => false,
      ))
    )
      continue;
    for await (const rel of walk(trialDir, dir)) candidates.push(rel);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const rel of candidates) {
    const info = await stat(join(trialDir, rel)).catch(() => null);
    if (!info?.isFile()) continue;
    if (total + Math.min(info.size, MAX_FILE_BYTES) > MAX_BUNDLE_BYTES) {
      omitted.push(rel);
      continue;
    }
    const raw = new Uint8Array(await readFile(join(trialDir, rel)));
    const slice =
      raw.byteLength > MAX_FILE_BYTES ? raw.subarray(0, MAX_FILE_BYTES) : raw;
    let content: string | null;
    try {
      content = decoder.decode(slice);
    } catch {
      content = null;
    }
    total += slice.byteLength;
    files.push({
      path: rel,
      bytes: raw.byteLength,
      truncated: raw.byteLength > slice.byteLength,
      content,
    });
  }
  return {
    schema: "mars.harbor-trial-bundle/v1",
    trial_name: record.trial_name,
    task_id: record.task_id,
    files,
    omitted,
  };
}

export async function storeTrialBundle(
  artifacts: ArtifactSink,
  context: RequestContext,
  trialDir: string,
  record: TrialRecord,
): Promise<ArtifactRef> {
  const bundle = await packTrialDir(trialDir, record);
  return artifacts.put(
    context,
    new TextEncoder().encode(JSON.stringify(bundle)),
    TRIAL_BUNDLE_MEDIA_TYPE,
  );
}

const MAX_FEEDBACK_CHARS = 6 * 1024;
function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(-limit)}` : text;
}

/**
 * Textual feedback for GEPA reflection, rendered as clearly labelled untrusted
 * evidence: verifier stdout tail, reward and exception. Never includes test
 * sources or hidden answers (they are excluded from the bundle entirely).
 */
export function renderTrialFeedback(
  record: TrialRecord,
  bundle: TrialBundle | null,
): string {
  const verifierOut =
    bundle?.files.find((file) => file.path === "verifier/test-stdout.txt")
      ?.content ?? null;
  const agentOut =
    bundle?.files.find(
      (file) =>
        file.path.startsWith("agent/") && file.path.endsWith("mars-usage.json"),
    )?.content ?? null;
  const lines = [
    `[untrusted evaluation evidence · trial ${record.trial_name} · task ${record.task_id}]`,
    `Reward: ${record.reward === null ? "none" : record.reward} (${record.reward_valid ? "valid" : "invalid"})`,
  ];
  if (record.exception)
    lines.push(
      `Exception: ${record.exception.type}: ${clip(record.exception.message, 1024)}`,
    );
  if (record.runtime_ms !== null)
    lines.push(`Agent runtime: ${record.runtime_ms} ms`);
  if (agentOut) lines.push(`Agent summary: ${clip(agentOut, 1024)}`);
  if (verifierOut)
    lines.push("Verifier output (tail):", clip(verifierOut, 3 * 1024));
  else lines.push("Verifier output: not available");
  return clip(lines.join("\n"), MAX_FEEDBACK_CHARS);
}
