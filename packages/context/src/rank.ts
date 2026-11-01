import type { Definition, InventoryFile, RankedCandidates } from "./types";

// Portions adapted from Aider; see packages/context/NOTICE.
export function rankFiles(
  files: readonly InventoryFile[],
  mentionedFiles: ReadonlySet<string>,
  mentionedIdents: ReadonlySet<string>,
  query: string,
  maxCandidates: number,
  check: () => void,
): RankedCandidates {
  const sorted = [...files].sort((left, right) =>
    compare(left.path, right.path),
  );
  const queryTerms = new Set(
    (query.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [])
      .filter((term) => term.length >= 3)
      .map((term) => term.toLowerCase()),
  );
  const normalizedMentions = new Set(
    [...mentionedIdents].map((ident) => ident.toLowerCase()),
  );
  const defines = new Map<string, Set<string>>();
  const references = new Map<string, Map<string, number>>();
  const defsByFileAndName = new Map<string, Definition[]>();
  for (const file of sorted) {
    for (const definition of file.defs) {
      const definers = defines.get(definition.name) ?? new Set<string>();
      definers.add(file.path);
      defines.set(definition.name, definers);
      const key = `${file.path}\0${definition.name}`;
      const sameName = defsByFileAndName.get(key) ?? [];
      sameName.push(definition);
      defsByFileAndName.set(key, sameName);
    }
    for (const [ident, count] of file.refs) {
      const referencers = references.get(ident) ?? new Map<string, number>();
      referencers.set(file.path, count);
      references.set(ident, referencers);
    }
  }
  if (references.size === 0) {
    for (const [ident, definers] of defines) {
      references.set(ident, new Map([...definers].map((path) => [path, 1])));
    }
  }

  const personalization = new Map<string, number>();
  const base = sorted.length > 0 ? 100 / sorted.length : 0;
  for (const file of sorted) {
    let amount = 0;
    if (mentionedFiles.has(file.path)) amount = base;
    const pathParts = file.path.toLowerCase().split("/");
    const basename = pathParts.at(-1) ?? "";
    const basenameWithoutExtension = basename.replace(/\.[^.]*$/, "");
    if (
      [...pathParts, basename, basenameWithoutExtension].some(
        (part) => normalizedMentions.has(part) || queryTerms.has(part),
      )
    ) {
      amount += base;
    }
    if (
      file.defs.some((definition) =>
        normalizedMentions.has(definition.name.toLowerCase()),
      )
    ) {
      amount += base;
    }
    if (amount > 0) personalization.set(file.path, amount);
  }

  const weightedEdges = new Map<string, number>();
  const edgesByIdent: Array<{
    source: string;
    target: string;
    ident: string;
    weight: number;
  }> = [];
  const nodes = new Set<string>();
  for (const ident of [...defines.keys()].sort(compare)) {
    const definers = [...(defines.get(ident) ?? [])].sort(compare);
    const referencers = references.get(ident);
    if (!referencers) {
      for (const definer of definers) {
        addEdge(definer, definer, ident, 0.1);
      }
      continue;
    }
    let multiplier = 1;
    if (normalizedMentions.has(ident.toLowerCase())) multiplier *= 10;
    const hasCaseShape =
      (ident.includes("_") && /[A-Za-z]/.test(ident)) ||
      (ident.includes("-") && /[A-Za-z]/.test(ident)) ||
      (/[A-Z]/.test(ident) && /[a-z]/.test(ident));
    if (hasCaseShape && ident.length >= 8) multiplier *= 10;
    if (ident.startsWith("_")) multiplier *= 0.1;
    if (definers.length > 5) multiplier *= 0.1;
    for (const [referencer, count] of [...referencers].sort(([a], [b]) =>
      compare(a, b),
    )) {
      for (const definer of definers) {
        const weight =
          multiplier *
          (mentionedFiles.has(referencer) ? 50 : 1) *
          Math.sqrt(count);
        addEdge(referencer, definer, ident, weight);
      }
    }
  }

  const nodeList = [...nodes].sort(compare);
  const ranks = pageRank(nodeList, weightedEdges, personalization, check);
  const distribution = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const [key, weight] of weightedEdges) {
    const separator = key.indexOf("\0");
    const source = key.slice(0, separator);
    outgoing.set(source, (outgoing.get(source) ?? 0) + weight);
  }
  for (const edge of edgesByIdent) {
    const totalOutgoing = outgoing.get(edge.source) ?? 0;
    if (totalOutgoing <= 0) continue;
    const key = `${edge.target}\0${edge.ident}`;
    distribution.set(
      key,
      (distribution.get(key) ?? 0) +
        ((ranks.get(edge.source) ?? 0) * edge.weight) / totalOutgoing,
    );
  }

  const rankedSymbols = [...distribution]
    .map(([key, rank]) => {
      const [path = "", name = ""] = key.split("\0");
      return { path, name, rank };
    })
    .sort(
      (left, right) =>
        right.rank - left.rank ||
        compare(left.path, right.path) ||
        compare(left.name, right.name),
    );
  const candidates: RankedCandidates["candidates"] = [];
  const candidateFiles = new Set<string>();
  let truncated = false;
  for (const ranked of rankedSymbols) {
    const defs = defsByFileAndName.get(`${ranked.path}\0${ranked.name}`) ?? [];
    for (const definition of [...defs].sort((a, b) => a.line - b.line)) {
      if (candidates.length >= maxCandidates) {
        truncated = true;
        break;
      }
      candidates.push({
        type: "symbol",
        path: ranked.path,
        definition,
        rank: ranked.rank,
      });
      candidateFiles.add(ranked.path);
    }
    if (truncated) break;
  }
  const fileRanks = new Map<string, number>();
  for (const [path, rank] of ranks) fileRanks.set(path, rank);
  for (const file of sorted) {
    if (!fileRanks.has(file.path)) fileRanks.set(file.path, 0);
  }
  for (const file of [...sorted].sort(
    (left, right) =>
      (fileRanks.get(right.path) ?? 0) - (fileRanks.get(left.path) ?? 0) ||
      compare(left.path, right.path),
  )) {
    if (candidateFiles.has(file.path) || file.defs.length > 0) continue;
    if (candidates.length >= maxCandidates) {
      truncated = true;
      break;
    }
    candidates.push({
      type: "file",
      path: file.path,
      rank: fileRanks.get(file.path) ?? 0,
    });
    candidateFiles.add(file.path);
  }
  return { candidates, fileRanks, truncated };

  function addEdge(
    source: string,
    target: string,
    ident: string,
    weight: number,
  ): void {
    nodes.add(source);
    nodes.add(target);
    const key = `${source}\0${target}`;
    weightedEdges.set(key, (weightedEdges.get(key) ?? 0) + weight);
    edgesByIdent.push({ source, target, ident, weight });
  }
}

