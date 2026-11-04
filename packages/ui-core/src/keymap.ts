import keymapJson from "../keymap.json" with { type: "json" };

/** One row of `keymap.json` in the pi-tui `KeybindingDefinition` format. */
export interface KeymapEntry {
  defaultKeys: string | string[];
  description: string;
}
export type Keymap = Readonly<Record<string, KeymapEntry>>;
export type KeymapOverrides = Readonly<Record<string, string | string[]>>;

export const KEYMAP: Keymap = keymapJson;

/** `mars.<context>.<action>`; `global` bindings apply in every context. */
export function keymapContext(id: string): string {
  return id.split(".")[1] ?? "global";
}

export function keysFor(
  id: string,
  keymap: Keymap = KEYMAP,
  overrides: KeymapOverrides = {},
): string[] {
  const keys = overrides[id] ?? keymap[id]?.defaultKeys ?? [];
  return Array.isArray(keys) ? [...keys] : [keys];
}

export interface DuplicateBinding {
  context: string;
  key: string;
  ids: string[];
}

/** Keys bound twice within one context, counting `global` bindings in every context. */
export function findDuplicateBindings(
  keymap: Keymap = KEYMAP,
  overrides: KeymapOverrides = {},
): DuplicateBinding[] {
  const ids = Object.keys(keymap);
  const contexts = [...new Set(ids.map(keymapContext))];
  const duplicates: DuplicateBinding[] = [];
  for (const context of contexts) {
    const owners = new Map<string, string[]>();
    for (const id of ids) {
      const own = keymapContext(id);
      if (own !== context && own !== "global") continue;
      for (const key of keysFor(id, keymap, overrides)) {
        const canonical = key.toLowerCase();
        owners.set(canonical, [...(owners.get(canonical) ?? []), id]);
      }
    }
    for (const [key, owned] of owners)
      if (owned.length > 1) duplicates.push({ context, key, ids: owned });
  }
  return duplicates;
}

/** Validates `~/.mars/keybindings.json`: known ids only, string or string[] values (`[]` disables). */
export function parseKeymapOverrides(
  raw: unknown,
  keymap: Keymap = KEYMAP,
): KeymapOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("keybindings.json must be an object of action ids.");
  const result: Record<string, string | string[]> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!(id in keymap)) throw new Error(`Unknown keybinding id ${id}.`);
    if (
      typeof value === "string" ||
      (Array.isArray(value) && value.every((key) => typeof key === "string"))
    )
      result[id] = value;
    else throw new Error(`Keybinding ${id} must be a key or a list of keys.`);
  }
  const duplicates = findDuplicateBindings(keymap, result);
  if (duplicates.length)
    throw new Error(
      `Duplicate keybinding ${duplicates[0]?.key} in ${duplicates[0]?.context}.`,
    );
  return result;
}

/** `ctrl+shift+o` → `Ctrl+Shift+O`, for hints rendered from the live map. */
export function keyLabel(key: string): string {
  return key
    .split("+")
    .map((part) =>
      part.length === 1
        ? part.toUpperCase()
        : part === "pageUp"
          ? "PgUp"
          : part === "pageDown"
            ? "PgDn"
            : part === "escape"
              ? "Esc"
              : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
    )
    .join("+");
}

export function keyHint(
  id: string,
  keymap: Keymap = KEYMAP,
  overrides: KeymapOverrides = {},
): string {
  return keysFor(id, keymap, overrides).map(keyLabel).join("/");
}
