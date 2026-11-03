/**
 * Threat-pattern scanner for untrusted memory, skill, and review content.
 *
 * Ported from the Hermes Agent memory threat scanner (MIT; see
 * `packages/memory/NOTICE`) via `mars-platform/services/memory/src/threats.ts`.
 * The invisible-Unicode denylist is deliberately broader than upstream: every
 * default-ignorable or format code point that renders as nothing (and so can
 * smuggle instructions past a human reviewer) is rejected before NFKC
 * normalization, because normalization erases some of them.
 */

const MAX_SCAN_CODE_POINTS = 65_536;
/** Window overlap so a pattern straddling a boundary is still seen whole. */
const SCAN_OVERLAP_CODE_POINTS = 4_096;

/** Inclusive code-point ranges rejected as `invisible_unicode`. */
export const INVISIBLE_CODE_POINT_RANGES: readonly (readonly [
  number,
  number,
  string,
])[] = [
  [0x00ad, 0x00ad, "soft hyphen"],
  [0x034f, 0x034f, "combining grapheme joiner"],
  [0x061c, 0x061c, "Arabic letter mark"],
  [0x115f, 0x1160, "Hangul choseong/jungseong fillers"],
  [0x17b4, 0x17b5, "Khmer inherent vowels"],
  [0x180b, 0x180f, "Mongolian free variation selectors and vowel separator"],
  [0x200b, 0x200f, "zero-width space/joiners, LRM, RLM"],
  [0x2028, 0x2029, "line and paragraph separators"],
  [0x202a, 0x202e, "bidirectional embedding and override controls"],
  [0x2060, 0x2064, "word joiner and invisible operators"],
  [0x2066, 0x206f, "bidirectional isolates and deprecated format controls"],
  [0x3164, 0x3164, "Hangul filler"],
  [0xfe00, 0xfe0f, "variation selectors"],
  [0xfeff, 0xfeff, "zero-width no-break space / BOM"],
  [0xffa0, 0xffa0, "halfwidth Hangul filler"],
  [0xfff9, 0xfffb, "interlinear annotation controls"],
  [0x1bca0, 0x1bca3, "shorthand format controls"],
  [0x1d173, 0x1d17a, "musical symbol format controls"],
  [0xe0000, 0xe007f, "tag characters"],
  [0xe0100, 0xe01ef, "variation selectors supplement"],
];

export function isInvisibleCodePoint(codePoint: number): boolean {
  if (codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f))
    return true;
  if (codePoint < 0x20) return codePoint !== 0x09 && codePoint !== 0x0a;
  for (const [start, end] of INVISIBLE_CODE_POINT_RANGES)
    if (codePoint >= start && codePoint <= end) return true;
  return false;
}

export function findInvisibleCodePoint(content: string): number | undefined {
  for (const char of content) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isInvisibleCodePoint(codePoint) && codePoint !== 0x0d) return codePoint;
  }
  return undefined;
}

const filler = String.raw`(?:\w+\s+){0,8}`;
const secretVar = String.raw`\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b`;
const modify = String.raw`(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}`;

