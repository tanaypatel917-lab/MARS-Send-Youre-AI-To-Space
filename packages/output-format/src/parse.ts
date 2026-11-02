import {
  type AppTrigger,
  type EmailHeader,
  type FollowUp,
  type LinkKind,
  type MarkdownSegment,
  OUTPUT_FORMAT_VERSION,
  type OutputDocument,
  type OutputError,
  type OutputErrorCode,
  type OutputLink,
  type OutputSegment,
  type ReviewLink,
  type ToneSection,
  WRITING_BLOCK_ID_PATTERN,
  type WritingBlock,
  type WritingVariant,
  WritingVariantSchema,
} from "@mars/contracts";

const OPEN_FENCE = /^:::writing\{(.*)\}$/;
const LOOSE_OPEN_FENCE = /^\s*:::\s*writing\b/;
const CLOSE_FENCE = /^:::$/;
const LOOSE_CLOSE_FENCE = /^\s*:::\s*$/;
const CODE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const TONE_MARKER = /^::tone\[([^\]]+)\]$/;
const FOLLOW_UP =
  /^[-*] :(mars-followup|codex-followup)\[([^\]]*)\]\{(.*)\}\s*$/;
const LOOSE_FOLLOW_UP = /^\s*[-*]?\s*:(mars|codex)-followup\b/;
const ATTRIBUTE =
  /^([A-Za-z_][A-Za-z0-9_-]*)=(?:"((?:[^"\\]|\\.)*)"|([^\s"{}]+))/;
const RESERVED_ATTRIBUTE_KEYS = ["__proto__", "constructor", "prototype"];
const CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;
const EMAIL_ADDRESS =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;

/** Schemes that never become links: local-file/editor schemes and script-capable URIs. */
export const FORBIDDEN_LINK_SCHEMES = [
  "file",
  "vscode",
  "vscode-insiders",
  "javascript",
  "vbscript",
  "data",
  "blob",
];

/** Parse `key="value" key=bare` attribute lists. Returns null when malformed. */
export function parseAttributes(source: string): Record<string, string> | null {
  const attributes: Record<string, string> = {};
  let rest = source.trim();
  while (rest.length > 0) {
    const match = ATTRIBUTE.exec(rest);
    if (!match) return null;
    const key = match[1] as string;
    if (RESERVED_ATTRIBUTE_KEYS.includes(key) || Object.hasOwn(attributes, key))
      return null;
    attributes[key] =
      match[2] !== undefined ? unescapeAttribute(match[2]) : (match[3] ?? "");
    rest = rest.slice(match[0].length);
    if (rest.length > 0 && !/^\s/.test(rest)) return null;
    rest = rest.trimStart();
  }
  return attributes;
}

function unescapeAttribute(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

export function splitAddresses(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const SINGLE_ADDRESS = new RegExp(
  `^(?:[^<>]*<\\s*(${EMAIL_ADDRESS.source})\\s*>|(${EMAIL_ADDRESS.source}))$`,
);

/**
 * Canonical lower-cased address for `addr` or `Name <addr>`; null when the
 * value is not exactly one address (extra text, several addresses, brackets).
 */
export function canonicalAddress(value: string): string | null {
  const match = SINGLE_ADDRESS.exec(value.trim());
  const address = match?.[1] ?? match?.[2];
  return address ? address.toLowerCase() : null;
}

/** Email addresses mentioned in user-supplied text, deduplicated. */
export function collectAddresses(texts: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of texts)
    for (const match of text.matchAll(EMAIL_ADDRESS)) found.add(match[0]);
  return [...found];
}

interface CodeSpanScan {
  ranges: Array<[number, number]>;
  /** Length of a backtick run still open at the end of the line, if any. */
  open: number | null;
}

/**
 * Inline code spans on one line. A span may continue from the previous line
 * (`open`), because CommonMark code spans can contain line breaks.
 */
function codeSpanRanges(
  text: string,
  openSpan: number | null,
  closesLater: (length: number) => boolean,
): CodeSpanScan {
  const ranges: Array<[number, number]> = [];
  let index = 0;
  const findClose = (length: number, from: number): number => {
    const fence = "`".repeat(length);
    let close = text.indexOf(fence, from);
    while (close !== -1 && text[close + length] === "`") {
      let run = close;
      while (text[run] === "`") run += 1;
      close = text.indexOf(fence, run);
    }
    return close;
  };
  if (openSpan !== null) {
    const close = findClose(openSpan, 0);
    if (close === -1) return { ranges: [[0, text.length]], open: openSpan };
    ranges.push([0, close + openSpan]);
    index = close + openSpan;
  }
  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    let length = 0;
    while (text[index + length] === "`") length += 1;
    const close = findClose(length, index + length);
    if (close === -1) {
      if (!closesLater(length)) {
        index += length;
        continue;
      }
      ranges.push([index, text.length]);
      return { ranges, open: length };
    }
    ranges.push([index, close + length]);
    index = close + length;
  }
  return { ranges, open: null };
}

