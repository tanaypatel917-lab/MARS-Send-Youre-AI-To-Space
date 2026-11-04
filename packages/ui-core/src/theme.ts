import { getBuiltinThemes } from "@oh-my-pi/pi-tui/theme/loader";
import darkTheme from "../themes/mars-dark.json" with { type: "json" };
import lightTheme from "../themes/mars-light.json" with { type: "json" };
import {
  type ColourDepth,
  hexToRgb,
  type Rgb,
  sgrColour,
  XTERM_16,
  xterm256ToRgb,
} from "./colour";

export type MarsThemeName = "mars-dark" | "mars-light";
export const MARS_THEME_NAMES: readonly MarsThemeName[] = [
  "mars-dark",
  "mars-light",
];

/** The only tokens MARS adds; each is an alias of an existing Oh My Pi token (§4.2). */
export const MARS_TOKEN_ALIASES = {
  paidTier: "warning",
  freeTier: "success",
  localTier: "mdLink",
  untrustedLabel: "customMessageLabel",
  verifyPass: "success",
  verifyFail: "error",
  staleFinding: "dim",
} as const;
export type MarsAlias = keyof typeof MARS_TOKEN_ALIASES;

export interface MarsThemeJson {
  name: string;
  mars: { extends: string; aliases: Record<string, string> };
  vars?: Record<string, string | number>;
  colors: Record<string, string | number>;
  terminal?: { ansi?: (string | number)[] };
  [key: string]: unknown;
}

export const MARS_THEMES: Record<MarsThemeName, MarsThemeJson> = {
  "mars-dark": darkTheme as MarsThemeJson,
  "mars-light": lightTheme as MarsThemeJson,
};

/** The Oh My Pi theme a MARS theme extends, for the alias-only check. */
export function baseTheme(name: MarsThemeName): MarsThemeJson {
  const base = getBuiltinThemes()[MARS_THEMES[name].mars.extends];
  if (!base) throw new Error(`Unknown base theme for ${name}.`);
  return base as unknown as MarsThemeJson;
}

function resolveValue(
  theme: MarsThemeJson,
  value: string | number | undefined,
  depth = 0,
): Rgb | null {
  if (value === undefined || value === "" || depth > 8) return null;
  if (typeof value === "number") return xterm256ToRgb(value);
  const rgb = hexToRgb(value);
  if (rgb) return rgb;
  return resolveValue(theme, theme.vars?.[value], depth + 1);
}

export function resolveToken(theme: MarsThemeJson, token: string): Rgb | null {
  const target = (theme.mars.aliases[token] ?? token) as string;
  return resolveValue(theme, theme.colors[target]);
}

export interface Painter {
  readonly depth: ColourDepth;
  readonly theme: MarsThemeName;
  fg(token: string, text: string): string;
  bg(token: string, text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  strike(text: string): string;
  inverse(text: string): string;
}

/** Token → SGR for one depth. `none` (NO_COLOR) emits no escape sequences at all. */
const painters = new Map<string, Painter>();

/** Memoized per theme × depth so render caches can key on painter identity. */
export function createPainter(
  themeName: MarsThemeName,
  depth: ColourDepth,
): Painter {
  const key = `${themeName}|${depth}`;
  let painter = painters.get(key);
  if (!painter) {
    painter = buildPainter(themeName, depth);
    painters.set(key, painter);
  }
  return painter;
}

function buildPainter(themeName: MarsThemeName, depth: ColourDepth): Painter {
  const theme = MARS_THEMES[themeName];
  const palette: readonly Rgb[] =
    theme.terminal?.ansi?.length === 16
      ? theme.terminal.ansi.map(
          (value, index) =>
            resolveValue(theme, value) ?? XTERM_16[index] ?? [0, 0, 0],
        )
      : XTERM_16;
  const cache = new Map<string, string | null>();
  const open = (token: string, layer: "fg" | "bg") => {
    const key = `${layer}:${token}`;
    if (!cache.has(key))
      cache.set(
        key,
        sgrColour(resolveToken(theme, token), depth, layer, palette),
      );
    return cache.get(key) ?? null;
  };
  const plain = depth === "none";
  const wrap = (code: string | null, close: string, text: string) =>
    code === null || text === "" ? text : `\x1b[${code}m${text}\x1b[${close}m`;
  return {
    depth,
    theme: themeName,
    fg: (token, text) => wrap(open(token, "fg"), "39", text),
    bg: (token, text) => wrap(open(token, "bg"), "49", text),
    bold: (text) => (plain ? text : wrap("1", "22", text)),
    dim: (text) => (plain ? text : wrap("2", "22", text)),
    strike: (text) => (plain ? text : wrap("9", "29", text)),
    inverse: (text) => (plain ? text : wrap("7", "27", text)),
  };
}
