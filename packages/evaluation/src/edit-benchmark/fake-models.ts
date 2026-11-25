import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadModelRegistry } from "@mars/providers";
import type { EditBenchmarkTask } from "./tasks";

/**
 * Deterministic scripted models for offline runs. A scripted model speaks the
 * OpenAI-compatible streaming protocol behind an injected `fetch`, reads the
 * files a task changes, then edits them in whichever edit format the arm's
 * tool list exposes (MARS `mars_edit` with anchored `mars_read`,
 * `mars_replace` or `mars_apply_patch`, or Oh My Pi's `edit` in its
 * hashline / replace / apply_patch modes). Profiles inject realistic failure
 * modes (malformed patches, wrong whitespace, stale anchors, ambiguous
 * matches) per format, chosen from a hash of the forwarded request `seed`, so
 * identical seeds give identical runs and no real model is ever called.
 */
export type ScriptedEditFormat = "apply_patch" | "replace" | "hashline";
export type ScriptedFailureMode =
  | "malformed_patch"
  | "wrong_whitespace"
  | "stale_anchor"
  | "ambiguous_match";

export interface ScriptedModelProfile {
  id: string;
  /** Per-format probability that an edit attempt is faulty, and the faults drawn. */
  faults: Partial<
    Record<ScriptedEditFormat, { rate: number; modes: ScriptedFailureMode[] }>
  >;
  /** Edit attempts per file before the scripted model gives up. */
  max_attempts: number;
  /** Only the first N attempts per file may be faulty (default: all). */
  faulty_attempts?: number;
  /** Faults for Oh My Pi's own `edit` tool (omp-stock), per format; default `faults`. */
  stock_faults?: ScriptedModelProfile["faults"];
}

export const SCRIPTED_PROFILES: Record<string, ScriptedModelProfile> = {
  oracle: { id: "oracle", faults: {}, max_attempts: 1 },
  "small-model": {
    id: "small-model",
    faults: {
      apply_patch: {
        rate: 0.6,
        modes: ["malformed_patch", "wrong_whitespace"],
      },
      replace: { rate: 0.4, modes: ["wrong_whitespace", "ambiguous_match"] },
      hashline: { rate: 0.25, modes: ["stale_anchor"] },
    },
    max_attempts: 2,
  },
  "patch-fluent": {
    id: "patch-fluent",
    faults: {
      replace: { rate: 1, modes: ["ambiguous_match", "wrong_whitespace"] },
      hashline: { rate: 1, modes: ["stale_anchor"] },
    },
    max_attempts: 1,
  },
  // MARS's default-format tools are clean; stock omp's edit tool always fails.
  "default-fluent": {
    id: "default-fluent",
    faults: {},
    stock_faults: {
      hashline: { rate: 1, modes: ["stale_anchor"] },
      replace: { rate: 1, modes: ["ambiguous_match"] },
    },
    max_attempts: 1,
  },
  // MARS hashline always fails; stock omp (same hashline mode) is clean.
  "default-hostile": {
    id: "default-hostile",
    faults: { hashline: { rate: 1, modes: ["stale_anchor"] } },
    stock_faults: { hashline: { rate: 0, modes: ["stale_anchor"] } },
    max_attempts: 1,
  },
  // A non-default arm (apply_patch) wins by more than the default (hashline).
  "secondary-wins": {
    id: "secondary-wins",
    faults: { hashline: { rate: 0.5, modes: ["stale_anchor"] } },
    stock_faults: {
      hashline: { rate: 1, modes: ["stale_anchor"] },
      replace: { rate: 1, modes: ["ambiguous_match"] },
    },
    max_attempts: 1,
  },
  // Every format's first edit attempt per file fails; the retry is clean.
  recovering: {
    id: "recovering",
    faults: {
      apply_patch: { rate: 1, modes: ["malformed_patch"] },
      replace: { rate: 1, modes: ["ambiguous_match"] },
      hashline: { rate: 1, modes: ["stale_anchor"] },
    },
    max_attempts: 2,
    faulty_attempts: 1,
  },
  "patch-hostile": {
    id: "patch-hostile",
    faults: { apply_patch: { rate: 1, modes: ["malformed_patch"] } },
    max_attempts: 1,
  },
};

