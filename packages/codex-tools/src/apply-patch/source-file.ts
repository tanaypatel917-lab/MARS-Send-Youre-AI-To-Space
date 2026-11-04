// Portions derived from openai/codex (https://github.com/openai/codex), file
// codex-rs/apply-patch/src/text_file.rs at revision f58acd6ede312266a7a0eaa63fd8dadacb4de239.
// Copyright 2025 OpenAI. Licensed under the Apache License, Version 2.0; see
// packages/codex-tools/third_party/codex/LICENSE.txt. Modified by MARS (TypeScript port).

/** `[startIndex, oldLength, newLines]` in source order, non-overlapping. */
export type Replacement = [number, number, string[]];

type LineEnding = "\n" | "\r\n" | "\r";

interface SourceLine {
  text: string;
  ending: LineEnding | null;
}

/**
 * A text file split into logical lines that keep their own terminators, so an
 * update preserves LF/CRLF/CR per line. Inserted lines take the first ending
 * seen in the file (LF when the file has none); after an update every line is
 * terminated, matching apply_patch's historical trailing-newline behaviour.
 */
export class SourceFile {
  private lines: SourceLine[];
  private readonly preferredEnding: LineEnding;

  private constructor(lines: SourceLine[], preferredEnding: LineEnding) {
    this.lines = lines;
    this.preferredEnding = preferredEnding;
  }

  static parse(contents: string): SourceFile {
    const lines: SourceLine[] = [];
    let preferred: LineEnding | null = null;
    let lineStart = 0;
    let cursor = 0;
    while (cursor < contents.length) {
      const ch = contents.charCodeAt(cursor);
      let ending: LineEnding;
      if (ch === 0x0d) {
        ending = contents.charCodeAt(cursor + 1) === 0x0a ? "\r\n" : "\r";
      } else if (ch === 0x0a) {
        ending = "\n";
      } else {
        cursor += 1;
        continue;
      }
      preferred ??= ending;
      lines.push({ text: contents.slice(lineStart, cursor), ending });
      cursor += ending.length;
      lineStart = cursor;
    }
    if (lineStart < contents.length) {
      lines.push({ text: contents.slice(lineStart), ending: null });
    }
    return new SourceFile(lines, preferred ?? "\n");
  }

  lineTexts(): string[] {
    return this.lines.map((line) => line.text);
  }

  applyReplacements(replacements: readonly Replacement[]): void {
    const source = this.lines;
    const next: SourceLine[] = [];
    let sourceIndex = 0;
    for (const [startIndex, oldLength, segment] of replacements) {
      for (let i = sourceIndex; i < startIndex; i += 1) {
        const line = source[i];
        if (line) {
          next.push(line);
        }
      }
      for (const text of segment) {
        next.push({ text, ending: this.preferredEnding });
      }
      sourceIndex = startIndex + oldLength;
    }
    for (let i = sourceIndex; i < source.length; i += 1) {
      const line = source[i];
      if (line) {
        next.push(line);
      }
    }
    for (const line of next) {
      line.ending ??= this.preferredEnding;
    }
    this.lines = next;
  }

  contents(): string {
    let out = "";
    for (const line of this.lines) {
      out += line.text;
      if (line.ending) {
        out += line.ending;
      }
    }
    return out;
  }
}
