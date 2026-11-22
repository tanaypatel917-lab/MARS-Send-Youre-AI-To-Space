import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const CSS_PATH = new URL("../src/renderer/shell.css", import.meta.url);

const TEXT_TOKENS = [
  "fg",
  "accent",
  "success",
  "error",
  "warning",
  "muted",
  "untrustedLabel",
] as const;
const BACKGROUND_TOKENS = [
  "pageBg",
  "cardBg",
  "infoBg",
  "selectedBg",
  "customMessageBg",
] as const;

function tokens(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, value] of block.matchAll(
    /--([A-Za-z]+):\s*(#[0-9a-fA-F]{6});/g,
  ))
    if (name !== undefined && value !== undefined) found.set(name, value);
  return found;
}

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

test("the MARS desktop palette maintains WCAG 1.4.3 contrast", async () => {
  const css = await readFile(CSS_PATH, "utf8");
  const palette = tokens(css.match(/^:root\s*\{([\s\S]*?)^\}/m)?.[1] ?? "");
  const failures: string[] = [];
  for (const text of TEXT_TOKENS) {
    for (const background of BACKGROUND_TOKENS) {
      const fg = palette.get(text);
      const bg = palette.get(background);
      expect(fg, `--${text}`).toBeDefined();
      expect(bg, `--${background}`).toBeDefined();
      const ratio = contrast(fg ?? "", bg ?? "");
      if (ratio < 4.5)
        failures.push(
          `--${text} ${fg} on --${background} ${bg} = ${ratio.toFixed(2)}:1`,
        );
    }
  }
  expect(failures).toEqual([]);
});
