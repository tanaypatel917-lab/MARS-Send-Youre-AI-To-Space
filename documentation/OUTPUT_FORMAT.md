# MARS Output Format (v1)

`@mars/output-format` (`packages/output-format`) with schemas in
`packages/contracts/src/output-format.ts`.

## 1. Purpose and status

The MARS Output Format is the structured model-to-UI contract for agent text.
Every agent role (coordinator, workers, reviewer, delegated children) writes
Markdown with a small set of extra constructs, and every client (CLI, VS Code,
future dashboard) parses that text deterministically into an `OutputDocument`:
renderable artifacts (writing blocks), deep links (local files, app triggers,
code locations) and follow-up proposals. There is no model in the parser; the
same text always yields the same document.

This is MARS's own specification. It is inspired by a publicly described but
unverified third-party format and does not claim compatibility with any OpenAI
product. `:codex-followup` and `codex://review` are accepted on parse only as
import aliases so existing text in that shape can be read; MARS emits the
`:mars-followup` and `mars://review` forms.

**Status:** parser, validator, serializer and prompt fragment are implemented
and verified offline by `packages/output-format/src/output-format.test.ts`
against the fixtures in `packages/output-format/src/fixtures` (`bun run check`,
`model_requests: 0`). The CLI (`mars render`, `renderTerminal`) and the VS
Code webview (Inspect on the final `text/plain` artifact) render it; no live
model has produced this format yet and no real terminal or VS Code window has
been exercised; see section 11.

## 2. Base: Markdown

The base is strict GitHub-flavored Markdown (CommonMark compliant). The parser
does not build a Markdown AST. It scans line by line, extracts the MARS
constructs below and keeps everything else as `markdown` segments holding the
raw text, so a client renders those segments with its own Markdown renderer.