function pageRank(
  nodes: readonly string[],
  weights: ReadonlyMap<string, number>,
  personalization: ReadonlyMap<string, number>,
  check: () => void,
): Map<string, number> {
  if (nodes.length === 0) return new Map();
  const sumPersonalization = nodes.reduce(
    (total, node) => total + (personalization.get(node) ?? 0),
    0,
  );
  const vector = new Map(
    nodes.map((node) => [
      node,
      sumPersonalization > 0
        ? (personalization.get(node) ?? 0) / sumPersonalization
        : 1 / nodes.length,
    ]),
  );
  const outgoing = new Map<string, number>();
  for (const [key, weight] of weights) {
    const source = key.slice(0, key.indexOf("\0"));
    outgoing.set(source, (outgoing.get(source) ?? 0) + weight);
  }
  let rank = new Map(vector);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    let dangling = 0;
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index] as string;
      if (!outgoing.has(node)) dangling += rank.get(node) ?? 0;
    }
    const next = new Map<string, number>();
    let index = 0;
    for (const node of nodes) {
      let incoming = 0;
      for (const [key, weight] of weights) {
        const separator = key.indexOf("\0");
        if (key.slice(separator + 1) !== node) continue;
        const source = key.slice(0, separator);
        incoming +=
          ((rank.get(source) ?? 0) * weight) / (outgoing.get(source) ?? 1);
      }
      next.set(
        node,
        0.15 * (vector.get(node) ?? 0) +
          0.85 * (incoming + dangling * (vector.get(node) ?? 0)),
      );
      index += 1;
      if (index % 1000 === 0) check();
    }
    let difference = 0;
    for (const node of nodes) {
      difference += Math.abs((next.get(node) ?? 0) - (rank.get(node) ?? 0));
    }
    rank = next;
    if (difference < nodes.length * 1e-6) break;
  }
  return rank;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
