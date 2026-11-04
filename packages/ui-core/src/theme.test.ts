import { describe, expect, test } from "bun:test";
import { createTheme } from "@oh-my-pi/pi-tui/theme/loader";
import { validateThemeJson } from "@oh-my-pi/pi-tui/theme/schema-validation";
import { detectColourDepth } from "./colour";
import {
  baseTheme,
  createPainter,
  MARS_THEME_NAMES,
  MARS_THEMES,
  MARS_TOKEN_ALIASES,
} from "./theme";

describe("themes (criterion 9)", () => {
  for (const name of MARS_THEME_NAMES) {
    test(`${name} validates against the pi-tui theme schema`, () => {
      expect(() => validateThemeJson(MARS_THEMES[name])).not.toThrow();
      expect(() => createTheme(MARS_THEMES[name] as never)).not.toThrow();
    });
    test(`${name} only aliases existing tokens`, () => {
      const theme = MARS_THEMES[name];
      const base = baseTheme(name);
      expect(theme.colors).toEqual(base.colors);
      expect(theme.vars).toEqual(base.vars);
      expect(theme.mars.aliases).toEqual({ ...MARS_TOKEN_ALIASES });
      for (const target of Object.values(theme.mars.aliases))
        expect(target in base.colors).toBe(true);
      for (const alias of Object.keys(theme.mars.aliases))
        expect(alias in base.colors).toBe(false);
    });
  }
  test("NO_COLOR emits no escapes; depths differ", () => {
    expect(createPainter("mars-dark", "none").fg("paidTier", "x")).toBe("x");
    expect(createPainter("mars-dark", "truecolor").fg("paidTier", "x")).toMatch(
      /38;2;/,
    );
    expect(createPainter("mars-dark", "256").fg("paidTier", "x")).toMatch(
      /38;5;/,
    );
    expect(createPainter("mars-dark", "16").fg("paidTier", "x")).toMatch(
      /\[(3|9)\dm/,
    );
    expect(detectColourDepth({ NO_COLOR: "1", COLORTERM: "truecolor" })).toBe(
      "none",
    );
    expect(detectColourDepth({ COLORTERM: "truecolor" })).toBe("truecolor");
    expect(detectColourDepth({ TERM: "xterm-256color" })).toBe("256");
  });
});
