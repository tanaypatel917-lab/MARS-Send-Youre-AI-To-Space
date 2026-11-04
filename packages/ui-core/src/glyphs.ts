import {
  SPINNER_FRAMES,
  SYMBOL_PRESETS,
  type SymbolPreset,
} from "@oh-my-pi/pi-tui/theme/symbols";

export type GlyphPreset = SymbolPreset;
export const GLYPH_PRESETS: readonly GlyphPreset[] = [
  "unicode",
  "nerd",
  "ascii",
];

export interface Glyphs {
  readonly preset: GlyphPreset;
  readonly ok: string;
  readonly fail: string;
  readonly warning: string;
  readonly info: string;
  readonly pending: string;
  readonly running: string;
  readonly blocked: string;
  readonly collapsed: string;
  readonly expanded: string;
  readonly branch: string;
  readonly last: string;
  readonly user: string;
  readonly connector: string;
  readonly thinking: string;
  readonly sum: string;
  readonly dot: string;
  readonly rail: string;
  readonly arrow: string;
  readonly filled: string;
  readonly empty: string;
  readonly hr: string;
  readonly spinner: readonly string[];
  readonly box: {
    tl: string;
    tr: string;
    bl: string;
    br: string;
    h: string;
    v: string;
  };
}

/** MARS rows the Oh My Pi symbol table has no key for (§2.1 transcript grammar). */
const MARS_ROWS: Record<
  GlyphPreset,
  Pick<
    Glyphs,
    | "user"
    | "connector"
    | "thinking"
    | "sum"
    | "rail"
    | "arrow"
    | "blocked"
    | "hr"
  >
> = {
  unicode: {
    user: "❯",
    connector: "⎿",
    thinking: "∴",
    sum: "Σ",
    rail: "┊",
    arrow: "→",
    blocked: "⊘",
    hr: "─",
  },
  nerd: {
    user: "❯",
    connector: "⎿",
    thinking: "∴",
    sum: "Σ",
    rail: "┊",
    arrow: "→",
    blocked: "⊘",
    hr: "─",
  },
  ascii: {
    user: ">",
    connector: "\\_",
    thinking: "~",
    sum: "sum",
    rail: "|",
    arrow: "->",
    blocked: "x",
    hr: "-",
  },
};

export function glyphs(preset: GlyphPreset): Glyphs {
  const symbols = SYMBOL_PRESETS[preset];
  return {
    preset,
    ok: symbols["status.success"],
    fail: symbols["status.error"],
    warning: symbols["status.warning"],
    info: symbols["status.info"],
    pending: symbols["status.pending"],
    running: symbols["status.running"],
    collapsed: symbols["nav.expand"],
    expanded: symbols["nav.collapse"],
    branch: symbols["tree.branch"],
    last: symbols["tree.last"],
    dot: symbols["sep.dot"],
    filled: symbols["progress.filled"],
    empty: symbols["progress.empty"],
    spinner: SPINNER_FRAMES[preset].activity,
    box: {
      tl: symbols["boxRound.topLeft"],
      tr: symbols["boxRound.topRight"],
      bl: symbols["boxRound.bottomLeft"],
      br: symbols["boxRound.bottomRight"],
      h: symbols["boxRound.horizontal"],
      v: symbols["boxRound.vertical"],
    },
    ...MARS_ROWS[preset],
  };
}

/** `MARS_SYMBOLS` picks the preset; anything unknown falls back to `unicode`. */
export function glyphPresetFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): GlyphPreset {
  const value = env.MARS_SYMBOLS;
  return value && (GLYPH_PRESETS as readonly string[]).includes(value)
    ? (value as GlyphPreset)
    : "unicode";
}
