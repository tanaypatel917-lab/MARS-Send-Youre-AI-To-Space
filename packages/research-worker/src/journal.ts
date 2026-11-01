export type JournalKind = "search" | "fetch" | "model";

export interface JournalEntry {
  kind: JournalKind;
  key: string;
  value: unknown;
}

export interface ResearchJournal {
  readonly mode: "record" | "replay";
  lookup(kind: JournalKind, key: string): unknown;
  record(kind: JournalKind, key: string, value: unknown): void;
}

export class ReplayMissError extends Error {
  constructor(kind: JournalKind) {
    super(`Replay journal has no recorded ${kind} entry for this input.`);
    this.name = "ReplayMissError";
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function journalKey(input: unknown): string {
  return new Bun.CryptoHasher("sha256").update(canonical(input)).digest("hex");
}

export function createRecordingJournal(): ResearchJournal & {
  entries(): JournalEntry[];
} {
  const store = new Map<string, JournalEntry>();
  return {
    mode: "record",
    lookup: (kind, key) => store.get(`${kind}:${key}`)?.value,
    record: (kind, key, value) => {
      store.set(`${kind}:${key}`, { kind, key, value });
    },
    entries: () => [...store.values()],
  };
}

export function createReplayJournal(
  entries: readonly JournalEntry[],
): ResearchJournal {
  const store = new Map(
    entries.map((entry) => [`${entry.kind}:${entry.key}`, entry.value]),
  );
  return {
    mode: "replay",
    lookup: (kind, key) => store.get(`${kind}:${key}`),
    record: () => {},
  };
}

export const bytesToBase64 = (data: Uint8Array): string =>
  Buffer.from(data).toString("base64");
export const base64ToBytes = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text, "base64"));