Fenced code blocks (``` or ~~~, up to three leading spaces, closed by a fence
of the same character at least as long) and inline code spans are opaque:
nothing inside them is parsed, no error is reported for them, and a fence
inside a writing block likewise hides tone markers. A code span may span
lines (CommonMark) as long as its closing backtick run appears before the
next blank line or fence. `\r\n` is normalized to `\n`. Image links
`![alt](src)` are ignored entirely.

## 3. Writing blocks

A writing block is a draft the user may copy or revise.

```
:::writing{id="48213" variant="email" subject="Sprint review" recipient="dana@example.com" cc="lee@example.com"}
Hi Dana,

The review notes are in [the tracker](https://example.com/sprint-12).

::tone[Formal]
Dear Dana, please find the sprint review notes attached.

::tone[Casual]
Hey Dana, notes are up!
:::
```

Rules:

- The opening line is exactly `:::writing{...}` and the closing line exactly
  `:::`; no indentation, nothing else on either line.
- Attributes are `key="value"` pairs separated by whitespace. Inside quotes
  a backslash escapes the next character (`subject="Re: \"Q3\""` yields
  `Re: "Q3"`; the serializer escapes only `"` and `\`). Bare
  values without quotes are accepted when they contain no whitespace, quotes
  or braces (`id=48213`). Keys match `[A-Za-z_][A-Za-z0-9_-]*` and must be
  unique; a duplicate key, or one of the reserved keys `__proto__`,
  `constructor`, `prototype`, makes the whole fence `malformed_fence`.
- `id` is required: exactly five digits, unique within the document. The
  model reuses the same id when revising the same draft so clients can
  replace it in place. Four digits or a missing id is `invalid_block_id`; a
  reused id is `duplicate_id`.
- `variant` is required and one of `email`, `document`, `post`, `message`,
  `note`, `summary`, `plan`, `commit`; anything else is `unknown_variant`.
- Unknown attributes are kept verbatim in `block.attributes` (which also
  holds `id` and `variant`).
- `body` is the raw text between the fences, newline-joined, without the
  fences. An empty block has `body: ""`.

### Email attributes

For `variant="email"` the parser fills `block.email` from `subject`
(`null` when absent) and `recipient`, `cc`, `bcc`. Address lists are split on
`,` or `;` and trimmed; `Lee Park <lee@example.com>` is accepted. For every
other variant `block.email` is `null`.

Addresses must come from the user. `canonicalAddress(value)` accepts exactly
one address, bare `addr` or `Name <addr>`, trimmed and lower-cased; anything
else (two addresses in one value, text after `>`) yields `null`. Both the
entries of `context.allowed_addresses` and every `recipient`/`cc`/`bcc` value
go through it, and `validateOutput` reports `invented_address` for each value
that is not exactly one allowed address, on the block's opening line with its
`block_id`. The same check applies to every `mailto:` link in the document
(the part after `mailto:` and before `?`). `collectAddresses(texts)` extracts
addresses from user-supplied text so a host can build `allowed_addresses`.

### Tone sections

Alternative tones live inside one block as sections introduced by a line
exactly `::tone[Name]` (no indentation; the name is trimmed). `block.tones` is
the list of `{ tone, body }` sections in order; `block.body` is still the
whole raw inner text including the marker lines. Text before the first marker
belongs to `body` only. A `::tone[...]` line inside a code fence is not a
marker. Separate blocks for separate tones are discouraged by the prompt but
not an error.

### Malformed, nested and unclosed fences

Parsing never throws on model text; problems become typed errors and the
offending lines stay Markdown.

- An opening line that looks like a fence (`:::writing` after optional
  whitespace) but is not exactly `:::writing{...}` with valid attributes,
  or whose id or variant is invalid, is reported on that line. Its lines up
  to the next `:::` line are kept as Markdown (links still scanned, with
  `block_id: null`); follow-ups inside are not recognised.
- A second `:::writing` line inside an open block is `nested_fence`; the
  line stays part of the body and the block closes at the next `:::`.
- A closing line that is `:::` with surrounding whitespace closes the block
  but is `malformed_fence`.
- `:::` with no open block is `malformed_fence`.
- A block never closed is `unclosed_fence` (reported on the last line); all
  its lines fall back to Markdown and no writing segment is produced.

## 4. Links

Every non-image `[Label](target)` outside code is recorded in
`document.links` with `kind`, `label`, `target`, `line` and the `block_id` of
the enclosing writing block (or `null`). A bare destination ends at the first
whitespace or unbalanced `)`; it may contain balanced parentheses and
backslash escapes per CommonMark (`[wp](https://en.wikipedia.org/wiki/Foo_(bar))`
keeps the parentheses, `\)` yields `)`). Text with an unbalanced `(` is not a
link at all. Angle-bracket targets `<...>` take everything up to `>`.

| Form | Kind | Notes |
| --- | --- | --- |
| `[Docs](https://example.com/x)`, `[Mail](mailto:a@x.com)` | `external` | `http`, `https`, `mailto`; clickable |
| `[Roadmap](<docs/road map.md>)` | `local` | targets containing spaces must be wrapped in `<...>`; the brackets are stripped |
| `[Config](/etc/mars/config.toml)`, `[Note](./docs/a.md)`, `[Win](C:\repo\x.ts)` | `local` | absolute or workspace-relative path; anything without a scheme |
| `[Top](#heading)` | `anchor` | |
| `[$github](app://github)` | `app` | section 5 |
| `[parse.ts](mars://review?...)` | `review` | section 6 |
| `[x](ftp://host/x)`, `[call](tel:+1555)` | `other` | any other non-forbidden scheme; recorded, no error, rendered as plain text |

Errors:

- `forbidden_link_scheme`: `file`, `vscode`, `vscode-insiders`, `javascript`,
  `vbscript`, `data`, `blob` (`FORBIDDEN_LINK_SCHEMES`, matched
  case-insensitively). The link is not recorded in `document.links` at all.
  Local files are referenced by path instead.
- `backtick_in_link`: a backtick anywhere in the label or target
  (`` [`x`](https://e.com) ``); the link is not recorded. A link that sits
  entirely inside a code span is ignored instead.
- `malformed_link`: an unwrapped target containing whitespace
  (`[a](docs/road map.md)`), an empty target (`[a]()`), or a target containing
  control characters (`\u0000`-`\u001f`, `\u007f`).

Renderers may make `external`, `local`, `app`, `review` and `anchor` links
clickable (after validation); `other` and anything that produced an error is
rendered as plain text (section 9).

## 5. App triggers

`[$name](app://connector-id)` proposes launching a registered connector or
tool. The label conventionally starts with `$`. The connector id matches
`[A-Za-z0-9][A-Za-z0-9_.:-]*` (`github`, `jira.cloud`). Valid triggers are
recorded in `document.app_triggers` as `{ label, connector_id, line }` and
also appear in `links` with `kind: "app"`.

- `malformed_link`: the id still contains a `{{...}}` template placeholder
  (`app://{{connector}}`) or is not a valid identifier (`app://bad/id`,
  `app://-lead`). Nothing is added to `app_triggers`.
- `unknown_connector` (validator): the id is not in `context.connector_ids`.
  The trigger stays in `app_triggers` so a client can show it as rejected.

## 6. Code locations

```
[parse.ts](mars://review?pr=https://github.com/acme/mars/pull/7&path=packages/output-format/src/parse.ts&line=42&end=48&side=right)
```

| Key | Rule |
| --- | --- |
| `pr` | required; an `http(s)` URL |
| `path` | required; workspace-relative file path, no `..` segment, no NUL |
| `line` | required; integer >= 1; becomes `line_start` |
| `end` | optional; integer >= `line`; becomes `line_end` (defaults to `line`) |
| `side` | optional; `left` or `right`; default `right` |

Any other query key is rejected. Every violation is `malformed_review_link`
and the link is not added to `document.review_links`. The validator reports
`review_range_too_wide` when `line_end - line_start + 1` exceeds
`context.max_review_lines` (default `DEFAULT_MAX_REVIEW_LINES`, 40); the link
stays in `review_links`.

A host that opens a review link checks the local file first: a path that
is a directory or not a regular file, a file shorter than `line_start`, or an
editor failure is refused with a visible reason instead of selecting
unrelated lines; a range that runs past the end of the local file is clamped
and the notice says which lines were not selected.

`codex://review?...` is accepted on import with the same keys:

| Import form | Parsed as |
| --- | --- |
| `codex://review?pr=&path=&line=&end=&side=` | same `pr`, `path`, `line_start`, `line_end`, `side` |
| scheme | `scheme: "codex"` (MARS form records `scheme: "mars"`) |

## 7. Follow-ups

```
- :mars-followup[Send the email]{prompt="Send the sprint review email to dana@example.com as drafted in block 48213."}
```

A follow-up is a whole list item: `-` or `*`, one space, then
`:mars-followup[label]{prompt="..."}`, optionally followed by trailing
whitespace only. `:codex-followup` is accepted as an alias and recorded in
`tag`. The label and the prompt are trimmed and must be non-empty; the prompt
is at most `MAX_FOLLOW_UP_PROMPT_LENGTH` (8,000) characters, the same bound
the clients accept for a steering message, so every rendered button can be
sent; it uses the attribute grammar of section 3 (so `\"` escapes a quote) and
other keys in the braces are ignored. Each follow-up becomes its own `follow_up`
segment `{ label, prompt, tag, span }`; `followUps(document)` lists them.

Any line that starts with an optional bullet and `:mars-followup` or
`:codex-followup` but does not match the form (indented item, missing or
blank prompt, empty label, trailing text, no bullet) is `malformed_followup`
and stays Markdown. `:mars-followup` mentioned mid-sentence is plain text.

Rendering: the CLI shows follow-ups as a numbered chooser, VS Code as
buttons. In both the visible text is the label and the hidden prompt must be
available on demand (tooltip, expand, or the chooser echoing it) before the
user submits it. Choosing a follow-up submits the prompt as the user's next
message; nothing is sent until the user chooses.

## 8. Error catalogue

`OutputError` is `{ code, message, line, block_id }`; `line` is the 1-based
source line, `block_id` the enclosing writing block when known. Parser errors
are in `document.errors`; `validateOutput` returns them merged with the
context errors, sorted by line.

| Code | Reported by | Construct | Meaning |
| --- | --- | --- | --- |
| `malformed_fence` | parser | writing block | opening line not exactly `:::writing{...}`, attributes invalid, duplicate or reserved key; closing `:::` with whitespace; `:::` with no open block |
| `unclosed_fence` | parser | writing block | document ended inside a block or a skipped fence region |
| `nested_fence` | parser | writing block | `:::writing` inside an open block |
| `invalid_block_id` | parser | writing block | `id` missing or not five digits |
| `duplicate_id` | parser | writing block | `id` already used in this document |
| `unknown_variant` | parser | writing block | `variant` not in the list of section 3 |
| `malformed_link` | parser | link, app trigger | unwrapped spaces, empty target, control characters, invalid or templated connector id |
| `backtick_in_link` | parser | link | backtick in label or target |
| `forbidden_link_scheme` | parser | link | `file`, `vscode`, `vscode-insiders`, `javascript`, `vbscript`, `data`, `blob`; link not recorded |
| `unknown_connector` | validator | app trigger | id not in `connector_ids` |
| `malformed_review_link` | parser | code location | a key of section 6 violated or unknown key |
| `review_range_too_wide` | validator | code location | range wider than `max_review_lines` |
| `malformed_followup` | parser | follow-up | line starts like a follow-up but does not match the form |
| `invented_address` | validator | email block, `mailto:` link | value is not exactly one address from `allowed_addresses` |

## 9. Security model

Parsed output is untrusted model text. The document tells a client what the
model proposed; it never grants permission.

- Follow-up prompts, app triggers and review links are proposals. The host
  validates them (`validateOutput`) and the user explicitly accepts each one.
  A client must never auto-submit a follow-up prompt, auto-invoke a
  connector or auto-open a file, URL or review location because the model
  emitted a link, and must show the hidden prompt, the connector id or the
  target before acting.
- Entries that produced an error are displayed as plain text, not as
  actionable items; so are `other` links. Forbidden schemes (including the
  script-capable `javascript:`, `data:`, `blob:`) never reach `links`.
  `unknown_connector`, `review_range_too_wide` and `invented_address` leave
  the item in the document so it can be shown as rejected; it must not be
  actionable.
- Hosts can redact or rewrite writing blocks before display with
  `rewriteWritingBlocks(document, block => decision)`, where the decision is
  `{ kind: "keep" }`, `{ kind: "replace", block }` or
  `{ kind: "redact", notice? }`. Redaction replaces the block with a Markdown
  notice (default `> Writing block 48213 (email) was withheld by the host.`)
  and re-parses, so links, triggers and line numbers stay consistent.
- `OUTPUT_FORMAT_PROMPT` is a request to the model, not an enforcement
  mechanism. The parser and validator are: whatever the model writes, only
  the constructs they accept reach the client as structured items.
- The parser does not resolve paths, fetch URLs, or run anything.

## 10. Processing pipeline and API

```
text ──▶ parseOutput(text) ──▶ OutputDocument (segments, links, app_triggers, review_links, errors)
     ──▶ validateOutput(document, context) ──▶ { ok, errors }
processOutput(text, context) = both steps ──▶ { document, errors, ok }
```

- `parseOutput(text): OutputDocument` is pure and total. `format_version` is
  `1` (`OUTPUT_FORMAT_VERSION`). Segments cover every source line in order:
  `markdown`, `writing` and `follow_up`, each with a `span`
  (`start_line`, `end_line`).
- `validateOutput(document, context: OutputValidationContext)` checks the
  host-supplied facts: `connector_ids` (registered connectors),
  `allowed_addresses` (user-supplied addresses), `max_review_lines`
  (optional, default 40). It executes nothing.
- `processOutput(text, context)` is the usual entry point; `ok` is `true`
  only when there are no errors of either kind.
- Helpers: `writingBlocks(document)`, `followUps(document)`,
  `parseAttributes`, `splitAddresses`, `canonicalAddress`,
  `collectAddresses`.
- `serializeOutput(document)` renders canonical text: writing blocks as
  `:::writing{id="…" variant="…" …other attributes…}`, every attribute
  double-quoted with `\"`/`\\` escapes, `id` then `variant` first, body
  verbatim; follow-ups as `- :<tag>[label]{prompt="…"}`; markdown segments
  verbatim; segments joined with `\n`. `headerAttributes(block)` builds the
  opening fence: `id`, `variant` and `email` (`subject`, `recipient`, `cc`,
  `bcc`, lists joined with `, `) are the source of truth over the parsed
  `attributes` copy, so a host `replace` that edits those fields wins and any
  email key missing from `attributes` is appended. `serializeWritingBlock`,
  `serializeFollowUp`, `serializeSegment` and `serializeAttributes` are
  exported for partial use.

Round-trip guarantees: `parseOutput(serializeOutput(doc))` deep-equals `doc`
for any parsed document, and `serializeOutput` is byte-identical to the input
only when the input is already canonical (quoted attributes, `id` and
`variant` first, no stray whitespace). One edge case: a block whose body is a
single blank line parses to `body: ""` and serializes without that line, so
the re-parsed document is equal except that later spans shift up by one.

### Where the prompt fragment goes

`OUTPUT_FORMAT_PROMPT` is one short system-prompt section describing the
format. `packages/execution/src/runtime.ts` appends it once to the shared
`SYSTEM_PROMPT` that every Oh My Pi session created by the runtime receives,
so the coordinator, workers, the reviewer and delegated children all get the
same instructions. The research worker's extraction model
(`packages/research-worker/src/worker.ts`) replies JSON-only and is
intentionally excluded. Change the fragment only together with the parser.

## 11. Limits and non-goals

- No full CommonMark validation: the parser extracts MARS constructs and
  trusts the renderer for the rest. Malformed Markdown is passed through.
- No HTML rendering of model text in this package; clients render
  `markdown` segments with their own sanitizing renderer. The VS Code webview
  builds its DOM with `textContent` only (`apps/vscode/src/webview`); the CLI
  prints framed writing blocks, a numbered follow-up chooser and proposals
  (`apps/cli/src/render.ts`). Neither executes anything on the model's behalf.
- No connector registry yet: `connector_ids` is whatever the host passes;
  with an empty list every app trigger is `unknown_connector`.
- `allowed_addresses` is only as good as the host's collection of
  user-supplied addresses.
- Links inside a block that turns out to be unclosed keep that block's
  `block_id` even though no writing segment is produced.
- Unverified: no live model has produced this format; all evidence is
  offline fixtures run through the parser. Whether models follow the prompt
  fragment reliably, and how clients render the segments, remain to be
  measured.

### Next steps for hosts

1. Host: supply `connector_ids` from a real connector registry (today both
   clients register none, so every `app://` trigger is `unknown_connector`)
   and `allowed_addresses` from `collectAddresses` over the user's request
   text; run `processOutput` on the final `text/plain` artifact in the
   workbench host so validation errors reach every client once.
2. Mark the final-response artifact with an explicit role in task metadata;
   the VS Code client currently infers it from a bare `text/plain` artifact
   listed on the task.
3. Verify with a live model and a real terminal / VS Code window; measure how
   reliably models follow the prompt fragment.
