import { frozenClone } from "@mars/integration-trust";
import type {
  McpContentItem,
  RawMcpToolCallResult,
  UntrustedToolOutput,
} from "./schemas";

/**
 * Field names commonly used by untrusted MCP servers to inject prompt-steering
 * instructions or forged approval signals into tool results.
 */
const STEERING_FIELD_NAMES = new Set([
  "_instructions",
  "instructions",
  "_system",
  "system_prompt",
  "systemPrompt",
  "developer_instructions",
  "developerInstructions",
  "assistant_instructions",
  "assistantInstructions",
  "_meta_instructions",
  "__instructions",
  "prompt_override",
  "promptOverride",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Recursively removes prompt-steering keys from arbitrary JSON-like data.
 * Collects the dot-paths of stripped keys so callers/auditors can observe
 * that steering fields were neutralized without ever letting them reach
 * instruction channels.
 */
export function stripSteeringFields(
  value: unknown,
  pathPrefix = "",
  stripped: string[] = [],
  depth = 0,
): { value: unknown; stripped: string[] } {
  if (depth > 32 || value === null || typeof value !== "object") {
    return { value, stripped };
  }
  if (Array.isArray(value)) {
    const cleaned = value.map(
      (item, idx) =>
        stripSteeringFields(item, `${pathPrefix}[${idx}]`, stripped, depth + 1)
          .value,
    );
    return { value: cleaned, stripped };
  }
  if (!isPlainRecord(value)) {
    return { value, stripped };
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (STEERING_FIELD_NAMES.has(key)) {
      stripped.push(childPath);
      continue;
    }
    out[key] = stripSteeringFields(child, childPath, stripped, depth + 1).value;
  }
  return { value: out, stripped };
}

const STEERING_TAG_PATTERN =
  /<(system|instructions|system_prompt|system-prompt|developer|developer_instructions|assistant_instructions|prompt_override)\b[^>]*>[\s\S]*?<\/\1>/gi;

function sanitizeTextContent(
  text: string,
  pathPrefix: string,
  stripped: string[],
): string {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const before = stripped.length;
      const cleaned = stripSteeringFields(parsed, pathPrefix, stripped);
      if (stripped.length > before) {
        return JSON.stringify(cleaned.value);
      }
    } catch {
      // Plain text, not JSON — fall through to tag stripping.
    }
  }
  return text.replace(STEERING_TAG_PATTERN, (_match, tag: string) => {
    stripped.push(`${pathPrefix}.<${tag.toLowerCase()}>`);
    return "";
  });
}

function sanitizeContentItem(
  item: McpContentItem,
  index: number,
  stripped: string[],
): McpContentItem {
  const prefix = `content[${index}]`;
  const cleanedObj = stripSteeringFields(item, prefix, stripped).value;
  const record: Record<string, unknown> = isPlainRecord(cleanedObj)
    ? { ...cleanedObj }
    : { type: "text" };
  if (typeof record.text === "string") {
    record.text = sanitizeTextContent(record.text, `${prefix}.text`, stripped);
  }
  if (typeof record.type !== "string") {
    record.type = "unknown";
  }
  return record as McpContentItem;
}

/**
 * Wraps a raw MCP `tools/call` response into a deeply frozen `UntrustedToolOutput`
 * envelope after recursively stripping `_instructions` and related steering fields
 * from top-level fields, `structuredContent`, and JSON-encoded `content[].text`.
 */
export function sanitizeToolOutput(
  raw: RawMcpToolCallResult,
  meta: {
    server_id: string;
    tool: string;
    grant_id: string;
    binding_sha256: string;
  },
): UntrustedToolOutput {
  const stripped: string[] = [];

  // Record any top-level steering fields on the raw result object itself.
  if (isPlainRecord(raw)) {
    for (const key of Object.keys(raw)) {
      if (STEERING_FIELD_NAMES.has(key)) {
        stripped.push(key);
      }
    }
  }

  const rawContent = Array.isArray(raw?.content) ? raw.content : [];
  const content = rawContent.map((item, idx) =>
    sanitizeContentItem(item, idx, stripped),
  );

  const structured =
    raw?.structuredContent !== undefined
      ? stripSteeringFields(
          raw.structuredContent,
          "structuredContent",
          stripped,
        ).value
      : null;

  return frozenClone<UntrustedToolOutput>({
    untrusted: true,
    server_id: meta.server_id,
    tool: meta.tool,
    grant_id: meta.grant_id,
    binding_sha256: meta.binding_sha256,
    is_error: raw?.isError === true,
    content,
    structured_content: structured,
    stripped_steering_fields: [...new Set(stripped)].sort(),
  });
}
