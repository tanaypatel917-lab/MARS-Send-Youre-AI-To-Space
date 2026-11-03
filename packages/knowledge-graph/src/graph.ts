import type {
  GraphCommunity,
  GraphEdge,
  GraphNode,
  KnowledgeGraphArtifact,
} from "./schema";

/**
 * Pure, deterministic queries over a knowledge-graph artifact. Nothing here
 * touches the filesystem or a model; callers render results as untrusted,
 * derived evidence.
 */

export const QUERY_LIMITS = {
  max_depth: 4,
  max_path_depth: 8,
  max_results: 100,
  default_results: 25,
  max_path_results: 5,
  max_render_chars: 12 * 1024,
} as const;

export interface GraphIndex {
  readonly artifact: KnowledgeGraphArtifact;
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly outgoing: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly incoming: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly communities: ReadonlyMap<number, GraphCommunity>;
}

const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const byEdge = (a: GraphEdge, b: GraphEdge) =>
  a.source.localeCompare(b.source, "en") ||
  a.target.localeCompare(b.target, "en") ||
  a.relation.localeCompare(b.relation, "en");

export function indexGraph(artifact: KnowledgeGraphArtifact): GraphIndex {
  const nodes = new Map<string, GraphNode>();
  for (const node of [...artifact.nodes].sort(byId)) nodes.set(node.id, node);
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of [...artifact.edges].sort(byEdge)) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
    push(outgoing, edge.source, edge);
    push(incoming, edge.target, edge);
  }
  const communities = new Map<number, GraphCommunity>();
  for (const community of [...artifact.communities].sort((a, b) => a.id - b.id))
    communities.set(community.id, community);
  return { artifact, nodes, outgoing, incoming, communities };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Resolve a user-supplied name to nodes: exact id, then exact label, then a
 * case-insensitive label/path match. Deterministic order, bounded count.
 */
export function resolveNodes(
  index: GraphIndex,
  query: string,
  limit = QUERY_LIMITS.default_results,
): GraphNode[] {
  const exact = index.nodes.get(query);
  if (exact) return [exact];
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const labelled: GraphNode[] = [];
  const fuzzy: GraphNode[] = [];
  for (const node of index.nodes.values()) {
    const label = node.label.toLowerCase();
    if (label === needle) labelled.push(node);
    else if (
      label.includes(needle) ||
      (node.source_file?.toLowerCase().includes(needle) ?? false)
    )
      fuzzy.push(node);
  }
  return [...labelled, ...fuzzy].slice(0, Math.max(1, limit));
}

export interface NeighbourHit {
  node: GraphNode;
  distance: number;
  via: GraphEdge;
}

export function neighbours(
  index: GraphIndex,
  start: GraphNode,
  options: { depth?: number; limit?: number } = {},
): NeighbourHit[] {
  const depth = clamp(options.depth ?? 1, 1, QUERY_LIMITS.max_depth);
  const limit = clamp(
    options.limit ?? QUERY_LIMITS.default_results,
    1,
    QUERY_LIMITS.max_results,
  );
  const seen = new Set<string>([start.id]);
  const hits: NeighbourHit[] = [];
  let frontier = [start.id];
  for (let distance = 1; distance <= depth && frontier.length; distance++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of adjacent(index, id)) {
        const other = edge.source === id ? edge.target : edge.source;
        if (seen.has(other)) continue;
        seen.add(other);
        const node = index.nodes.get(other);
        if (!node) continue;
        hits.push({ node, distance, via: edge });
        next.push(other);
        if (hits.length >= limit) return hits;
      }
    }
    frontier = next;
  }
  return hits;
}

function adjacent(index: GraphIndex, id: string): GraphEdge[] {
  return [...(index.outgoing.get(id) ?? []), ...(index.incoming.get(id) ?? [])];
}

