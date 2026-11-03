import type {
  AppTrigger,
  OutputError,
  OutputSegment,
  ReviewLink,
  SourceSpan,
  Task,
  WritingBlock,
} from "@mars/contracts";
import {
  collectAddresses,
  DEFAULT_MAX_REVIEW_LINES,
  parseOutput,
  validateOutput,
} from "@mars/output-format";

const TONE_MARKER = /^::tone\[[^\]]+\]$/;
const CODE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

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
 * controls. Everything is untrusted: malformed review links never reach
 * `review_links`, so the only validator failure a surviving link can have is
 * an over-wide range, which is recomputed per link (errors are keyed by line
 * and could not single out one of several links). App triggers are never
 * actionable (this client has no connector registry); errors are kept for
 * display.
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
  return {
    segments: document.segments,
    errors,
    reviews: document.review_links.map((review) => ({
      line: review.line,
      review,
      blocked: reviewBlocked(review),
    })),
    triggers: document.app_triggers,
  };
}

function reviewBlocked(review: ReviewLink): string | null {
  const lines = review.line_end - review.line_start + 1;
  return lines > DEFAULT_MAX_REVIEW_LINES
    ? `Review link spans ${lines} lines; keep ranges within ${DEFAULT_MAX_REVIEW_LINES}.`
    : null;
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

/**
 * Body lines before the first `::tone` marker (outside code fences). The
 * parser assigns them to no tone, so a tone-aware panel must show them
 * separately or the Copy button would carry text the user never saw.
 */
export function tonePreamble(block: WritingBlock): string | null {
  if (block.tones.length === 0) return null;
  const lines = block.body.split("\n");
  let fence: { char: string; length: number } | null = null;
  for (const [index, text] of lines.entries()) {
    if (fence) {
      const close = new RegExp(`^ {0,3}\\${fence.char}{${fence.length},}\\s*$`);
      if (close.test(text)) fence = null;
      continue;
    }
    if (TONE_MARKER.test(text)) {
      const preamble = lines.slice(0, index).join("\n");
      return preamble.trim() ? preamble : null;
    }
    const open = CODE_FENCE_OPEN.exec(text);
    if (open) {
      const marker = open[1] as string;
      fence = { char: marker[0] as string, length: marker.length };
    }
  }
  return null;
}