const patterns: readonly (readonly [string, string])[] = [
  [
    `ignore\\s+${filler}(previous|all|above|prior)\\s+${filler}instructions`,
    "prompt_injection",
  ],
  [String.raw`system\s+prompt\s+override`, "sys_prompt_override"],
  [
    `disregard\\s+${filler}(your|all|any)\\s+${filler}(instructions|rules|guidelines)`,
    "disregard_rules",
  ],
  [
    `act\\s+as\\s+(if|though)\\s+${filler}you\\s+${filler}(have\\s+no|don't\\s+have)\\s+${filler}(restrictions|limits|rules)`,
    "bypass_restrictions",
  ],
  [
    "<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->",
    "html_comment_injection",
  ],
  [
    String.raw`<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none`,
    "hidden_div",
  ],
  [
    String.raw`translate\s+[^\n]{0,512}\s+into\s+\w+(?:[\s-]+\w+){0,2}\s+and\s+(execute|run|eval)\b`,
    "translate_execute",
  ],
  [`do\\s+not\\s+${filler}tell\\s+${filler}the\\s+user`, "deception_hide"],
  [`you\\s+are\\s+${filler}now\\s+(?:a|an|the)\\s+`, "role_hijack"],
  [`pretend\\s+${filler}(you\\s+are|to\\s+be)\\s+`, "role_pretend"],
  [`output\\s+${filler}(system|initial)\\s+prompt`, "leak_system_prompt"],
  [
    `(respond|answer|reply)\\s+without\\s+${filler}(restrictions|limitations|filters|safety)`,
    "remove_filters",
  ],
  [
    `you\\s+have\\s+been\\s+${filler}(updated|upgraded|patched)\\s+to`,
    "fake_update",
  ],
  [String.raw`\bname\s+yourself\s+\w+`, "identity_override"],
  [String.raw`register\s+(as\s+)?a?\s*node`, "c2_node_registration"],
  [
    String.raw`(heartbeat|beacon|check[\s\-]?in)\s+(to|with)\s+`,
    "c2_heartbeat",
  ],
  [String.raw`pull\s+(down\s+)?(?:new\s+)?task(?:ing|s)?\b`, "c2_task_pull"],
  [String.raw`connect\s+to\s+the\s+network\b`, "c2_network_connect"],
  [
    String.raw`you\s+must\s+(?:\w+\s+){0,3}(register|connect|report|beacon)\b`,
    "forced_action",
  ],
  [String.raw`only\s+use\s+one[\s\-]?liners?\b`, "anti_forensic_oneliner"],
  [
    `never\\s+${filler}(?:create|write)\\s+${filler}(?:script|file)\\s+${filler}disk`,
    "anti_forensic_disk",
  ],
  [
    String.raw`unset\s+\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC|MARS)\w*`,
    "env_var_unset_agent",
  ],
  [
    String.raw`\b(?:cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b`,
    "known_c2_framework",
  ],
  [
    String.raw`\bc2\s+(?:server|channel|infrastructure|beacon)\b`,
    "c2_explicit",
  ],
  [String.raw`\bcommand\s+and\s+control\b`, "c2_explicit_long"],
  [`curl\\s+[^\\n]{0,2048}${secretVar}`, "exfil_curl"],
  [`wget\\s+[^\\n]{0,2048}${secretVar}`, "exfil_wget"],
  [
    String.raw`cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)`,
    "read_secrets",
  ],
  [
    String.raw`(send|post|upload|transmit)\s+[^\n]{0,2048}\s+(to|at)\s+https?://`,
    "send_to_url",
  ],
  [
    `(include|output|print|share)\\s+${filler}(conversation|chat\\s+history|previous\\s+messages|full\\s+context|entire\\s+context)`,
    "context_exfil",
  ],
  ["authorized_keys", "ssh_backdoor"],
  [
    String.raw`(?:\b(?:echo|cat|cp|mv|dd|tee|install|printf|rsync|scp|ln|append|add|write|sed|chmod|chown|truncate|rm|touch|curl|wget|git)\b|\bopen\s*\(|>>?)[^\n]{0,512}(?:\$HOME/\.ssh|~/\.ssh)`,
    "ssh_access",
  ],
  [String.raw`\$HOME/\.hermes/\.env|~/\.hermes/\.env`, "hermes_env"],
  [
    `${modify}(?:AGENTS\\.md|CLAUDE\\.md|\\.cursorrules|\\.clinerules)`,
    "agent_config_mod",
  ],
  [`${modify}\\.hermes/(config\\.yaml|SOUL\\.md)`, "hermes_config_mod"],
  [`${modify}\\.mars/(models\\.json|config\\.json|skills/)`, "mars_config_mod"],
];
const compiled = patterns.map(
  ([pattern, id]) => [new RegExp(pattern, "iu"), id] as const,
);

export const THREAT_PATTERN_IDS: readonly string[] = [
  "invisible_unicode",
  ...patterns.map(([, id]) => id),
  "hardcoded_secret",
];

const SECRET_ASSIGNMENT =
  /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["']([A-Za-z0-9+/=_-]{20,})/giu;

/**
 * Returns a threat identifier when `content` matches a denied pattern, else
 * `undefined`. Long content is scanned in overlapping 65,536-code-point
 * windows so no part of it escapes the patterns.
 */
export function scanThreat(content: string): string | undefined {
  if (findInvisibleCodePoint(content) !== undefined) return "invisible_unicode";
  const codePoints = [...content];
  for (
    let start = 0;
    start === 0 || start < codePoints.length;
    start += MAX_SCAN_CODE_POINTS - SCAN_OVERLAP_CODE_POINTS
  ) {
    const threat = scanWindow(
      codePoints.slice(start, start + MAX_SCAN_CODE_POINTS).join(""),
    );
    if (threat) return threat;
  }
  return undefined;
}

function scanWindow(raw: string): string | undefined {
  const normalized = raw.normalize("NFKC");
  if (findInvisibleCodePoint(normalized) !== undefined)
    return "invisible_unicode";
  for (const [pattern, id] of compiled) if (pattern.test(normalized)) return id;
  for (const match of normalized.matchAll(SECRET_ASSIGNMENT)) {
    const value = match[1] ?? "";
    const next = normalized[(match.index ?? 0) + match[0].length];
    const placeholder =
      /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value) &&
      (next === '"' || next === "'");
    if (!placeholder) return "hardcoded_secret";
  }
  return undefined;
}