export interface GraphPath {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Shortest undirected paths (breadth-first), at most `limit`, each at most `maxDepth` hops. */
export function paths(
  index: GraphIndex,
  from: GraphNode,
  to: GraphNode,
  options: { maxDepth?: number; limit?: number } = {},
): GraphPath[] {
  const maxDepth = clamp(options.maxDepth ?? 6, 1, QUERY_LIMITS.max_path_depth);
  const limit = clamp(options.limit ?? 3, 1, QUERY_LIMITS.max_path_results);
  if (from.id === to.id) return [{ nodes: [from], edges: [] }];
  const found: GraphPath[] = [];
  const queue: Array<{ id: string; nodes: GraphNode[]; edges: GraphEdge[] }> =
    [{ id: from.id, nodes: [from], edges: [] }];
  const depthSeen = new Map<string, number>([[from.id, 0]]);
  let shortest: number | null = null;
  let expansions = 0;
  while (queue.length && expansions < 50_000) {
    const current = queue.shift();
    if (!current) break;
    expansions++;
    const length = current.edges.length;
    if (shortest !== null && length >= shortest) break;
    if (length >= maxDepth) continue;
    for (const edge of adjacent(index, current.id)) {
      const other = edge.source === current.id ? edge.target : edge.source;
      const node = index.nodes.get(other);
      if (!node || current.nodes.some((item) => item.id === other)) continue;
      const nodes = [...current.nodes, node];
      const edges = [...current.edges, edge];
      if (other === to.id) {
        shortest ??= edges.length;
        found.push({ nodes, edges });
        if (found.length >= limit) return found;
        continue;
      }
      const previous = depthSeen.get(other);
      if (previous !== undefined && previous < edges.length) continue;
      depthSeen.set(other, edges.length);
      queue.push({ id: other, nodes, edges });
    }
  }
  return found;
}

export interface CommunityView {
  community: GraphCommunity;
  size: number;
  members: GraphNode[];
}

export function communities(
  index: GraphIndex,
  options: { community?: number; limit?: number; members?: number } = {},
): CommunityView[] {
  const limit = clamp(
    options.limit ?? QUERY_LIMITS.default_results,
    1,
    QUERY_LIMITS.max_results,
  );
  const memberLimit = clamp(options.members ?? 12, 1, QUERY_LIMITS.max_results);
  const selected =
    options.community === undefined
      ? [...index.communities.values()]
      : [index.communities.get(options.community)].filter(
          (item): item is GraphCommunity => item !== undefined,
        );
  return selected
    .map((community) => ({
      community,
      size: community.members.length,
      members: community.members
        .map((id) => index.nodes.get(id))
        .filter((node): node is GraphNode => node !== undefined)
        .sort(byId)
        .slice(0, memberLimit),
    }))
    .sort((a, b) => b.size - a.size || a.community.id - b.community.id)
    .slice(0, limit);
}

export function degree(index: GraphIndex, id: string): number {
  return (
    (index.outgoing.get(id)?.length ?? 0) + (index.incoming.get(id)?.length ?? 0)
  );
}

export function hubs(index: GraphIndex, limit = 10): GraphNode[] {
  return [...index.nodes.values()]
    .map((node) => ({ node, degree: degree(index, node.id) }))
    .sort((a, b) => b.degree - a.degree || byId(a.node, b.node))
    .slice(0, clamp(limit, 1, QUERY_LIMITS.max_results))
    .map((item) => item.node);
}

export function describeNode(node: GraphNode): string {
  const where = node.source_file
    ? ` (${node.source_file}${node.source_location ? `:${node.source_location}` : ""})`
    : "";
  const community = node.community === null ? "" : ` c${node.community}`;
  return `${node.label}${where}${community}`;
}

/**
 * Deterministic, budgeted plain-text summary for context packing. Only
 * labels, relative paths and counts appear; never absolute host paths.
 */
export function summarize(
  artifact: KnowledgeGraphArtifact,
  maxChars: number,
): string {
  const index = indexGraph(artifact);
  const lines: string[] = [
    `graphify ${artifact.producer.version} · workspace revision ${artifact.workspace.revision} · ${artifact.stats.files} files, ${artifact.stats.nodes} nodes, ${artifact.stats.edges} edges, ${artifact.stats.communities} communities${artifact.complete ? "" : " · partial extraction"}`,
  ];
  const groups = communities(index, { limit: 12, members: 8 });
  if (groups.length) {
    lines.push("Communities (largest first):");
    for (const group of groups)
      lines.push(
        `- c${group.community.id}${group.community.label ? ` ${group.community.label}` : ""} [${group.size}]: ${group.members.map((node) => node.label).join(", ")}`,
      );
  }
  const central = hubs(index, 10);
  if (central.length) {
    lines.push("Most connected:");
    for (const node of central)
      lines.push(`- ${describeNode(node)} degree ${degree(index, node.id)}`);
  }
  return truncate(lines.join("\n"), maxChars);
}

export function truncate(text: string, maxChars: number): string {
  const budget = Math.max(0, Math.floor(maxChars));
  if (text.length <= budget) return text;
  if (budget < 16) return text.slice(0, budget);
  return `${text.slice(0, budget - 12)}\n…truncated`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