interface WireMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}
interface WireTool {
  function: {
    name: string;
    description?: string;
    parameters?: { properties?: Record<string, unknown> };
  };
}

const decoder = new TextDecoder();
const writeDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
const text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? "" : decoder.decode(bytes);

function unit(parts: readonly unknown[]): number {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function sseResponse(
  delta: Record<string, unknown>,
  reason: string,
  usage: { prompt_tokens: number; completion_tokens: number },
): Response {
  return new Response(
    [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }], usage })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

export interface ReadView {
  /** Whole file text when the read showed every line, else null. */
  content: string | null;
  /** Visible lines by 1-based line number. */
  lines: Map<number, string>;
  tag: string | null;
  complete: boolean;
}

const ANCHORED_ROW = /^(\d+):([abcdefghijkmnpqrstuvwxyz23456789]{3})\|(.*)$/;

/** `line:hash|text` rows anywhere in a MARS tool result (reads, recoveries). */
export function anchoredRows(
  result: string,
): Map<number, { anchor: string; text: string }> {
  const rows = new Map<number, { anchor: string; text: string }>();
  for (const row of result.split("\n")) {
    const match = ANCHORED_ROW.exec(row);
    if (match)
      rows.set(Number(match[1]), {
        anchor: `${match[1]}:${match[2]}`,
        text: match[3] ?? "",
      });
  }
  return rows;
}

