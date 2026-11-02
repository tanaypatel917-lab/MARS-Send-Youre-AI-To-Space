import type {
  AppTrigger,
  OutputError,
  OutputSegment,
  ReviewLink,
  SourceSpan,
  Task,
} from "@mars/contracts";
import {
  collectAddresses,
  parseOutput,
  validateOutput,
} from "@mars/output-format";

export interface ReviewItem {
  line: number;
  review: ReviewLink;
  /** Validation failed: render as text, never as a button. */
  blocked: string | null;
}

export interface OutputView {
  segments: OutputSegment[];
  errors: OutputError[];
  reviews: ReviewItem[];
  triggers: AppTrigger[];
}

/**
 * Parses the model's final text and decides which proposals may become
 * controls. Everything is untrusted: review links with any error on their
 * line are demoted to text, app triggers are never actionable (this client
 * has no connector registry) and errors are kept for display.
 */
export function buildOutputView(text: string, task: Task): OutputView {
  const document = parseOutput(text);
  const { errors } = validateOutput(document, {
    connector_ids: [],
    allowed_addresses: collectAddresses([
      task.request,
      ...task.acceptance_criteria,
    ]),
  });
  const reviewErrors = new Map<number, string>();
  for (const error of errors)
    if (
      error.code === "review_range_too_wide" ||
      error.code === "malformed_review_link"
    )
      reviewErrors.set(error.line, error.message);
  return {
    segments: document.segments,
    errors,
    reviews: document.review_links.map((review) => ({
      line: review.line,
      review,
      blocked: reviewErrors.get(review.line) ?? null,
    })),
    triggers: document.app_triggers,
  };
}

export function withinSpan<T extends { line: number }>(
  items: readonly T[],
  span: SourceSpan,
): T[] {
  return items.filter(
    (item) => item.line >= span.start_line && item.line <= span.end_line,
  );
}

export function blockErrors(
  errors: readonly OutputError[],
  blockId: string,
): OutputError[] {
  return errors.filter((error) => error.block_id === blockId);
}
