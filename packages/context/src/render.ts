import type {
  RankedCandidates,
  RepositoryMapFile,
  RepositoryMapSymbol,
  TokenCounter,
} from "./types";

export interface PackedMap {
  files: RepositoryMapFile[];
  text: string;
  token_count: number;
  truncated: boolean;
  candidates: number;
  selected_symbols: number;
}

type RenderSymbol = RepositoryMapSymbol & { depth: number };
type RenderFile = Omit<RepositoryMapFile, "symbols"> & {
  symbols: RenderSymbol[];
};
type Candidate = RankedCandidates["candidates"][number];
type ChosenFile = { rank: number; units: Candidate[] };

export function packCandidates(
  candidates: RankedCandidates["candidates"],
  budget: number,
  tokenCounter: TokenCounter,
): PackedMap {
  const chosen = new Map<string, ChosenFile>();
  const accepted: Array<{ candidate: Candidate; cost: number }> = [];
  const lineWidths = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.type !== "symbol") continue;
    lineWidths.set(
      candidate.path,
      Math.max(
        lineWidths.get(candidate.path) ?? 0,
        String(candidate.definition.line).length,
      ),
    );
  }
  let runningSum = 0;
  let rejected = 0;
  let considered = 0;
  let truncated = false;
  for (const candidate of candidates) {
    considered += 1;
    const previous = chosen.get(candidate.path);
    const cost =
      candidate.type === "symbol"
        ? tokenCounter.count(
            `${renderSymbolLine(
              candidate.definition,
              lineWidths.get(candidate.path) ?? 1,
            )}\n`,
          ) + (previous ? 0 : tokenCounter.count(`${candidate.path}:\n`))
        : previous
          ? 0
          : tokenCounter.count(`${candidate.path}\n`);
    if (runningSum + cost <= budget) {
      const selected = previous ?? { rank: candidate.rank, units: [] };
      selected.rank = Math.max(selected.rank, candidate.rank);
      selected.units.push(candidate);
      chosen.set(candidate.path, selected);
      accepted.push({ candidate, cost });
      runningSum += cost;
      rejected = 0;
      continue;
    }
    rejected += 1;
    truncated = true;
    if (rejected >= 64) break;
  }
  if (considered < candidates.length) truncated = true;
  let renderFiles = chosenFiles(chosen);
  let text = renderFilesText(renderFiles, lineWidths);
  let token_count = tokenCounter.count(text);
  while (token_count > budget && accepted.length > 0) {
    const removed = accepted.pop();
    if (!removed) break;
    runningSum -= removed.cost;
    const file = chosen.get(removed.candidate.path);
    if (file) {
      file.units.pop();
      if (file.units.length === 0) {
        chosen.delete(removed.candidate.path);
      } else {
        file.rank = Math.max(...file.units.map((unit) => unit.rank));
      }
    }
    truncated = true;
    renderFiles = chosenFiles(chosen);
    text = renderFilesText(renderFiles, lineWidths);
    token_count = tokenCounter.count(text);
  }
  if (token_count > budget)
    throw new Error("Repository map budget invariant failed");
  const files: RepositoryMapFile[] = renderFiles.map((file) => ({
    path: file.path,
    rank: file.rank,
    symbols: file.symbols.map(({ depth: _depth, ...symbol }) => symbol),
  }));
  return {
    files,
    text,
    token_count,
    truncated: truncated || rejected > 0,
    candidates: candidates.length,
    selected_symbols: files.reduce(
      (count, file) => count + file.symbols.length,
      0,
    ),
  };
}

export function renderFiles(files: readonly RepositoryMapFile[]): string {
  return renderFilesText(
    files.map((file) => ({
      path: file.path,
      rank: file.rank,
      symbols: file.symbols as RenderSymbol[],
    })),
  );
}

function renderFilesText(
  files: readonly RenderFile[],
  lineWidths?: ReadonlyMap<string, number>,
): string {
  return files
    .map((file) => {
      if (file.symbols.length === 0) return file.path;
      const width =
        lineWidths?.get(file.path) ??
        Math.max(...file.symbols.map((symbol) => String(symbol.line).length));
      const lines = file.symbols
        .map((symbol) => renderSymbolLine(symbol, width))
        .join("\n");
      return `${file.path}:\n${lines}`;
    })
    .join("\n")
    .concat(files.length > 0 ? "\n" : "");
}

function chosenFiles(chosen: ReadonlyMap<string, ChosenFile>): RenderFile[] {
  return [...chosen]
    .map(([path, value]) => ({
      path,
      rank: value.rank,
      symbols: value.units
        .filter(
          (unit): unit is Extract<Candidate, { type: "symbol" }> =>
            unit.type === "symbol",
        )
        .map((unit) => ({
          name: unit.definition.name,
          kind: unit.definition.kind,
          line: unit.definition.line,
          signature: unit.definition.signature,
          rank: unit.rank,
          depth: unit.definition.depth,
        }))
        .sort((left, right) => left.line - right.line),
    }))
    .sort(
      (left, right) => right.rank - left.rank || compare(left.path, right.path),
    );
}

function renderSymbolLine(
  symbol: Pick<RenderSymbol, "line" | "depth" | "signature">,
  width: number,
): string {
  return `  ${String(symbol.line).padStart(width, " ")}│ ${"  ".repeat(symbol.depth)}${symbol.signature}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
