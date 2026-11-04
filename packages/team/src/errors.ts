export const TEAM_ERROR_CODES = [
  "invalid_input",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "too_large",
  "rate_limited",
  "unavailable",
  "unknown_cursor",
  "unsafe_path",
  "corrupt_record",
] as const;
export type TeamErrorCode = (typeof TEAM_ERROR_CODES)[number];

/**
 * Messages are fixed operational strings: never a body, a token, a path or a
 * user-supplied value.
 */
export class TeamError extends Error {
  readonly code: TeamErrorCode;
  /** Whole seconds until a `rate_limited` caller may retry; becomes the HTTP `Retry-After` header. */
  readonly retryAfterSeconds: number | null;
  constructor(
    code: TeamErrorCode,
    message: string,
    options: { retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "TeamError";
    this.code = code;
    this.retryAfterSeconds =
      options.retryAfterSeconds === undefined
        ? null
        : Math.max(1, Math.ceil(options.retryAfterSeconds));
  }
}

export const invalidInput = (message: string) =>
  new TeamError("invalid_input", message);
/** Used for both "does not exist" and "not yours" so existence never leaks. */
export const notFound = () =>
  new TeamError("not_found", "Conversation or member not found");
/** Repos and references share the choice: absent and inaccessible look alike. */
export const referenceNotFound = () =>
  new TeamError("not_found", "Repository or reference not found");
export const conflict = (message: string) => new TeamError("conflict", message);
export const unavailable = (message: string) =>
  new TeamError("unavailable", message);
/** Per-user sliding-window budget exhausted; the message names the window, never the caller. */
export const rateLimited = (message: string, retryAfterSeconds: number) =>
  new TeamError("rate_limited", message, { retryAfterSeconds });
/** The host switched `team.enabled` off: durable data is kept, every operation but `team.describe` is refused. */
export const teamDisabled = () =>
  new TeamError("unavailable", "Team Chat is disabled by the host");