/** A backtick run of exactly `length` that is not part of a longer run. */
function hasBacktickRun(text: string, length: number): boolean {
  return new RegExp(`(^|[^\`])\`{${length}}(?!\`)`).test(text);
}

function insideRanges(
  ranges: Array<[number, number]>,
  ...positions: number[]
): boolean {
  return positions.some((position) =>
    ranges.some(([from, to]) => position >= from && position < to),
  );
}

interface LinkTargets {
  links: OutputLink[];
  appTriggers: AppTrigger[];
  reviewLinks: ReviewLink[];
  errors: OutputError[];
}

function classifyTarget(target: string): LinkKind {
  if (target.startsWith("#")) return "anchor";
  if (/^(https?:\/\/|mailto:)/i.test(target)) return "external";
  if (target.startsWith("app://")) return "app";
  if (/^(mars|codex):\/\/review\?/.test(target)) return "review";
  if (WINDOWS_PATH.test(target)) return "local";
  if (SCHEME.test(target)) return "other";
  return "local";
}

function parseReviewLink(
  label: string,
  target: string,
  line: number,
): { link?: ReviewLink; error?: string } {
  const scheme = target.startsWith("mars://") ? "mars" : "codex";
  const query = new URLSearchParams(target.slice(target.indexOf("?") + 1));
  const pr = query.get("pr");
  const path = query.get("path");
  const lineValue = query.get("line");
  const endValue = query.get("end");
  const side = query.get("side") ?? "right";
  if (!pr || !/^https?:\/\//i.test(pr))
    return { error: "pr must be an http(s) URL" };
  if (!path || path.includes("\0") || path.split(/[\\/]/).includes(".."))
    return { error: "path must be a workspace-relative file path" };
  if (!lineValue || !/^\d+$/.test(lineValue) || Number(lineValue) < 1)
    return { error: "line must be a positive integer" };
  const lineStart = Number(lineValue);
  let lineEnd = lineStart;
  if (endValue !== null) {
    if (!/^\d+$/.test(endValue) || Number(endValue) < lineStart)
      return { error: "end must be an integer at or after line" };
    lineEnd = Number(endValue);
  }
  if (side !== "left" && side !== "right")
    return { error: "side must be left or right" };
  for (const key of query.keys())
    if (!["pr", "path", "line", "end", "side"].includes(key))
      return { error: `unknown query key ${key}` };
  return {
    link: {
      label,
      scheme,
      pr,
      path,
      line_start: lineStart,
      line_end: lineEnd,
      side,
      line,
    },
  };
}

interface LinkMatch {
  index: number;
  /** Index of the `]` that ends the label. */
  labelEnd: number;
  end: number;
  image: boolean;
  label: string;
  /** Destination as written, including angle brackets when used. */
  rawTarget: string;
  /** Bare destination contained whitespace (must use angle brackets). */
  spaced: boolean;
}

/**
 * Markdown inline links on one line. Bare destinations may contain balanced
 * parentheses and backslash escapes (CommonMark); whitespace ends them.
 */
function findLinks(text: string): LinkMatch[] {
  const links: LinkMatch[] = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("[", index);
    if (open === -1) break;
    const image = open > 0 && text[open - 1] === "!";
    const labelEnd = text.indexOf("]", open + 1);
    if (labelEnd === -1 || text[labelEnd + 1] !== "(") {
      index = open + 1;
      continue;
    }
    const label = text.slice(open + 1, labelEnd);
    let cursor = labelEnd + 2;
    let rawTarget: string | null = null;
    let spaced = false;
    if (text[cursor] === "<") {
      const close = text.indexOf(">", cursor + 1);
      if (close !== -1 && text[close + 1] === ")") {
        rawTarget = text.slice(cursor, close + 1);
        cursor = close + 2;
      }
    } else {
      let depth = 0;
      let position = cursor;
      while (position < text.length) {
        const char = text[position] as string;
        if (char === "\\" && position + 1 < text.length) {
          position += 2;
          continue;
        }
        if (char === "(") depth += 1;
        else if (char === ")") {
          if (depth === 0) break;
          depth -= 1;
        } else if (/\s/.test(char)) spaced = true;
        position += 1;
      }
      if (position < text.length) {
        rawTarget = text.slice(cursor, position);
        cursor = position + 1;
      }
    }
    if (rawTarget === null) {
      index = open + 1;
      continue;
    }
    links.push({
      index: image ? open - 1 : open,
      labelEnd,
      end: cursor,
      image,
      label,
      rawTarget,
      spaced,
    });
    index = cursor;
  }
  return links;
}

