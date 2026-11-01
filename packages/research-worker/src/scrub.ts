const SECRET_PATTERNS = [
  /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"']{6,}/gi,
  /\b(?:sk|pk|rk)-[a-z0-9_-]{16,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
];

export function redact(text: string, needles: readonly string[]): string {
  let output = text;
  for (const needle of [...new Set(needles)]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length)) {
    output = output.split(needle).join("[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, "[redacted]");
  }
  return output;
}
