import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DerivedArtifactStore } from "@mars/context";
import type { RuntimeKnowledgeGraph } from "@mars/execution";
import { z } from "zod";
import { createGraphifyRunner, type GraphifyRunner } from "./cli";
import {
  communities,
  describeNode,
  indexGraph,
  neighbours,
  paths,
  QUERY_LIMITS,
  resolveNodes,
  truncate,
} from "./graph";
import {
  GRAPH_LIMITS,
  GRAPHIFY_VERSION,
  type GraphBuildRecord,
  type GraphDoctor,
  type GraphEdge,
  type GraphNode,
  KNOWLEDGE_GRAPH_PACKAGE_VERSION,
  KNOWLEDGE_GRAPH_PRODUCER,
  type KnowledgeGraphArtifact,
  KnowledgeGraphArtifactSchema,
} from "./schema";

export const KNOWLEDGE_GRAPH_ARTIFACT_KIND = "knowledge-graph";

export interface GraphEvidenceSink {
  append(record: GraphBuildRecord): Promise<void>;
}

export interface GraphBinding {
  task_id: string;
  owner_id: string;
  project_id: string;
  workspace_id: string;
  /** Absolute, host-resolved workspace root; the only tree graphify may read. */
  cwd: string;
  /** Workspace revision at binding time; artifacts built for another revision are stale. */
  revision: string;
  /**
   * Resolves the workspace's current revision (it advances on every write);
   * builds and queries use it instead of the binding-time value when present.
   */
  currentRevision?(): Promise<string>;
  approvals?: { read: boolean };
  evidence?: GraphEvidenceSink;
}

export interface KnowledgeGraphServiceOptions {
  /** argv prefix of the CLI; defaults to `["graphify"]` on PATH. */
  command?: string[];
  /**
   * Set when `command` wraps the CLI in an OS sandbox (bwrap, firejail, …);
   * recorded on every build so reviewers know which isolation produced it.
   */
  osWrapper?: boolean;
  expectedVersion?: string;
  /** Host-private directory for graphify's HOME, cache and raw output. */
  dataRoot: string;
  artifacts: DerivedArtifactStore;
  timeoutMs?: number;
  maxOutputBytes?: number;
  doctorTtlMs?: number;
  env?: Record<string, string>;
  processEnv?: Record<string, string | undefined>;
  now?: () => Date;
  runner?: GraphifyRunner;
}

export type GraphBuildOutcome =
  | {
      status: "built";
      artifact: KnowledgeGraphArtifact;
      record: GraphBuildRecord;
    }
  | {
      status: "unavailable" | "failed" | "refused";
      reason: string;
      record: GraphBuildRecord;
    };

export type GraphLookup =
  | { status: "ready"; artifact: KnowledgeGraphArtifact }
  | { status: "not_built" }
  | { status: "stale"; built_for: string; current: string };

export interface KnowledgeGraphService {
  doctor(): Promise<GraphDoctor>;
  build(binding: GraphBinding): Promise<GraphBuildOutcome>;
  lookup(binding: GraphBinding): Promise<GraphLookup>;
  toolsFor(binding: GraphBinding): RuntimeKnowledgeGraph;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT = 96 * 1024;
const DEFAULT_DOCTOR_TTL_MS = 5 * 60 * 1000;
const MAX_RAW_GRAPH_BYTES = 64 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const rawNodeSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1).optional(),
    _callable: z.boolean().optional(),
    community: z.number().int().optional(),
    file_type: z.string().optional(),
    source_file: z.string().optional(),
    source_location: z.string().optional(),
  })
  .passthrough();
const rawEdgeSchema = z
  .object({
    source: z.string().min(1),
    target: z.string().min(1),
    relation: z.string().min(1).optional(),
    confidence: z.string().optional(),
    source_file: z.string().optional(),
    source_location: z.string().optional(),
  })
  .passthrough();
const rawGraphSchema = z
  .object({
    nodes: z.array(rawNodeSchema),
    links: z.array(rawEdgeSchema),
  })
  .passthrough();
