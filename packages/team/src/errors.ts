export const TEAM_ERROR_CODES = [
  "invalid_input",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "too_large",
  "rate_limited",
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
  constructor(code: TeamErrorCode, message: string) {
    super(message);
    this.name = "TeamError";
    this.code = code;
  }
}

export const invalidInput = (message: string) =>
  new TeamError("invalid_input", message);
/** Used for both "does not exist" and "not yours" so existence never leaks. */
export const notFound = () =>
  new TeamError("not_found", "Conversation or member not found");
export const conflict = (message: string) => new TeamError("conflict", message);
