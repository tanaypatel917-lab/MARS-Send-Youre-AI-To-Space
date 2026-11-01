import type { Definition, ExtractedFile } from "./types";

export const PYTHON_EXTRACTOR_VERSION = "python-lines-v1";

const keywords = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self cls".split(
    " ",
  ),
);

export function extractPython(text: string, maxSymbols: number): ExtractedFile {
  const lines = text.split(/\r?\n/);
  const defs: Definition[] = [];
  const refs = new Map<string, number>();
  const classes: Array<{ indent: number; name: string }> = [];
  let triple: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const code = stripPythonComments(raw, triple);
    const tripleState = updateTripleState(raw, triple);
    triple = tripleState;
    const classMatch = /^(\s*)class\s+(\w+)/.exec(code);
    const defMatch = /^(\s*)(?:async\s+)?def\s+(\w+)/.exec(code);
    const indent = (code.match(/^\s*/) ?? [""])[0]?.length ?? 0;
    while (classes.length > 0 && (classes.at(-1)?.indent ?? -1) >= indent) {
      classes.pop();
    }
    if (classMatch) {
      const name = classMatch[2] ?? "";
      classes.push({ indent, name });
      defs.push({
        name,
        kind: "class",
        line: index + 1,
        signature: declarationHeader(code),
        depth: classes.length - 1,
      });
    } else if (defMatch) {
      const name = defMatch[2] ?? "";
      let signature = code.trim();
      for (
        let next = index + 1;
        !isCompletePythonSignature(signature) &&
        next < lines.length &&
        next <= index + 5;
        next += 1
      ) {
        const nextCode = stripPythonComments(lines[next] ?? "", triple).trim();
        if (nextCode) signature += ` ${nextCode}`;
      }
      signature = declarationHeader(signature).replace(/\s+/g, " ");
      defs.push({
        name,
        kind: classes.length > 0 ? "method" : "function",
        line: index + 1,
        signature,
        depth: classes.length,
      });
    }
    const cleaned = stripSimplePythonStrings(code);
    for (const match of cleaned.matchAll(/[A-Za-z_]\w*/g)) {
      const name = match[0];
      if (!name || keywords.has(name)) continue;
      if (
        (classMatch && name === classMatch[2]) ||
        (defMatch && name === defMatch[2])
      )
        continue;
      refs.set(name, (refs.get(name) ?? 0) + 1);
    }
  }
  return {
    defs: defs.slice(0, maxSymbols),
    refs,
    droppedSymbols: Math.max(0, defs.length - maxSymbols),
  };
}

function stripPythonComments(line: string, currentTriple?: string): string {
  let tripleQuote = currentTriple;
  let quote: string | undefined;
  let result = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (tripleQuote) {
      if (line.startsWith(tripleQuote, index)) {
        index += tripleQuote.length - 1;
        tripleQuote = undefined;
      }
      continue;
    }
    if (line.startsWith("'''", index) || line.startsWith('"""', index)) {
      tripleQuote = line.slice(index, index + 3);
      index += 2;
    } else if (quote) {
      result += char;
      if (char === "\\") {
        result += line[index + 1] ?? "";
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      result += char;
    } else if (char === "#") {
      break;
    } else {
      result += char;
    }
  }
  return result;
}

function isCompletePythonSignature(signature: string): boolean {
  return topLevelColon(signature) >= 0;
}

function declarationHeader(signature: string): string {
  const colon = topLevelColon(signature);
  return (colon >= 0 ? signature.slice(0, colon) : signature).trim();
}

function topLevelColon(signature: string): number {
  const delimiters: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < signature.length; index += 1) {
    const character = signature[index] ?? "";
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "(" || character === "[" || character === "{") {
      delimiters.push(character);
    } else if (character === ")" || character === "]" || character === "}") {
      delimiters.pop();
    } else if (character === ":" && delimiters.length === 0) {
      return index;
    }
  }
  return -1;
}

function updateTripleState(line: string, initial?: string): string | undefined {
  let state = initial;
  for (let index = 0; index < line.length; index += 1) {
    if (state) {
      if (line.startsWith(state, index)) {
        index += 2;
        state = undefined;
      }
    } else if (line.startsWith("'''", index)) {
      state = "'''";
      index += 2;
    } else if (line.startsWith('"""', index)) {
      state = '"""';
      index += 2;
    } else if (line[index] === "#") {
      break;
    } else if (line[index] === "'" || line[index] === '"') {
      const quote = line[index];
      index += 1;
      while (index < line.length && line[index] !== quote) {
        if (line[index] === "\\") index += 1;
        index += 1;
      }
    }
  }
  return state;
}

function stripSimplePythonStrings(line: string): string {
  let result = "";
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else {
      result += char;
    }
  }
  return result;
}