function scanLinks(
  text: string,
  line: number,
  blockId: string | null,
  out: LinkTargets,
  openSpan: number | null,
  closesLater: (length: number) => boolean,
): number | null {
  const { ranges: spans, open } = codeSpanRanges(text, openSpan, closesLater);
  const error = (code: OutputErrorCode, message: string) =>
    out.errors.push({ code, message, line, block_id: blockId });
  for (const match of findLinks(text)) {
    // A link whose brackets or parentheses sit inside a code span is literal
    // text; backticks inside the label or target are still a format error.
    if (
      match.image ||
      insideRanges(spans, match.index, match.labelEnd, match.end - 1)
    )
      continue;
    const { label, rawTarget } = match;
    if (match.spaced) {
      error(
        "malformed_link",
        "Link targets with spaces must be wrapped in angle brackets: [Label](<target with spaces>).",
      );
      continue;
    }
    if (label.includes("`") || rawTarget.includes("`")) {
      error(
        "backtick_in_link",
        "Backticks are not allowed in link labels or targets.",
      );
      continue;
    }
    const target = rawTarget.startsWith("<")
      ? rawTarget.slice(1, -1)
      : rawTarget.replace(/\\([()])/g, "$1");
    if (target.trim().length === 0) {
      error("malformed_link", "Link target is empty.");
      continue;
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    if (/[\u0000-\u001f\u007f]/.test(target)) {
      error("malformed_link", "Link target contains control characters.");
      continue;
    }
    const kind = classifyTarget(target);
    if (kind === "other") {
      const scheme = (SCHEME.exec(target)?.[0] ?? "")
        .slice(0, -1)
        .toLowerCase();
      if (FORBIDDEN_LINK_SCHEMES.includes(scheme)) {
        error(
          "forbidden_link_scheme",
          `${scheme}: links are not allowed; use https, a workspace path, app:// or mars://review.`,
        );
        continue;
      }
    }
    out.links.push({ kind, label, target, line, block_id: blockId });
    if (kind === "app") {
      const connectorId = target.slice("app://".length);
      if (/\{\{|\}\}/.test(connectorId))
        error(
          "malformed_link",
          "app:// trigger still contains a template placeholder.",
        );
      else if (!CONNECTOR_ID.test(connectorId))
        error(
          "malformed_link",
          `app:// connector id "${connectorId}" is not a valid identifier.`,
        );
      else out.appTriggers.push({ label, connector_id: connectorId, line });
    } else if (kind === "review") {
      const parsed = parseReviewLink(label, target, line);
      if (parsed.link) out.reviewLinks.push(parsed.link);
      else
        error(
          "malformed_review_link",
          `Review link rejected: ${parsed.error}.`,
        );
    }
  }
  return open;
}

function toneSections(lines: readonly string[]): ToneSection[] {
  const tones: ToneSection[] = [];
  let current: { tone: string; lines: string[] } | null = null;
  let inCode: { char: string; length: number } | null = null;
  for (const text of lines) {
    const fence = codeFenceState(text, inCode);
    inCode = fence;
    const marker = inCode ? null : TONE_MARKER.exec(text);
    if (marker) {
      if (current)
        tones.push({ tone: current.tone, body: current.lines.join("\n") });
      current = { tone: (marker[1] as string).trim(), lines: [] };
      continue;
    }
    current?.lines.push(text);
  }
  if (current)
    tones.push({ tone: current.tone, body: current.lines.join("\n") });
  return tones;
}

function codeFenceState(
  text: string,
  inCode: { char: string; length: number } | null,
): { char: string; length: number } | null {
  if (inCode) {
    const close = new RegExp(`^ {0,3}\\${inCode.char}{${inCode.length},}\\s*$`);
    return close.test(text) ? null : inCode;
  }
  const open = CODE_FENCE_OPEN.exec(text);
  if (!open) return null;
  const marker = open[1] as string;
  return { char: marker[0] as string, length: marker.length };
}

function emailHeader(
  variant: WritingVariant,
  attributes: Record<string, string>,
): EmailHeader | null {
  if (variant !== "email") return null;
  return {
    subject: attributes.subject ?? null,
    recipient: splitAddresses(attributes.recipient),
    cc: splitAddresses(attributes.cc),
    bcc: splitAddresses(attributes.bcc),
  };
}

interface OpenBlock {
  startLine: number;
  id: string;
  variant: WritingVariant;
  attributes: Record<string, string>;
  lines: string[];
}

/**
 * Deterministic, model-free parser. Never throws on model text: every
 * problem becomes a typed error and the offending lines stay as Markdown.
 */
export function parseOutput(text: string): OutputDocument {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const segments: OutputSegment[] = [];
  const targets: LinkTargets = {
    links: [],
    appTriggers: [],
    reviewLinks: [],
    errors: [],
  };
  const seenIds = new Set<string>();
  let markdown: { start: number; lines: string[] } | null = null;
  let block: OpenBlock | null = null;
  let skipping: number | null = null;
  let inCode: { char: string; length: number } | null = null;
  let openSpan: number | null = null;

  const error = (
    code: OutputErrorCode,
    message: string,
    line: number,
    blockId: string | null = block?.id ?? null,
  ) => targets.errors.push({ code, message, line, block_id: blockId });
  const flushMarkdown = (endLine: number) => {
    if (!markdown) return;
    const segment: MarkdownSegment = {
      kind: "markdown",
      text: markdown.lines.join("\n"),
      span: { start_line: markdown.start, end_line: endLine },
    };
    segments.push(segment);
    markdown = null;
  };
  const pushMarkdown = (line: number, content: string) => {
    if (!markdown) markdown = { start: line, lines: [] };
    markdown.lines.push(content);
  };
  const closeBlock = (open: OpenBlock, endLine: number) => {
    const writing: WritingBlock = {
      kind: "writing",
      id: open.id,
      variant: open.variant,
      attributes: open.attributes,
      email: emailHeader(open.variant, open.attributes),
      tones: toneSections(open.lines),
      body: open.lines.join("\n"),
      span: { start_line: open.startLine, end_line: endLine },
    };
    segments.push(writing);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const content = lines[index] as string;
    const codeBefore = inCode;
    inCode = codeFenceState(content, inCode);
    const inCodeNow = codeBefore !== null || inCode !== null;
    if (inCodeNow || content.trim().length === 0) openSpan = null;
    const closesLater = (length: number): boolean => {
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next] as string;
        if (
          candidate.trim().length === 0 ||
          CODE_FENCE_OPEN.test(candidate) ||
          LOOSE_OPEN_FENCE.test(candidate) ||
          LOOSE_CLOSE_FENCE.test(candidate)
        )
          return false;
        if (hasBacktickRun(candidate, length)) return true;
      }
      return false;
    };
    const scan = (blockId: string | null) => {
      if (!inCodeNow)
        openSpan = scanLinks(
          content,
          line,
          blockId,
          targets,
          openSpan,
          closesLater,
        );
    };

    if (skipping !== null) {
      if (!inCodeNow && LOOSE_CLOSE_FENCE.test(content)) {
        if (!CLOSE_FENCE.test(content))
          error(
            "malformed_fence",
            "Closing fence must be exactly ':::' on its own line.",
            line,
            null,
          );
        skipping = null;
      }
      pushMarkdown(line, content);
      scan(null);
      continue;
    }

    if (block) {
      if (!inCodeNow && LOOSE_CLOSE_FENCE.test(content)) {
        if (!CLOSE_FENCE.test(content))
          error(
            "malformed_fence",
            "Closing fence must be exactly ':::' on its own line.",
            line,
          );
        closeBlock(block, line);
        block = null;
        continue;
      }
      if (!inCodeNow && LOOSE_OPEN_FENCE.test(content))
        error(
          "nested_fence",
          "Writing blocks cannot be nested; close the open block first.",
          line,
        );
      scan(block.id);
      block.lines.push(content);
      continue;
    }

    if (!inCodeNow && LOOSE_OPEN_FENCE.test(content)) {
      const open = OPEN_FENCE.exec(content);
      const attributes = open ? parseAttributes(open[1] as string) : null;
      if (!open || !attributes) {
        error(
          "malformed_fence",
          open
            ? 'Writing block attributes must be key="value" pairs with unique keys.'
            : "Opening fence must be exactly ':::writing{...}' on its own line.",
          line,
          null,
        );
        skipping = line;
        pushMarkdown(line, content);
        continue;
      }
      const id = attributes.id;
      const variant = WritingVariantSchema.safeParse(attributes.variant);
      let valid = true;
      if (id === undefined || !WRITING_BLOCK_ID_PATTERN.test(id)) {
        error(
          "invalid_block_id",
          "Writing block id must be a unique 5-digit number.",
          line,
          id ?? null,
        );
        valid = false;
      } else if (seenIds.has(id)) {
        error(
          "duplicate_id",
          `Writing block id ${id} was already used.`,
          line,
          id,
        );
        valid = false;
      }
      if (!variant.success) {
        error(
          "unknown_variant",
          `Writing block variant must be one of ${WritingVariantSchema.options.join(", ")}.`,
          line,
          id ?? null,
        );
        valid = false;
      }
      if (!valid || id === undefined || !variant.success) {
        skipping = line;
        pushMarkdown(line, content);
        continue;
      }
      seenIds.add(id);
      flushMarkdown(line - 1);
      block = {
        startLine: line,
        id,
        variant: variant.data,
        attributes,
        lines: [],
      };
      continue;
    }

    if (!inCodeNow && LOOSE_FOLLOW_UP.test(content)) {
      const match = FOLLOW_UP.exec(content);
      const attributes = match ? parseAttributes(match[3] as string) : null;
      const label = match ? (match[2] as string).trim() : "";
      const prompt = attributes?.prompt?.trim() ?? "";
      if (!match || !attributes || label.length === 0 || prompt.length === 0) {
        error(
          "malformed_followup",
          'Follow-ups must be list items of the form - :mars-followup[visible phrase]{prompt="..."}.',
          line,
          null,
        );
        pushMarkdown(line, content);
        scan(null);
        continue;
      }
      flushMarkdown(line - 1);
      const followUp: FollowUp = {
        kind: "follow_up",
        label,
        prompt,
        tag: match[1] as FollowUp["tag"],
        span: { start_line: line, end_line: line },
      };
      segments.push(followUp);
      continue;
    }

    if (!inCodeNow && CLOSE_FENCE.test(content))
      error(
        "malformed_fence",
        "Closing fence ':::' without an open writing block.",
        line,
        null,
      );
    pushMarkdown(line, content);
    scan(null);
  }

  if (block) {
    error(
      "unclosed_fence",
      `Writing block ${block.id} was never closed with ':::'.`,
      lines.length,
    );
    const open: OpenBlock = block;
    block = null;
    for (let offset = 0; offset < open.lines.length + 1; offset += 1) {
      const line = open.startLine + offset;
      pushMarkdown(line, lines[line - 1] as string);
    }
  }
  if (skipping !== null)
    error(
      "unclosed_fence",
      "Writing block fence was never closed with ':::'.",
      lines.length,
      null,
    );
  flushMarkdown(lines.length);

  return {
    format_version: OUTPUT_FORMAT_VERSION,
    segments,
    links: targets.links,
    app_triggers: targets.appTriggers,
    review_links: targets.reviewLinks,
    errors: targets.errors.sort((a, b) => a.line - b.line),
  };
}
