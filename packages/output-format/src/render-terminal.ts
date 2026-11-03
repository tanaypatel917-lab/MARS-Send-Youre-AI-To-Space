import type {
  AppTrigger,
  FollowUp,
  OutputDocument,
  OutputError,
  ReviewLink,
  WritingBlock,
} from "@mars/contracts";

export interface RenderTerminalOptions {
  /** Total column budget for frames and wrapping. Default 80, minimum 20. */
  width?: number;
  /** Errors to list; defaults to the parse errors on the document. */
  errors?: OutputError[];
  /** Emit ANSI colour codes. Default false. */
  color?: boolean;
}

const DEFAULT_WIDTH = 80;
const MIN_WIDTH = 20;
const INDENT = "  ";
const TONE_MARKER = /^::tone\[[^\]]+\]$/;
const CODE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

interface Style {
  frame(text: string): string;
  heading(text: string): string;
  label(text: string): string;
}

const PLAIN: Style = {
  frame: (text) => text,
  heading: (text) => text,
  label: (text) => text,
};

const ANSI: Style = {
  frame: (text) => `\u001b[36m${text}\u001b[0m`,
  heading: (text) => `\u001b[1m${text}\u001b[0m`,
  label: (text) => `\u001b[2m${text}\u001b[0m`,
};

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length <= width) {
      lines.push(raw);
      continue;
    }
    let rest = raw;
    while (rest.length > width) {
      const cut = rest.lastIndexOf(" ", width);
      if (cut > 0) {
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut + 1);
      } else {
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
    }
    lines.push(rest);
  }
  return lines;
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function preamble(block: WritingBlock): string | null {
  if (block.tones.length === 0) return null;
  const lines: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const text of block.body.split("\n")) {
    if (fence) {
      const close = new RegExp(`^ {0,3}\\${fence.char}{${fence.length},}\\s*$`);
      if (close.test(text)) fence = null;
    } else if (TONE_MARKER.test(text)) break;
    else {
      const open = CODE_FENCE_OPEN.exec(text);
      if (open) {
        const marker = open[1] as string;
        fence = { char: marker[0] as string, length: marker.length };
      }
    }
    lines.push(text);
  }
  const text = lines.join("\n");
  return text.trim().length > 0 ? text : null;
}

function headerLines(block: WritingBlock): string[] {
  const lines = [`${block.variant} #${block.id}`];
  if (!block.email) return lines;
  lines.push(`Subject: ${block.email.subject ?? "(none)"}`);
  lines.push(`To: ${block.email.recipient.join(", ") || "(none)"}`);
  if (block.email.cc.length > 0) lines.push(`Cc: ${block.email.cc.join(", ")}`);
  if (block.email.bcc.length > 0)
    lines.push(`Bcc: ${block.email.bcc.join(", ")}`);
  return lines;
}

function renderWritingBlock(
  block: WritingBlock,
  width: number,
  style: Style,
): string {
  const inner = width - 4;
  const bar = "─".repeat(width - 2);
  const row = (text: string, paint = (value: string) => value) =>
    `${style.frame("│")} ${paint(text)}${" ".repeat(inner - text.length)} ${style.frame("│")}`;
  const out = [style.frame(`┌${bar}┐`)];
  for (const line of headerLines(block))
    out.push(row(truncate(line, inner), style.label));
  out.push(style.frame(`├${bar}┤`));
  const intro = preamble(block);
  const sections: Array<{ tone: string | null; body: string }> =
    block.tones.length > 0
      ? [
          ...(intro === null ? [] : [{ tone: null, body: intro }]),
          ...block.tones,
        ]
      : [{ tone: null, body: block.body }];
  sections.forEach((section, index) => {
    if (index > 0) out.push(style.frame(`├${bar}┤`));
    if (section.tone !== null)
      out.push(row(truncate(`── ${section.tone} ──`, inner), style.label));
    for (const line of wrap(section.body, inner)) out.push(row(line));
  });
  out.push(style.frame(`└${bar}┘`));
  return out.join("\n");
}

function renderFollowUps(followUps: FollowUp[], style: Style): string {
  const out = [style.heading("Follow-ups")];
  followUps.forEach((followUp, index) => {
    const number = `${index + 1}.`;
    out.push(`${INDENT}${number} ${followUp.label}`);
    const pad = " ".repeat(INDENT.length + number.length + 1);
    out.push(indent(`${style.label("prompt:")} ${followUp.prompt}`, pad));
  });
  return out.join("\n");
}

function rejected(
  errors: readonly OutputError[],
  matches: (error: OutputError) => boolean,
): string {
  const codes = errors.filter(matches).map((error) => error.code);
  return codes.length > 0 ? ` — rejected (${codes.join(", ")})` : "";
}

function renderActions(
  triggers: readonly AppTrigger[],
  reviews: readonly ReviewLink[],
  errors: readonly OutputError[],
  style: Style,
): string {
  const out = [style.heading("Proposed actions (not executed)")];
  for (const trigger of triggers)
    out.push(
      `${INDENT}- App trigger "${trigger.label}": connector ${trigger.connector_id} (line ${trigger.line})${rejected(
        errors,
        (error) =>
          error.code === "unknown_connector" &&
          error.line === trigger.line &&
          error.message.includes(`"${trigger.connector_id}"`),
      )}`,
    );
  for (const review of reviews) {
    const span = review.line_end - review.line_start + 1;
    const range =
      span === 1
        ? `${review.line_start}`
        : `${review.line_start}-${review.line_end}`;
    out.push(
      `${INDENT}- Review "${review.label}": ${review.pr} ${review.path}:${range} (${review.side}, line ${review.line})${rejected(
        errors,
        (error) =>
          error.code === "review_range_too_wide" &&
          error.line === review.line &&
          /spans (\d+) lines/.exec(error.message)?.[1] === `${span}`,
      )}`,
    );
  }
  return out.join("\n");
}

function renderErrors(errors: readonly OutputError[], style: Style): string {
  const out = [style.heading("Format errors")];
  for (const error of errors) {
    const block = error.block_id ? ` block ${error.block_id}` : "";
    out.push(
      `${INDENT}- line ${error.line} [${error.code}]${block}: ${error.message}`,
    );
  }
  return out.join("\n");
}

/**
 * Pure text rendering of a parsed document for terminals. Follow-ups,
 * app triggers and review links are shown with their hidden prompt or target
 * and never executed; the caller decides what to do after an explicit choice.
 */
export function renderTerminal(
  document: OutputDocument,
  options: RenderTerminalOptions = {},
): string {
  const width = Math.max(options.width ?? DEFAULT_WIDTH, MIN_WIDTH);
  const style = options.color ? ANSI : PLAIN;
  const errors = options.errors ?? document.errors;
  const parts: string[] = [];
  const followUps: FollowUp[] = [];
  const body: string[] = [];
  for (const segment of document.segments) {
    if (segment.kind === "markdown") body.push(segment.text);
    else if (segment.kind === "writing")
      body.push(renderWritingBlock(segment, width, style));
    else followUps.push(segment);
  }
  const text = body.join("\n").replace(/\n+$/, "");
  if (text.trim().length > 0) parts.push(text);
  if (followUps.length > 0) parts.push(renderFollowUps(followUps, style));
  if (document.app_triggers.length > 0 || document.review_links.length > 0)
    parts.push(
      renderActions(
        document.app_triggers,
        document.review_links,
        errors,
        style,
      ),
    );
  if (errors.length > 0) parts.push(renderErrors(errors, style));
  return `${parts.join("\n\n")}\n`;
}
