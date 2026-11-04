/** Hard budgets shared by every MARS client (terminal now, MARS Shell later). */
export const LIMITS = {
  /** Rendered transcript entries kept in memory; older ones collapse into "load earlier". */
  renderedEntries: 2_000,
  /** Collapsed tool-card preview lines. */
  toolPreviewLines: 5,
  /** Collapsed diff lines per file. */
  diffLinesPerFile: 40,
  /** Hook stdout/stderr bytes the host keeps. */
  hookOutputBytes: 4_096,
  /** Event payload artifacts fetched for the live tail; older events project without payloads. */
  payloadTail: 2_000,
  /** Journal entry ids per `tasks.journal` request. */
  journalBatch: 64,
  /** Bytes of a text artifact the client decodes for display. */
  artifactPreviewBytes: 262_144,
  pollRunningMs: 250,
  pollIdleMs: 2_000,
  pollBackoffMaxMs: 30_000,
  spinnerIntervalMs: 80,
  minColumns: 60,
  minRows: 16,
  headerMinRows: 30,
  fullLayoutColumns: 100,
  quitConfirmMs: 2_000,
} as const;