const rawAnalysisSchema = z
  .object({
    communities: z.record(z.array(z.string())).optional(),
    cohesion: z.record(z.number()).optional(),
    community_labels: z.record(z.string()).optional(),
  })
  .passthrough();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function taskKey(taskId: string): string {
  if (!ID_PATTERN.test(taskId)) throw new Error("invalid task id");
  return createHash("sha256").update(taskId).digest("hex").slice(0, 24);
}

/** Only relative paths inside the workspace survive; everything else is dropped. */
function workspaceRelative(
  root: string,
  value: string | undefined,
): string | null {
  if (!value) return null;
  const candidate = isAbsolute(value) ? value : resolve(root, value);
  const rel = relative(root, candidate);
  if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel))
    return null;
  return rel.split(sep).join("/");
}

function containsHostPath(
  root: string,
  dataRoot: string,
  text: string,
): boolean {
  return text.includes(root) || text.includes(dataRoot);
}

/**
 * Normalise graphify's `graph.json` + `.graphify_analysis.json` into the
 * artifact contract: relative paths only, bounded sizes, stable ordering and a
 * content digest independent of build time.
 */
export function normalizeGraph(input: {
  raw: unknown;
  analysis: unknown;
  root: string;
  dataRoot: string;
  workspace: { workspace_id: string; revision: string };
  graphifyVersion: string;
  builtAt: string;
  files: number;
  complete: boolean;
}): KnowledgeGraphArtifact {
  const raw = rawGraphSchema.parse(input.raw);
  const analysis = rawAnalysisSchema.safeParse(input.analysis ?? {});
  const nodes: GraphNode[] = [];
  let droppedNodes = 0;
  const seen = new Set<string>();
  for (const node of raw.nodes) {
    const label = (node.label ?? node.id).slice(
      0,
      GRAPH_LIMITS.max_label_length,
    );
    const sourceFile = workspaceRelative(input.root, node.source_file);
    const id = node.id.slice(0, GRAPH_LIMITS.max_id_length);
    if (
      seen.has(id) ||
      containsHostPath(input.root, input.dataRoot, `${id}\u0000${label}`) ||
      (sourceFile === null && node.source_file) ||
      nodes.length >= GRAPH_LIMITS.max_nodes
    ) {
      droppedNodes++;
      continue;
    }
    seen.add(id);
    nodes.push({
      id,
      label,
      kind: node.file_type ? "symbol" : sourceFile ? "file" : "other",
      source_file: sourceFile,
      source_location: node.source_location?.slice(0, 64) ?? null,
      community:
        node.community !== undefined && node.community >= 0
          ? node.community
          : null,
      callable: node._callable ?? false,
    });
  }
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edges: GraphEdge[] = [];
  let droppedEdges = 0;
  for (const edge of raw.links) {
    const confidence =
      edge.confidence === "EXTRACTED" ||
      edge.confidence === "INFERRED" ||
      edge.confidence === "AMBIGUOUS"
        ? edge.confidence
        : "AMBIGUOUS";
    const sourceFile = workspaceRelative(input.root, edge.source_file);
    if (
      !seen.has(edge.source) ||
      !seen.has(edge.target) ||
      (sourceFile === null && edge.source_file) ||
      edges.length >= GRAPH_LIMITS.max_edges
    ) {
      droppedEdges++;
      continue;
    }
    edges.push({
      source: edge.source,
      target: edge.target,
      relation: (edge.relation ?? "related").slice(
        0,
        GRAPH_LIMITS.max_relation_length,
      ),
      confidence,
      source_file: sourceFile,
      source_location: edge.source_location?.slice(0, 64) ?? null,
    });
  }
  edges.sort(
    (a, b) =>
      a.source.localeCompare(b.source, "en") ||
      a.target.localeCompare(b.target, "en") ||
      a.relation.localeCompare(b.relation, "en"),
  );
  const groups = new Map<number, string[]>();
  if (analysis.success && analysis.data.communities) {
    for (const [key, members] of Object.entries(analysis.data.communities)) {
      const id = Number(key);
      if (!Number.isInteger(id) || id < 0) continue;
      groups.set(id, members.filter((member) => seen.has(member)).sort());
    }
  } else {
    for (const node of nodes) {
      if (node.community === null) continue;
      const list = groups.get(node.community) ?? [];
      list.push(node.id);
      groups.set(node.community, list);
    }
  }
  const cohesion = analysis.success ? (analysis.data.cohesion ?? {}) : {};
  const labels = analysis.success ? (analysis.data.community_labels ?? {}) : {};
  const communityList = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, GRAPH_LIMITS.max_communities)
    .map(([id, members]) => {
      const score = cohesion[String(id)];
      const label = labels[String(id)];
      return {
        id,
        label:
          label && !containsHostPath(input.root, input.dataRoot, label)
            ? label.slice(0, GRAPH_LIMITS.max_label_length)
            : null,
        cohesion:
          typeof score === "number" && score >= 0 && score <= 1 ? score : null,
        members,
      };
    });
  const digest = createHash("sha256")
    .update(canonical({ nodes, edges, communities: communityList }))
    .digest("hex");
  return KnowledgeGraphArtifactSchema.parse({
    schema_version: 1,
    producer: {
      name: "graphify",
      version: input.graphifyVersion,
      wrapper: KNOWLEDGE_GRAPH_PRODUCER,
      wrapper_version: KNOWLEDGE_GRAPH_PACKAGE_VERSION,
    },
    workspace: input.workspace,
    built_at: input.builtAt,
    content_digest: digest,
    complete: input.complete,
    nodes,
    edges,
    communities: communityList,
    stats: {
      files: input.files,
      nodes: nodes.length,
      edges: edges.length,
      communities: communityList.length,
      dropped_nodes: droppedNodes,
      dropped_edges: droppedEdges,
    },
  });
}