/** A MARS paged `mars_read` result: `path · lines a-b of N`, then rows. */
function parsePagedRead(result: string): ReadView | null {
  const rows = result.split("\n");
  const header = / · lines (\d+)-(\d+) of (\d+)$/.exec(rows[0] ?? "");
  if (!header) return null;
  const total = Number(header[3]);
  const anchored = anchoredRows(result);
  const lines = new Map<number, string>();
  if (anchored.size > 0)
    for (const [n, row] of anchored) lines.set(n, row.text);
  else {
    let n = Number(header[1]);
    for (const row of rows.slice(1)) {
      if (
        /^\[(?:…\d+ln elided|truncated|continue|line \d+ truncated)/.test(row)
      )
        continue;
      lines.set(n, row);
      n += 1;
    }
  }
  const complete =
    lines.size === total &&
    Array.from({ length: total }, (_, i) => i + 1).every((n) => lines.has(n));
  return {
    content: complete
      ? `${Array.from({ length: total }, (_, i) => lines.get(i + 1)).join("\n")}\n`
      : null,
    lines,
    tag: null,
    complete,
  };
}

/** A read result, with Oh My Pi hashline/line-number decoration and elisions decoded. */
export function parseReadResult(result: string): ReadView {
  const paged = parsePagedRead(result);
  if (paged) return paged;
  if (
    /^.*: \d+ lines, \d+ bytes\. Outlined because file exceeds /u.test(result)
  ) {
    const preview =
      result
        .split(/\n\nHead \([^\n]*\):\n/)[1]
        ?.split("\n\nCall mars_read")[0] ?? "";
    const lines = new Map<number, string>();
    for (const row of preview.split("\n")) {
      const numbered = /^(\d+): (.*)$/.exec(row);
      if (numbered && !row.endsWith(" [line truncated]"))
        lines.set(Number(numbered[1]), numbered[2] ?? "");
    }
    return { content: null, lines, tag: null, complete: false };
  }
  const header = /^\[[^\]\n#]+#([0-9A-Fa-f]{4})\]\n?/.exec(result);
  if (!header) {
    // omp middle-truncates any tool result over 50 KiB, including mars_read.
    const rows = splitLines(result);
    const cut = rows.findIndex((row) => /^\[…\d+ln elided/.test(row));
    if (cut < 0)
      return {
        content: result,
        lines: new Map(rows.map((line, i) => [i + 1, line])),
        tag: null,
        complete: true,
      };
    // Head lines keep their numbers; tail lines are keyed from the end (-1 = last).
    const tail = rows.slice(cut + 1);
    const lines = new Map<number, string>([
      ...rows.slice(0, cut).map((line, i) => [i + 1, line] as [number, string]),
      ...tail.map((line, i) => [i - tail.length, line] as [number, string]),
    ]);
    return { content: null, lines, tag: null, complete: false };
  }
  const lines = new Map<number, string>();
  let elided = false;
  for (const row of result.slice(header[0].length).split("\n")) {
    const numbered = /^(\d+):(.*)$/.exec(row);
    if (numbered) lines.set(Number(numbered[1]), numbered[2] ?? "");
    else if (row.length > 0) elided = true;
  }
  const count = lines.size;
  const complete =
    !elided && [...lines.keys()].every((n, i) => n === i + 1) && count > 0;
  return {
    content: complete ? `${[...lines.values()].join("\n")}\n` : null,
    lines,
    tag: header[1] ?? null,
    complete,
  };
}

interface Region {
  start: number;
  removed: string[];
  added: string[];
}

function changedRegion(current: string[], target: string[]): Region | null {
  let start = 0;
  while (
    start < current.length &&
    start < target.length &&
    current[start] === target[start]
  )
    start += 1;
  let tail = 0;
  while (
    tail < current.length - start &&
    tail < target.length - start &&
    current[current.length - 1 - tail] === target[target.length - 1 - tail]
  )
    tail += 1;
  if (start === current.length && start === target.length) return null;
  if (current.length === target.length) {
    // Same line count: edit the first run of changed lines only, so
    // scattered edits (renames) become one small edit per turn.
    let end = start;
    while (end < current.length && current[end] !== target[end]) end += 1;
    return {
      start,
      removed: current.slice(start, end),
      added: target.slice(start, end),
    };
  }
  return {
    start,
    removed: current.slice(start, current.length - tail),
    added: target.slice(start, target.length - tail),
  };
}

function occurrences(lines: string[], block: string[]): number {
  if (block.length === 0) return 0;
  let count = 0;
  for (let i = 0; i + block.length <= lines.length; i += 1)
    if (block.every((line, j) => lines[i + j] === line)) count += 1;
  return count;
}

/** Context lines around a region, grown until the old block is unique. */
function uniqueContext(lines: string[], region: Region) {
  for (let size = 1; size <= lines.length; size += 1) {
    const before = lines.slice(Math.max(0, region.start - size), region.start);
    const end = region.start + region.removed.length;
    const after = lines.slice(end, end + size);
    if (occurrences(lines, [...before, ...region.removed, ...after]) === 1)
      return { before, after };
  }
  return { before: lines.slice(0, region.start), after: [] };
}

const wrongWhitespace = (line: string) =>
  line.replace(/^\t+/, (tabs) => "    ".repeat(tabs.length)).trimEnd();

function applyPatchEdit(
  path: string,
  lines: string[],
  region: Region,
  fault: ScriptedFailureMode | null,
): string {
  const ctx = uniqueContext(lines, region);
  const mangle =
    fault === "wrong_whitespace" ? wrongWhitespace : (l: string) => l;
  const body = [
    ...ctx.before.map((line) => ` ${mangle(line)}`),
    ...region.removed.map((line) => `-${mangle(line)}`),
    ...region.added.map((line) => `+${mangle(line)}`),
    ...ctx.after.map((line) => ` ${mangle(line)}`),
  ];
  return [
    "*** Begin Patch",
    fault === "malformed_patch"
      ? `*** Update: ${path}`
      : `*** Update File: ${path}`,
    "@@",
    ...body,
    "*** End Patch",
  ].join("\n");
}

function replaceEdit(
  path: string,
  lines: string[],
  region: Region,
  fault: ScriptedFailureMode | null,
): Record<string, unknown> {
  const ctx =
    fault === "ambiguous_match"
      ? { before: [] as string[], after: [] as string[] }
      : uniqueContext(lines, region);
  const mangle =
    fault === "wrong_whitespace" ? wrongWhitespace : (l: string) => l;
  let oldLines = [...ctx.before, ...region.removed, ...ctx.after];
  let newLines = [...ctx.before, ...region.added, ...ctx.after];
  if (oldLines.length === 0) {
    oldLines = lines.slice(region.start, region.start + 1);
    newLines = [...region.added, ...oldLines];
  }
  return {
    path,
    old_string: oldLines.map(mangle).join("\n"),
    new_string: newLines.map(mangle).join("\n"),
  };
}

function hashlineEdit(
  path: string,
  tag: string,
  region: Region,
  fault: ScriptedFailureMode | null,
): string {
  const anchor =
    fault === "stale_anchor" ? (tag === "0000" ? "FFFF" : "0000") : tag;
  const first = region.start + 1;
  const last = region.start + region.removed.length;
  const body = region.added.map((line) => `+${line}`);
  const op =
    region.removed.length === 0
      ? region.start === 0
        ? ["PUT <1:", ...body]
        : [`PUT >${region.start}:`, ...body]
      : region.added.length === 0
        ? [`CUT ${first}.=${last}`]
        : [`PUT ${first}.=${last}:`, ...body];
  return [`[${path}#${anchor}]`, ...op].join("\n");
}

function marsEditArgs(
  path: string,
  region: Region,
  anchorOf: (line: number) => string,
  fault: ScriptedFailureMode | null,
): Record<string, unknown> {
  const anchor = (line: number) => {
    const value = anchorOf(line);
    return fault === "stale_anchor"
      ? value.replace(
          /:(\w{3})$/,
          (_, hash) => `:${hash === "aaa" ? "bbb" : "aaa"}`,
        )
      : value;
  };
  const mangle =
    fault === "wrong_whitespace" ? wrongWhitespace : (l: string) => l;
  const added = region.added.map(mangle);
  // mars_edit drops one trailing newline from content.
  const content = added.join("\n") + (added.at(-1) === "" ? "\n" : "");
  const first = region.start + 1;
  const last = region.start + region.removed.length;
  const end = last > first ? { end: anchorOf(last) } : {};
  const op =
    region.removed.length === 0
      ? region.start === 0
        ? { op: "insert_before", anchor: anchor(1), content }
        : { op: "insert_after", anchor: anchor(region.start), content }
      : region.added.length === 0
        ? { op: "delete", anchor: anchor(first), ...end }
        : { op: "replace", anchor: anchor(first), ...end, content };
  return { path, edits: [op] };
}

export interface ScriptedModel {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  requests(): number;
  /** The `seed` each request carried, in order (undefined when absent). */
  seeds(): Array<number | undefined>;
}

/** A deterministic scripted model for `tasks` under `profile`. */
export function createScriptedEditModel(options: {
  tasks: readonly EditBenchmarkTask[];
  profile: ScriptedModelProfile;
}): ScriptedModel {
  let requests = 0;
  const seeds: Array<number | undefined> = [];
  const fetch = async (_url: string, init?: RequestInit) => {
    requests += 1;
    const raw = String(init?.body ?? "{}");
    const body = JSON.parse(raw) as {
      messages: WireMessage[];
      tools?: WireTool[];
      seed?: number;
    };
    seeds.push(body.seed);
    const usage = (output: string) => ({
      prompt_tokens: Math.ceil(Buffer.byteLength(raw) / 4),
      completion_tokens: Math.ceil(Buffer.byteLength(output) / 4) + 8,
    });
    const say = (content: string) =>
      sseResponse({ content }, "stop", usage(content));
    const call = (name: string, args: Record<string, unknown>) => {
      const serialized = JSON.stringify(args);
      return sseResponse(
        {
          tool_calls: [
            {
              index: 0,
              id: `call_${requests}`,
              type: "function",
              function: { name, arguments: serialized },
            },
          ],
        },
        "tool_calls",
        usage(serialized),
      );
    };
    const firstUser = body.messages.find((m) => m.role === "user");
    const task = options.tasks.find((candidate) =>
      String(firstUser?.content ?? "").includes(candidate.instruction),
    );
    if (!task) return say("I do not recognise this task.");
    const tools = new Map(
      (body.tools ?? []).map((tool) => [tool.function.name, tool.function]),
    );
    const readTool = tools.has("mars_read") ? "mars_read" : "read";
    let editTool: string;
    let format: ScriptedEditFormat;
    if (tools.has("mars_apply_patch")) {
      editTool = "mars_apply_patch";
      format = "apply_patch";
    } else if (tools.has("mars_edit") && tools.has(readTool)) {
      editTool = "mars_edit";
      format = "hashline";
    } else if (tools.has("mars_replace") && tools.has(readTool)) {
      editTool = "mars_replace";
      format = "replace";
    } else {
      const edit = tools.get("edit");
      if (!edit || !tools.has(readTool))
        return say("No usable edit tool is available.");
      editTool = "edit";
      const props = edit.parameters?.properties ?? {};
      format =
        "old_string" in props
          ? "replace"
          : /hashline|PUT /i.test(edit.description ?? "")
            ? "hashline"
            : "apply_patch";
    }
    const results = new Map(
      body.messages
        .filter((m) => m.role === "tool" && m.tool_call_id)
        .map((m) => [m.tool_call_id as string, String(m.content ?? "")]),
    );
    const history = body.messages.flatMap((m) =>
      m.role === "assistant"
        ? (m.tool_calls ?? []).map((tc) => {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {}
            const input = String(args.input ?? args.patch ?? "");
            const path =
              typeof args.path === "string"
                ? args.path.replace(/:[\d,+-]+$/, "")
                : (/^(?:\*\*\* (?:(?:Add|Delete|Update) File|Update): |\[)([^\]#\n]+)/m.exec(
                    input,
                  )?.[1] ?? "");
            return {
              kind: tc.function.name === readTool ? "read" : "edit",
              ranged:
                (typeof args.path === "string" &&
                  /:[\d,+-]+$/.test(args.path)) ||
                args.offset !== undefined ||
                args.limit !== undefined,
              path,
              result: results.get(tc.id) ?? "",
            };
          })
        : [],
    );
    const targets = [...task.after.keys()].filter(
      (path) =>
        (editTool === "mars_apply_patch" && !task.before.has(path)) ||
        text(task.after.get(path)) !== text(task.before.get(path)),
    );
    if (editTool === "mars_apply_patch") {
      for (const path of task.before.keys())
        if (!task.after.has(path)) targets.push(path);
    }
    for (const path of targets) {
      const events = history.filter((event) => event.path === path);
      const edits = events.filter((event) => event.kind === "edit").length;
      const lastIndex = events.length - 1;
      const last = events[lastIndex];
      const fault = (attempt: number): ScriptedFailureMode | null => {
        const spec =
          (editTool === "edit"
            ? options.profile.stock_faults?.[format]
            : undefined) ?? options.profile.faults[format];
        if (!spec || spec.modes.length === 0) return null;
        if (
          attempt >=
          (options.profile.faulty_attempts ?? Number.POSITIVE_INFINITY)
        )
          return null;
        const draw = [
          body.seed ?? 0,
          options.profile.id,
          task.task_id,
          format,
          path,
          attempt,
        ];
        if (unit(draw) >= spec.rate) return null;
        return (
          spec.modes[Math.floor(unit([...draw, "mode"]) * spec.modes.length)] ??
          null
        );
      };
      if (edits > 0) {
        const previous = fault(edits - 1);
        // A whitespace-mangled edit "succeeds" and the model believes it is done.
        if (previous === "wrong_whitespace") continue;
        if (previous !== null && edits >= options.profile.max_attempts)
          return say(`I could not apply the edit to ${path}.`);
      }
      if (
        editTool === "mars_apply_patch" &&
        (!task.before.has(path) || !task.after.has(path))
      ) {
        if (edits > 0 && fault(edits - 1) === null) continue;
        if (fault(edits) !== null)
          return call(editTool, {
            patch: `*** Begin Patch\n*** Update: ${path}\n*** End Patch`,
          });
        if (!task.after.has(path))
          return call(editTool, {
            patch: `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch`,
          });
        return call("mars_write", {
          path,
          content: writeDecoder.decode(task.after.get(path)),
        });
      }
      // Re-read after a failed edit; after a successful one, continue from
      // what the edit applied until the file matches.
      if (
        !last ||
        (last.kind !== "read" &&
          (edits === 0 ||
            // mars_edit rejections carry recovery anchors to retry with.
            (fault(edits - 1) !== null && editTool !== "mars_edit")))
      )
        return call(readTool, { path });
      const rangeRead = (from: number, to: number) =>
        call(
          readTool,
          readTool === "mars_read"
            ? { path, offset: from, limit: Math.min(2000, to - from + 1) }
            : { path: `${path}:${from}-${to}` },
        );
      const lastRead = events.findLast((event) => event.kind === "read");
      if (!lastRead) return call(readTool, { path });
      const view = parseReadResult(lastRead.result);
      const tagged =
        last.kind === "edit" ? parseReadResult(last.result).tag : null;
      const after = splitLines(text(task.after.get(path)));
      // An elided read shows only part of the file; the scripted model then
      // works from what it knows (the original plus the edits it applied)
      // and re-reads the lines it edits.
      let belief = splitLines(text(task.before.get(path)));
      for (let attempt = 0; attempt < edits; attempt += 1) {
        if (fault(attempt) !== null) continue;
        const applied = changedRegion(belief, after);
        if (!applied) break;
        belief = [
          ...belief.slice(0, applied.start),
          ...applied.added,
          ...belief.slice(applied.start + applied.removed.length),
        ];
      }
      const lines =
        last.kind === "read" && view.complete && view.content
          ? splitLines(view.content)
          : belief;
      const region = changedRegion(lines, after);
      if (!region) continue;
      if (!view.complete && !lastRead.ranged) {
        const from = Math.max(1, region.start - 2);
        const to = Math.min(
          lines.length,
          region.start + region.removed.length + 3,
        );
        const visible = Array.from(
          { length: to - from + 1 },
          (_, i) => from + i,
        ).every(
          (n) =>
            view.lines.get(n) === lines[n - 1] ||
            view.lines.get(n - lines.length - 1) === lines[n - 1],
        );
        if (!visible) return rangeRead(from, to);
      }
      const known =
        editTool === "mars_edit"
          ? anchoredRows(last.kind === "edit" ? last.result : lastRead.result)
          : null;
      if (
        format === "hashline" &&
        (editTool === "mars_edit" || last.kind === "edit")
      ) {
        // Anchors must come from lines the latest result displayed.
        const shown = known
          ? new Map([...known].map(([n, row]) => [n, row.text]))
          : parseReadResult(last.result).lines;
        const first = Math.max(1, region.start);
        const end = Math.max(first, region.start + region.removed.length);
        const anchored = Array.from(
          { length: end - first + 1 },
          (_, i) => first + i,
        ).every((n) => shown.get(n) === lines[n - 1]);
        if (!anchored)
          return rangeRead(
            Math.max(1, first - 2),
            Math.min(lines.length, end + 3),
          );
      }
      const current = fault(edits);
      if (editTool === "mars_apply_patch")
        return call(editTool, {
          patch: applyPatchEdit(path, lines, region, current),
        });
      if (editTool === "mars_edit")
        return call(
          editTool,
          marsEditArgs(
            path,
            region,
            (n) => known?.get(n)?.anchor ?? `${n}:aaa`,
            current,
          ),
        );
      if (editTool === "mars_replace") {
        const edit = replaceEdit(path, lines, region, current);
        return call(editTool, {
          path,
          old: edit.old_string,
          new: edit.new_string,
        });
      }
      if (format === "replace")
        return call(editTool, replaceEdit(path, lines, region, current));
      if (format === "hashline")
        return call(editTool, {
          input: hashlineEdit(
            path,
            tagged ?? view.tag ?? "0000",
            region,
            current,
          ),
        });
      return call(editTool, {
        input: applyPatchEdit(path, lines, region, current),
      });
    }
    return say("Done: the requested edits are applied.");
  };
  return { fetch, requests: () => requests, seeds: () => [...seeds] };
}

/** A `models.json` with one free, tool-capable scripted model, loaded into a registry. */
export async function scriptedModelRegistry(
  root: string,
  modelId = "scripted/small",
  upstreamModel?: string,
) {
  const home = join(root, "home");
  await mkdir(join(home, ".mars"), { recursive: true, mode: 0o700 });
  const [providerId, alias] = modelId.split("/") as [string, string];
  const model = upstreamModel ?? alias;
  await writeFile(
    join(home, ".mars", "models.json"),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: providerId,
          kind: "openai-compatible",
          baseUrl: "https://scripted.invalid/v1",
          apiKeyEnv: "MARS_SCRIPTED_MODEL_KEY",
        },
      ],
      models: [
        {
          id: modelId,
          providerId,
          model,
          capabilities: {
            tools: true,
            vision: false,
            contextWindow: 1_000_000,
          },
          pricing: { free: false, inputPerMTokUsd: 0.1, outputPerMTokUsd: 0.4 },
        },
      ],
      routes: { default: [modelId] },
      policy: { allowPaid: true },
    }),
  );
  const env = { MARS_SCRIPTED_MODEL_KEY: "scripted-not-a-secret" };
  const registry = await loadModelRegistry({ cwd: root, home, env });
  return { registry, env, modelId };
}
