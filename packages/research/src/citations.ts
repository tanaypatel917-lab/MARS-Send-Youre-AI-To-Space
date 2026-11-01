import { ResearchError } from "./errors";

const INVALID_URL_MESSAGE = "Citation URL is not allowed";

export function validateCitationUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    value !== value.trim() ||
    hasWhitespaceOrControl(value)
  ) {
    throw new ResearchError("citation_rejected", INVALID_URL_MESSAGE);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ResearchError("citation_rejected", INVALID_URL_MESSAGE);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hostname.length === 0
  ) {
    throw new ResearchError("citation_rejected", INVALID_URL_MESSAGE);
  }
  return value;
}

function hasWhitespaceOrControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x00a0 ||
      code === 0x1680 ||
      (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x202f ||
      code === 0x205f ||
      code === 0x3000 ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}
