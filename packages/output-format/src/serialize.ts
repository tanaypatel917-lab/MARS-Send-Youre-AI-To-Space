import type {
  FollowUp,
  OutputDocument,
  OutputSegment,
  WritingBlock,
} from "@mars/contracts";
import { parseOutput } from "./parse";

function escapeAttribute(value: string): string {
  return value.replace(/[\\"]/g, (char) => `\\${char}`);
}

export function serializeAttributes(
  attributes: Record<string, string>,
): string {
  return Object.entries(attributes)
    .map(([key, value]) => `${key}="${escapeAttribute(value)}"`)
    .join(" ");
}

const EMAIL_LIST_KEYS = ["recipient", "cc", "bcc"] as const;

/**
 * Opening-fence attributes with `id`, `variant` and the email header as the
 * source of truth, so a host replacement that edits those parsed fields wins
 * over the stale `attributes` copy. Attribute order is preserved.
 */
export function headerAttributes(block: WritingBlock): Record<string, string> {
  const header: Record<string, string> = {
    id: block.id,
    variant: block.variant,
  };
  const email = block.email;
  const valueFor = (key: string): string | null => {
    if (key === "id") return block.id;
    if (key === "variant") return block.variant;
    if (!email) return block.attributes[key] ?? null;
    if (key === "subject") return email.subject;
    if ((EMAIL_LIST_KEYS as readonly string[]).includes(key))
      return email[key as (typeof EMAIL_LIST_KEYS)[number]].join(", ");
    return block.attributes[key] ?? null;
  };
  for (const key of Object.keys(block.attributes)) {
    const value = valueFor(key);
    if (value !== null) header[key] = value;
    else delete header[key];
  }
  if (email) {
    if (email.subject !== null && !("subject" in header))
      header.subject = email.subject;
    for (const key of EMAIL_LIST_KEYS)
      if (email[key].length > 0 && !(key in header))
        header[key] = email[key].join(", ");
  }
  return header;
}

export function serializeWritingBlock(block: WritingBlock): string {
  const attributes = headerAttributes(block);
  const open = `:::writing{${serializeAttributes(attributes)}}`;
  return block.body.length === 0
    ? `${open}\n:::`
    : `${open}\n${block.body}\n:::`;
}

export function serializeFollowUp(followUp: FollowUp): string {
  return `- :${followUp.tag}[${followUp.label}]{prompt="${escapeAttribute(followUp.prompt)}"}`;
}

export function serializeSegment(segment: OutputSegment): string {
  switch (segment.kind) {
    case "markdown":
      return segment.text;
    case "writing":
      return serializeWritingBlock(segment);
    case "follow_up":
      return serializeFollowUp(segment);
  }
}

/** Canonical text for a parsed document; parse(serialize(doc)) equals doc. */
export function serializeOutput(document: OutputDocument): string {
  return document.segments.map(serializeSegment).join("\n");
}

export type WritingBlockRewrite =
  | { kind: "keep" }
  | { kind: "replace"; block: WritingBlock }
  | { kind: "redact"; notice?: string };

/**
 * Host-side rewrite of writing blocks (for example redacting an email whose
 * addresses failed validation). Returns a freshly parsed document so links,
 * triggers and line numbers stay consistent with the new text.
 */
export function rewriteWritingBlocks(
  document: OutputDocument,
  rewrite: (block: WritingBlock) => WritingBlockRewrite,
): OutputDocument {
  const segments: OutputSegment[] = document.segments.map((segment) => {
    if (segment.kind !== "writing") return segment;
    const decision = rewrite(segment);
    if (decision.kind === "keep") return segment;
    if (decision.kind === "replace") return decision.block;
    return {
      kind: "markdown",
      text:
        decision.notice ??
        `> Writing block ${segment.id} (${segment.variant}) was withheld by the host.`,
      span: segment.span,
    };
  });
  return parseOutput(serializeOutput({ ...document, segments }));
}
