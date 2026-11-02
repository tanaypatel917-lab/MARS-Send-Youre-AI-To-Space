const TEXT_MEDIA_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
  "text/xml",
]);

export function acceptsMediaType(mediaType: string): boolean {
  return TEXT_MEDIA_TYPES.has(mediaType);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
};

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, entity: string) => {
      if (entity[0] === "#") {
        const code =
          entity[1]?.toLowerCase() === "x"
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

export interface ExtractedText {
  title: string;
  text: string;
}

export function htmlToText(html: string): ExtractedText {
  const title = decodeEntities(
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "",
  )
    .replace(/\s+/g, " ")
    .trim();
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi,
      " ",
    )
    .replace(
      /<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|section|article|header|footer|blockquote|pre|dd|dt|dl|nav|aside|main|figure|figcaption|hr)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return { title, text };
}

export function decodeDocument(
  data: Uint8Array,
  mediaType: string,
): ExtractedText {
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(data);
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
    return htmlToText(raw);
  }
  const text = raw.replace(/\r\n?/g, "\n").replaceAll("\0", "").trim();
  return { title: text.split("\n")[0]?.slice(0, 120) ?? "", text };
}

export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’´`]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\p{L}\p{N}\s'"%.,:;$-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const MIN_QUOTE_CHARS = 20;
export const MAX_QUOTE_CHARS = 600;

export function quoteSupported(pageText: string, quote: string): boolean {
  const needle = normalizeForMatch(quote);
  if (needle.length < MIN_QUOTE_CHARS || needle.length > MAX_QUOTE_CHARS) {
    return false;
  }
  return normalizeForMatch(pageText).includes(needle);
}

export function textFingerprint(text: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(normalizeForMatch(text))
    .digest("hex");
}
