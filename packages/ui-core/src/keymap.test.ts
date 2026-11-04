import { describe, expect, test } from "bun:test";
import {
  findDuplicateBindings,
  KEYMAP,
  keyHint,
  parseKeymapOverrides,
} from "./keymap";
import { SLASH_COMMANDS } from "./strings";

/** Every command named in UI_PROMPT.md §5.2. */
const SECTION_5_2 =
  "help permissions context tasks new resume cancel model approve diff review children research evidence proposals graph queue drop undo cost status theme symbols settings commands export compact quit".split(
    " ",
  );

describe("keymap (criterion 4)", () => {
  test("no duplicate bindings per context", () => {
    expect(findDuplicateBindings()).toEqual([]);
  });
  test("every binding has a description and pi-tui keybinding shape", () => {
    for (const [id, entry] of Object.entries(KEYMAP)) {
      expect(id).toMatch(/^mars\.[a-z]+\.[A-Za-z]+$/);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(
        typeof entry.defaultKeys === "string" ||
          Array.isArray(entry.defaultKeys),
      ).toBe(true);
    }
  });
  test("every §5.2 slash command has help text", () => {
    for (const name of SECTION_5_2) {
      const command = SLASH_COMMANDS.find((c) => c.name === name);
      expect(command?.help.length ?? 0).toBeGreaterThan(0);
    }
    expect(SLASH_COMMANDS.map((c) => c.name).sort()).toEqual(
      [...SECTION_5_2].sort(),
    );
  });
  test("overrides are validated and rejected on conflict", () => {
    expect(parseKeymapOverrides({ "mars.global.redraw": "ctrl+r" })).toEqual({
      "mars.global.redraw": "ctrl+r",
    });
    expect(() => parseKeymapOverrides({ "mars.nope": "x" })).toThrow();
    expect(() =>
      parseKeymapOverrides({ "mars.global.redraw": "ctrl+o" }),
    ).toThrow(/Duplicate/);
    expect(keyHint("mars.transcript.expand")).toBe("Ctrl+O");
  });
});
