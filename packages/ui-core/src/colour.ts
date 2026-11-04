export type ColourDepth = "truecolor" | "256" | "16" | "none";
export const COLOUR_DEPTHS: readonly ColourDepth[] = [
  "truecolor",
  "256",
  "16",
  "none",
];

export type Rgb = readonly [number, number, number];

/** NO_COLOR wins; MARS_COLOR forces a depth; otherwise COLORTERM/TERM decide. */
export function detectColourDepth(
  env: Readonly<Record<string, string | undefined>>,
): ColourDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  const forced = env.MARS_COLOR;
  if (forced && (COLOUR_DEPTHS as readonly string[]).includes(forced))
    return forced as ColourDepth;
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  const term = (env.TERM ?? "").toLowerCase();
  if (term === "dumb") return "none";
  if (term.includes("256")) return "256";
  return "16";
}

export function hexToRgb(hex: string): Rgb | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) return null;
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** The xterm default 16-colour palette, used when a theme carries no `terminal.ansi`. */
export const XTERM_16: readonly Rgb[] = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

const CUBE = [0, 95, 135, 175, 215, 255];

function distance(a: Rgb, b: Rgb): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

export function xterm256ToRgb(index: number): Rgb {
  if (index < 16) return XTERM_16[index] ?? [0, 0, 0];
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return [level, level, level];
  }
  const offset = index - 16;
  return [
    CUBE[Math.floor(offset / 36)] ?? 0,
    CUBE[Math.floor(offset / 6) % 6] ?? 0,
    CUBE[offset % 6] ?? 0,
  ];
}

export function rgbTo256(rgb: Rgb): number {
  let best = 16;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 16; index < 256; index++) {
    const d = distance(rgb, xterm256ToRgb(index));
    if (d < bestDistance) {
      best = index;
      bestDistance = d;
    }
  }
  return best;
}

export function rgbTo16(rgb: Rgb, palette: readonly Rgb[] = XTERM_16): number {
  let best = 7;
  let bestDistance = Number.POSITIVE_INFINITY;
  palette.forEach((candidate, index) => {
    const d = distance(rgb, candidate);
    if (d < bestDistance) {
      best = index;
      bestDistance = d;
    }
  });
  return best;
}

/** SGR parameters for one colour at a depth; `null` means terminal default. */
export function sgrColour(
  rgb: Rgb | null,
  depth: ColourDepth,
  layer: "fg" | "bg",
  palette: readonly Rgb[] = XTERM_16,
): string | null {
  if (!rgb || depth === "none") return null;
  if (depth === "truecolor")
    return `${layer === "fg" ? 38 : 48};2;${rgb[0]};${rgb[1]};${rgb[2]}`;
  if (depth === "256") return `${layer === "fg" ? 38 : 48};5;${rgbTo256(rgb)}`;
  const index = rgbTo16(rgb, palette);
  const base = layer === "fg" ? 30 : 40;
  return String(index < 8 ? base + index : base + 60 + (index - 8));
}
