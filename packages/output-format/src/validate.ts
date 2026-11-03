import type {
  OutputDocument,
  OutputError,
  OutputValidationContext,
  WritingBlock,
} from "@mars/contracts";
import { canonicalAddress } from "./parse";

export const DEFAULT_MAX_REVIEW_LINES = 40;

export interface ValidationResult {
  ok: boolean;
  errors: OutputError[];
}

function allowedAddresses(context: OutputValidationContext): Set<string> {
  const allowed = new Set<string>();
  for (const value of context.allowed_addresses) {
    const address = canonicalAddress(value);
    if (address) allowed.add(address);
  }
  return allowed;
}

function isAllowed(allowed: Set<string>, value: string): boolean {
  const address = canonicalAddress(value);
  return address !== null && allowed.has(address);
}

/**
 * Context checks on parsed output: invented addresses, unknown connectors and
 * over-wide review ranges. Syntax errors recorded by the parser are included so
 * callers get one typed list. Never executes anything.
 */
export function validateOutput(
  document: OutputDocument,
  context: OutputValidationContext,
): ValidationResult {
  const errors: OutputError[] = [...document.errors];
  const allowed = allowedAddresses(context);
  const connectors = new Set(context.connector_ids);
  const maxLines = context.max_review_lines ?? DEFAULT_MAX_REVIEW_LINES;

  for (const segment of document.segments) {
    if (segment.kind !== "writing" || !segment.email) continue;
    for (const field of ["recipient", "cc", "bcc"] as const)
      for (const address of segment.email[field])
        if (!isAllowed(allowed, address))
          errors.push({
            code: "invented_address",
            message: `Email ${field} "${address}" is not exactly one address supplied by the user.`,
            line: segment.span.start_line,
            block_id: segment.id,
          });
  }
  for (const link of document.links) {
    if (!/^mailto:/i.test(link.target)) continue;
    const address = link.target.slice("mailto:".length).split("?")[0] ?? "";
    if (!isAllowed(allowed, address))
      errors.push({
        code: "invented_address",
        message: `mailto address "${address}" is not exactly one address supplied by the user.`,
        line: link.line,
        block_id: link.block_id,
      });
  }
  for (const trigger of document.app_triggers)
    if (!connectors.has(trigger.connector_id))
      errors.push({
        code: "unknown_connector",
        message: `No registered connector "${trigger.connector_id}".`,
        line: trigger.line,
        block_id: null,
      });
  for (const review of document.review_links)
    if (review.line_end - review.line_start + 1 > maxLines)
      errors.push({
        code: "review_range_too_wide",
        message: `Review link spans ${review.line_end - review.line_start + 1} lines; keep ranges within ${maxLines}.`,
        line: review.line,
        block_id: null,
      });

  errors.sort((a, b) => a.line - b.line);
  return { ok: errors.length === 0, errors };
}

export function writingBlocks(document: OutputDocument): WritingBlock[] {
  return document.segments.filter(
    (segment): segment is WritingBlock => segment.kind === "writing",
  );
}
