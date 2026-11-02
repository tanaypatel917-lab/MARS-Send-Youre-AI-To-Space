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

export function serializeWritingBlock(block: WritingBlock): string {
  const attributes = {
    id: block.id,
    variant: block.variant,
    ...block.attributes,
  };
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