/** Strip host paths from subprocess diagnostics before they reach task events. */
export function redactDiagnostics(
  text: string,
  roots: string[],
  max = 240,
): string {
  let out = text;
  for (const root of roots.filter(Boolean).sort((a, b) => b.length - a.length))
    out = out.split(root).join("<private>");
  out = out.replace(
    /(?:^|(?<=[\s"'(=:]))(?:\/|[A-Za-z]:\\)[^\s"')]+/g,
    "<path>",
  );
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

function parseExtractSummary(stdout: string): { files: number } | null {
  const match = /found (\d+) code/.exec(stdout);
  return match ? { files: Number(match[1]) } : null;
}

export function createKnowledgeGraphService(
  options: KnowledgeGraphServiceOptions,
): KnowledgeGraphService {
  const command = options.command ?? ["graphify"];
  const expectedVersion = options.expectedVersion ?? GRAPHIFY_VERSION;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doctorTtl = options.doctorTtlMs ?? DEFAULT_DOCTOR_TTL_MS;
  const now = options.now ?? (() => new Date());
  const runner =
    options.runner ??
    createGraphifyRunner({
      command,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
      ...(options.env ? { env: options.env } : {}),
      ...(options.processEnv ? { processEnv: options.processEnv } : {}),
    });
  const key = (binding: GraphBinding) => ({
    owner_id: binding.owner_id,
    project_id: binding.project_id,
    workspace_id: binding.workspace_id,
    kind: KNOWLEDGE_GRAPH_ARTIFACT_KIND,
  });

  let cachedDoctor: { report: GraphDoctor; at: number } | null = null;
  const doctor = async (): Promise<GraphDoctor> => {
    if (cachedDoctor && now().getTime() - cachedDoctor.at < doctorTtl)
      return cachedDoctor.report;
    const probeRoot = join(options.dataRoot, "doctor");
    await mkdir(probeRoot, { recursive: true, mode: 0o700 });
    const result = await runner.run({
      args: ["--version"],
      cwd: probeRoot,
      timeoutMs: Math.min(timeoutMs, 30_000),
      dataRoot: probeRoot,
    });
    let report: GraphDoctor;
    const checkedAt = now().toISOString();
    if (result.spawn_error) {
      report = {
        available: false,
        version: null,
        reason: `graphify could not be started: ${result.spawn_error}`,
        checked_at: checkedAt,
      };
    } else if (result.exit_code !== 0) {
      report = {
        available: false,
        version: null,
        reason: `graphify --version exited ${result.exit_code ?? "timeout"}: ${(result.stderr || result.stdout).trim().slice(0, 240) || "no output"}`,
        checked_at: checkedAt,
      };
    } else {
      const match = /graphify\s+v?(\d+\.\d+\.\d+)/.exec(result.stdout);
      const version = match?.[1] ?? (result.stdout.trim().slice(0, 32) || null);
      report =
        version === expectedVersion
          ? { available: true, version, reason: null, checked_at: checkedAt }
          : {
              available: false,
              version,
              reason: `graphify ${version ?? "unknown"} is not the pinned ${expectedVersion}`,
              checked_at: checkedAt,
            };
    }
    cachedDoctor = { report, at: now().getTime() };
    return report;
  };

  const recordFor = (
    binding: GraphBinding,
    status: GraphBuildRecord["status"],
    extra: Partial<GraphBuildRecord>,
    summary: string,
  ): GraphBuildRecord => ({
    schema_version: 1,
    operation: "graph.build",
    status,
    workspace_id: binding.workspace_id,
    revision: binding.revision,
    content_digest: null,
    graphify_version: null,
    isolation: options.osWrapper ? "os_wrapper" : "process_env",
    stats: null,
    limitations: [],
    summary: summary.slice(0, 2048),
    recorded_at: now().toISOString(),
    ...extra,
  });

  const emit = async (binding: GraphBinding, record: GraphBuildRecord) => {
    await binding.evidence?.append(record);
    return record;
  };
  const currentRevision = async (binding: GraphBinding) =>
    binding.currentRevision
      ? await binding.currentRevision()
      : binding.revision;

  const build = async (binding: GraphBinding): Promise<GraphBuildOutcome> => {
    if (binding.approvals && !binding.approvals.read) {
      const reason = "read approval is required to build the code graph";
      return {
        status: "refused",
        reason,
        record: await emit(binding, recordFor(binding, "refused", {}, reason)),
      };
    }
    if (!isAbsolute(binding.cwd)) {
      const reason = "workspace root must be absolute";
      return {
        status: "refused",
        reason,
        record: await emit(binding, recordFor(binding, "refused", {}, reason)),
      };
    }
    const report = await doctor();
    if (!report.available) {
      const reason = report.reason ?? "graphify unavailable";
      return {
        status: "unavailable",
        reason,
        record: await emit(
          binding,
          recordFor(
            binding,
            "unavailable",
            {},
            `graphify unavailable: ${reason}`,
          ),
        ),
      };
    }
    const revision = await currentRevision(binding);
    const fenced = { ...binding, revision };
    // One private directory per build: overlapping builds for the same task
    // must never erase each other's extraction output.
    const taskRoot = join(
      options.dataRoot,
      "tasks",
      taskKey(binding.task_id),
      randomBytes(6).toString("hex"),
    );
    await mkdir(taskRoot, { recursive: true, mode: 0o700 });
    const outRoot = join(taskRoot, "out");
    const result = await runner.run({
      args: ["extract", binding.cwd, "--code-only", "--out", outRoot],
      cwd: binding.cwd,
      timeoutMs,
      dataRoot: taskRoot,
    });
    const redact = (text: string) =>
      redactDiagnostics(text, [binding.cwd, options.dataRoot]);
    const fail = async (
      reason: string,
      extra: Partial<GraphBuildRecord> = {},
    ): Promise<GraphBuildOutcome> => {
      await rm(taskRoot, { recursive: true, force: true });
      /* A failed rebuild must not leave an older graph answering as current.
         A graph already built for this very revision (for example by an
         overlapping build) describes the same tree and is kept. */
      const stored = await options.artifacts
        .read(key(binding), KnowledgeGraphArtifactSchema)
        .catch(() => null);
      const discarded =
        stored !== null && stored.value.workspace.revision !== revision;
      if (discarded)
        await options.artifacts.remove(key(binding)).catch(() => undefined);
      return {
        status: "failed",
        reason,
        record: await emit(
          fenced,
          recordFor(
            fenced,
            "failed",
            {
              graphify_version: report.version,
              limitations: discarded
                ? ["previous graph for this workspace discarded"]
                : [],
              ...extra,
            },
            `graphify build failed: ${reason}`,
          ),
        ),
      };
    };
    if (result.spawn_error)
      return fail(`spawn error: ${redact(result.spawn_error)}`);
    if (result.timed_out) return fail(`timed out after ${timeoutMs} ms`);
    if (result.exit_code !== 0)
      return fail(
        `exit ${result.exit_code}: ${redact(result.stderr || result.stdout) || "no output"}`,
      );
    const graphPath = join(outRoot, "graphify-out", "graph.json");
    const analysisPath = join(
      outRoot,
      "graphify-out",
      ".graphify_analysis.json",
    );
    let raw: unknown;
    let analysis: unknown = {};
    try {
      const bytes = await readFile(graphPath);
      if (bytes.byteLength > MAX_RAW_GRAPH_BYTES)
        return fail("graph.json exceeds the size limit");
      raw = JSON.parse(bytes.toString("utf8"));
      try {
        analysis = JSON.parse(await readFile(analysisPath, "utf8"));
      } catch {
        analysis = {};
      }
    } catch (error) {
      return fail(
        `graphify produced no graph.json (${redact(error instanceof Error ? error.message : String(error))})`,
      );
    }
    const summary = parseExtractSummary(result.stdout);
    let artifact: KnowledgeGraphArtifact;
    try {
      artifact = normalizeGraph({
        raw,
        analysis,
        root: binding.cwd,
        dataRoot: options.dataRoot,
        workspace: {
          workspace_id: binding.workspace_id,
          revision,
        },
        graphifyVersion: report.version ?? expectedVersion,
        builtAt: now().toISOString(),
        files: summary?.files ?? 0,
        complete: summary !== null,
      });
    } catch (error) {
      return fail(
        `graph.json did not match the expected shape (${redact(error instanceof Error ? error.message : String(error))})`,
      );
    }
    if (artifact.stats.nodes === 0)
      return fail(
        "graphify extracted no nodes; an empty graph is not a result",
        {
          stats: artifact.stats,
        },
      );
    if ((await currentRevision(binding)) !== revision)
      return fail(
        `workspace changed during extraction (revision ${revision} is no longer current)`,
      );
    await rm(taskRoot, { recursive: true, force: true });
    await options.artifacts.write(
      key(binding),
      revision,
      artifact,
      KnowledgeGraphArtifactSchema,
    );
    const record = await emit(
      fenced,
      recordFor(
        fenced,
        "built",
        {
          content_digest: artifact.content_digest,
          graphify_version: artifact.producer.version,
          stats: artifact.stats,
          limitations: artifact.complete ? [] : ["partial extraction"],
        },
        `code graph built: ${artifact.stats.nodes} nodes, ${artifact.stats.edges} edges, ${artifact.stats.communities} communities`,
      ),
    );
    return { status: "built", artifact, record };
  };

  const lookup = async (binding: GraphBinding): Promise<GraphLookup> => {
    const entry = await options.artifacts.read(
      key(binding),
      KnowledgeGraphArtifactSchema,
    );
    if (!entry) return { status: "not_built" };
    const revision = await currentRevision(binding);
    if (
      entry.value.workspace.revision !== revision ||
      entry.value.workspace.workspace_id !== binding.workspace_id
    )
      return {
        status: "stale",
        built_for: entry.value.workspace.revision,
        current: revision,
      };
    return { status: "ready", artifact: entry.value };
  };

  return {
    doctor,
    build,
    lookup,
    toolsFor(binding) {
      const header = (tool: string, status: string, revision: string) =>
        `[derived evidence · code knowledge graph · ${tool} · ${status} · workspace revision ${revision}]`;
      const render = (
        tool: string,
        status: string,
        revision: string,
        lines: string[],
      ) =>
        truncate(
          [header(tool, status, revision), ...lines].join("\n"),
          QUERY_LIMITS.max_render_chars,
        );
      return {
        async build() {
          const outcome = await build(binding);
          const revision = outcome.record.revision;
          if (outcome.status === "built")
            return render("mars_graph_build", "built", revision, [
              outcome.record.summary,
              `graphify ${outcome.artifact.producer.version}, digest ${outcome.artifact.content_digest.slice(0, 16)}; use mars_graph_query to explore.`,
            ]);
          return render("mars_graph_build", outcome.status, revision, [
            outcome.reason,
            outcome.status === "failed"
              ? "No graph is stored for this workspace now; nothing here counts as a built graph."
              : "Nothing was built or changed; an earlier graph for the current revision, if any, stays as it was.",
          ]);
        },
        async query(input) {
          if (binding.approvals && !binding.approvals.read)
            return render("mars_graph_query", "refused", binding.revision, [
              "read approval is required to query the code graph (it is derived from workspace files).",
            ]);
          const found = await lookup(binding);
          if (found.status === "not_built")
            return render(
              "mars_graph_query",
              "not_built",
              await currentRevision(binding),
              [
                "No code knowledge graph exists for this workspace; run mars_graph_build first.",
              ],
            );
          if (found.status === "stale")
            return render("mars_graph_query", "stale", found.current, [
              `The stored graph was built for revision ${found.built_for}, not the current ${found.current}; run mars_graph_build to rebuild. No stale answer is given.`,
            ]);
          const revision = found.artifact.workspace.revision;
          const index = indexGraph(found.artifact);
          const pick = (name: string | undefined, role: string) => {
            if (!name) throw new Error(`${role} is required`);
            const matches = resolveNodes(index, name, 5);
            const first = matches[0];
            if (!first)
              throw new Error(`no graph node matches ${role} "${name}"`);
            return { node: first, alternatives: matches.slice(1) };
          };
          try {
            if (input.kind === "neighbours") {
              const { node, alternatives } = pick(input.node, "node");
              const hits = neighbours(index, node, {
                ...(input.depth !== undefined ? { depth: input.depth } : {}),
                ...(input.limit !== undefined ? { limit: input.limit } : {}),
              });
              return render("mars_graph_query", "neighbours", revision, [
                `${describeNode(node)}${alternatives.length ? ` (other matches: ${alternatives.map((item) => item.label).join(", ")})` : ""}`,
                ...(hits.length
                  ? hits.map(
                      (hit) =>
                        `- d${hit.distance} ${hit.via.relation} ${hit.via.source === hit.node.id ? "←" : "→"} ${describeNode(hit.node)} [${hit.via.confidence}]`,
                    )
                  : ["(no neighbours)"]),
              ]);
            }
            if (input.kind === "paths") {
              const from = pick(input.from, "from");
              const to = pick(input.to, "to");
              const found = paths(index, from.node, to.node, {
                ...(input.max_depth !== undefined
                  ? { maxDepth: input.max_depth }
                  : {}),
                ...(input.limit !== undefined ? { limit: input.limit } : {}),
              });
              return render("mars_graph_query", "paths", revision, [
                `${describeNode(from.node)} → ${describeNode(to.node)}`,
                ...(found.length
                  ? found.map(
                      (path) =>
                        `- ${path.nodes.map((node) => node.label).join(" → ")} (${path.edges.map((edge) => edge.relation).join(", ")})`,
                    )
                  : ["(no path within the hop limit)"]),
              ]);
            }
            const groups = communities(index, {
              ...(input.community !== undefined
                ? { community: input.community }
                : {}),
              ...(input.limit !== undefined ? { limit: input.limit } : {}),
            });
            return render("mars_graph_query", "communities", revision, [
              ...(groups.length
                ? groups.map(
                    (group) =>
                      `- c${group.community.id}${group.community.label ? ` ${group.community.label}` : ""} [${group.size}${group.community.cohesion !== null ? `, cohesion ${group.community.cohesion.toFixed(2)}` : ""}]: ${group.members.map(describeNode).join("; ")}`,
                  )
                : ["(no matching community)"]),
            ]);
          } catch (error) {
            return render("mars_graph_query", "error", revision, [
              error instanceof Error ? error.message : String(error),
            ]);
          }
        },
      };
    },
  };
}
