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

export function packCandidates(
  candidates: RankedCandidates["candidates"],
  budget: number,
  tokenCounter: TokenCounter,
): PackedMap {
  const chosen = new Map<string, { rank: number; symbols: RenderSymbol[] }>();
  let rejected = 0;
  let considered = 0;
  let truncated = false;
  for (const candidate of candidates) {
    considered += 1;
    const previous = chosen.get(candidate.path);
    if (candidate.type === "symbol") {
      const symbols = [
        ...(previous?.symbols ?? []),
        {
          name: candidate.definition.name,
          kind: candidate.definition.kind,
          line: candidate.definition.line,
          signature: candidate.definition.signature,
          rank: candidate.rank,
          depth: candidate.definition.depth,
        },
      ];
      chosen.set(candidate.path, {
        rank: Math.max(previous?.rank ?? 0, candidate.rank),
        symbols,
      });
    } else {
      chosen.set(candidate.path, {
        rank: Math.max(previous?.rank ?? 0, candidate.rank),
        symbols: previous?.symbols ?? [],
      });
    }
    const rendered = renderChosen(chosen);
    if (tokenCounter.count(rendered) <= budget) {
      rejected = 0;
      continue;
    }
    if (previous) {
      if (candidate.type === "symbol") previous.symbols.pop();
      if (candidate.type === "file" && previous.symbols.length === 0) {
        chosen.delete(candidate.path);
      } else {
        chosen.set(candidate.path, previous);
      }
    } else {
      chosen.delete(candidate.path);
    }
    rejected += 1;
    truncated = true;
    if (rejected >= 64) break;
  }
  if (considered < candidates.length) truncated = true;
  const renderFiles = [...chosen]
    .map(([path, item]) => ({
      path,
      rank: item.rank,
      symbols: item.symbols.sort((a, b) => a.line - b.line),
    }))
    .sort(
      (left, right) => right.rank - left.rank || compare(left.path, right.path),
    );
  const text = renderFilesText(renderFiles);
  const token_count = tokenCounter.count(text);
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

function renderFilesText(files: readonly RenderFile[]): string {
  return files
    .map((file) => {
      if (file.symbols.length === 0) return file.path;
      const width = Math.max(
        ...file.symbols.map((symbol) => String(symbol.line).length),
      );
      const lines = file.symbols
        .map(
          (symbol) =>
            `  ${String(symbol.line).padStart(width, " ")}│ ${"  ".repeat(symbol.depth)}${symbol.signature}`,
        )
        .join("\n");
      return `${file.path}:\n${lines}`;
    })
    .join("\n")
    .concat(files.length > 0 ? "\n" : "");
}

function renderChosen(
  chosen: ReadonlyMap<string, { rank: number; symbols: RenderSymbol[] }>,
): string {
  const files: RenderFile[] = [...chosen]
    .map(([path, value]) => ({
      path,
      rank: value.rank,
      symbols: value.symbols,
    }))
    .sort(
      (left, right) => right.rank - left.rank || compare(left.path, right.path),
    );
  return renderFilesText(files);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
