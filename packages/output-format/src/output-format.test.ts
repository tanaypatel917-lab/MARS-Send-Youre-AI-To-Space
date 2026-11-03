import { describe, expect, test } from "bun:test";
import { OutputDocumentSchema, type OutputErrorCode } from "@mars/contracts";
import {
  canonicalAddress,
  collectAddresses,
  followUps,
  headerAttributes,
  OUTPUT_FORMAT_PROMPT,
  parseAttributes,
  parseOutput,
  processOutput,
  rewriteWritingBlocks,
  serializeOutput,
  validateOutput,
  writingBlocks,
} from "./index";

const fixture = (name: string) =>
  Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();
const context = {
  connector_ids: ["calendar"],
  allowed_addresses: ["ana@example.com", "Bob <bob@example.com>"],
};
const codes = (errors: { code: OutputErrorCode }[]) =>
  errors.map((error) => error.code);

describe("parseOutput golden fixture", () => {
  test("extracts every construct and validates against the schema", async () => {
    const text = await fixture("reply.md");
    const document = parseOutput(text);
    expect(OutputDocumentSchema.parse(document)).toEqual(document);
    expect(document.segments.map((segment) => segment.kind)).toEqual([
      "markdown",
      "writing",
      "markdown",
      "follow_up",
      "follow_up",
      "markdown",
    ]);
    const [block] = writingBlocks(document);
    expect(block).toMatchObject({
      id: "48213",
      variant: "email",
      email: {
        subject: "Re: launch",
        recipient: ["ana@example.com"],
        cc: ["bob@example.com", "eve@evil.example"],
        bcc: [],
      },
      span: { start_line: 5, end_line: 12 },
    });
    expect(block?.tones).toEqual([
      { tone: "Formal", body: "Dear Ana,\n\nLaunch is set for Monday." },
      { tone: "Casual", body: "Hi Ana — Monday it is!" },
    ]);
    expect(document.links.map((link) => [link.kind, link.target])).toEqual([
      ["external", "https://example.com/thread"],
      [
        "review",
        "mars://review?pr=https://github.com/o/r/pull/1&path=src/app.ts&line=10&end=14&side=right",
      ],
      ["app", "app://calendar"],
      ["local", "docs/my file.md"],
    ]);
    expect(document.app_triggers).toEqual([
      { label: "$calendar", connector_id: "calendar", line: 15 },
    ]);
    expect(document.review_links).toEqual([
      {
        label: "this check",
        scheme: "mars",
        pr: "https://github.com/o/r/pull/1",
        path: "src/app.ts",
        line_start: 10,
        line_end: 14,
        side: "right",
        line: 14,
      },
    ]);
    expect(followUps(document)).toMatchObject([
      {
        label: "Send it",
        prompt: "Send the email draft 48213 as written",
        tag: "mars-followup",
      },
      {
        label: "Shorten",
        prompt: "Shorten draft 48213 to three sentences",
        tag: "codex-followup",
      },
    ]);
    expect(codes(document.errors)).toEqual([
      "backtick_in_link",
      "forbidden_link_scheme",
    ]);
  });

  test("validation adds context errors and keeps syntax errors", async () => {
    const result = processOutput(await fixture("reply.md"), context);
    expect(result.ok).toBe(false);
    expect(result.errors).toMatchObject([
      { code: "invented_address", line: 5, block_id: "48213" },
      { code: "backtick_in_link", line: 14 },
      { code: "forbidden_link_scheme", line: 15 },
    ]);
    const withoutContext = validateOutput(result.document, {
      connector_ids: [],
      allowed_addresses: [],
    });
    expect(codes(withoutContext.errors)).toContain("unknown_connector");
    expect(
      codes(withoutContext.errors).filter((c) => c === "invented_address"),
    ).toHaveLength(3);
  });

  test("round-trips byte-for-byte and structurally", async () => {
    const text = await fixture("reply.md");
    const document = parseOutput(text);
    expect(serializeOutput(document)).toBe(text);
    expect(parseOutput(serializeOutput(document))).toEqual(document);
  });

  test("the host can redact or replace blocks and re-parse consistently", async () => {
    const document = parseOutput(await fixture("reply.md"));
    const redacted = rewriteWritingBlocks(document, () => ({ kind: "redact" }));
    expect(writingBlocks(redacted)).toHaveLength(0);
    expect(serializeOutput(redacted)).toContain(
      "Writing block 48213 (email) was withheld",
    );
    expect(followUps(redacted)).toHaveLength(2);
    const replaced = rewriteWritingBlocks(document, (block) => ({
      kind: "replace",
      block: {
        ...block,
        email: block.email && { ...block.email, cc: ["bob@example.com"] },
        body: "Hello",
      },
    }));
    const [block] = writingBlocks(replaced);
    expect(block?.email?.cc).toEqual(["bob@example.com"]);
    expect(block?.body).toBe("Hello");
    expect(block?.tones).toEqual([]);
    expect(
      validateOutput(replaced, context).errors.map((e) => e.code),
    ).not.toContain("invented_address");
  });
});

describe("invalid constructs", () => {
  test("every malformed construct yields a typed error and stays Markdown", async () => {
    const document = parseOutput(await fixture("invalid.md"));
    expect(OutputDocumentSchema.parse(document)).toEqual(document);
    expect(writingBlocks(document).map((b) => b.id)).toEqual([
      "22222",
      "55555",
    ]);
    expect(followUps(document)).toHaveLength(0);
    expect(document.errors.map((e) => [e.code, e.line])).toEqual([
      ["invalid_block_id", 1],
      ["unknown_variant", 4],
      ["duplicate_id", 10],
      ["malformed_fence", 13],
      ["malformed_fence", 16],
      ["nested_fence", 20],
      ["malformed_link", 23],
      ["backtick_in_link", 23],
      ["malformed_link", 23],
      ["malformed_review_link", 24],
      ["malformed_link", 24],
      ["malformed_followup", 25],
      ["malformed_followup", 26],
      ["malformed_followup", 27],
      ["malformed_fence", 29],
      ["unclosed_fence", 32],
    ]);
    expect(
      document.review_links.map((r) => [r.line_start, r.line_end]),
    ).toEqual([[1, 200]]);
    const validated = validateOutput(document, context);
    expect(codes(validated.errors)).toContain("review_range_too_wide");
    expect(serializeOutput(document)).toBe(await fixture("invalid.md"));
  });

  test("ignores constructs inside code fences and code spans", () => {
    const text = [
      "```",
      ':::writing{id="12345" variant="note"}',
      '- :mars-followup[x]{prompt="y"}',
      "[a](file:///x)",
      "```",
      "Inline `[b](file:///y)` is literal, [c](https://ok.example) is not.",
    ].join("\n");
    const document = parseOutput(text);
    expect(document.errors).toEqual([]);
    expect(writingBlocks(document)).toHaveLength(0);
    expect(followUps(document)).toHaveLength(0);
    expect(document.links.map((l) => l.target)).toEqual(["https://ok.example"]);
  });

  test("never throws on arbitrary text and tolerates CRLF", () => {
    for (const text of [
      "",
      "\n",
      ":::",
      "::: writing",
      "[](",
      "- :codex-followup",
      "\r\n:::writing{\r\n",
    ]) {
      expect(() => OutputDocumentSchema.parse(parseOutput(text))).not.toThrow();
    }
    const crlf = parseOutput(
      ':::writing{id="12345" variant="note"}\r\nHi\r\n:::\r\n',
    );
    expect(writingBlocks(crlf)[0]?.body).toBe("Hi");
  });

  test("script-capable and editor schemes are rejected, not recorded as links", () => {
    const text = [
      "[a](javascript:alert(1))",
      "[b](JavaScript:alert(1))",
      "[c](<data:text/html,hi>)",
      "[d](vbscript:x) [e](blob:https://x) [f](vscode://file/x) [g](file:///x)",
      "[ok](https://ok.example) [tel](tel:+123) [rel](docs/a.md) [win](C:\\\\repo\\\\a.ts)",
    ].join("\n");
    const document = parseOutput(text);
    expect(codes(document.errors)).toEqual(
      Array<OutputErrorCode>(7).fill("forbidden_link_scheme"),
    );
    expect(document.links.map((l) => [l.kind, l.target])).toEqual([
      ["external", "https://ok.example"],
      ["other", "tel:+123"],
      ["local", "docs/a.md"],
      ["local", "C:\\\\repo\\\\a.ts"],
    ]);
    expect(parseOutput("[x](https://a.b/\u0001c)").errors[0]?.code).toBe(
      "malformed_link",
    );
  });

  test("a backslash-escaped space in a bare destination is malformed", () => {
    const document = parseOutput(
      "[docs](docs/a\\ b.md) and [ok](<docs/a b.md>) and [esc](https://x.y/a\\)b)",
    );
    expect(codes(document.errors)).toEqual(["malformed_link"]);
    expect(document.links.map((link) => link.target)).toEqual([
      "docs/a b.md",
      "https://x.y/a)b",
    ]);
  });

  test("destinations may contain balanced parentheses and escapes", () => {
    const document = parseOutput(
      "See [article](https://en.wikipedia.org/wiki/Function_(mathematics)) and [esc](https://a.b/x\\)y) and [app](app://cal(1)) now.",
    );
    expect(document.links.map((l) => l.target)).toEqual([
      "https://en.wikipedia.org/wiki/Function_(mathematics)",
      "https://a.b/x)y",
      "app://cal(1)",
    ]);
    expect(codes(document.errors)).toEqual(["malformed_link"]);
    expect(parseOutput("[unbalanced](https://a.b/(x").links).toEqual([]);
  });

  test("link-shaped text inside single-line and multi-line code spans is ignored", () => {
    const single = parseOutput(
      "Use `[`x`](https://a.b)` literally, then [real](https://c.d).",
    );
    expect(single.errors).toEqual([]);
    expect(single.links.map((l) => l.target)).toEqual(["https://c.d"]);
    const multi = parseOutput(
      [
        "Example: `",
        "[example](app://calendar) [x](https://in.span)",
        "` and [after](https://out.span)",
        "",
        "`unterminated",
        "[live](app://calendar)",
      ].join("\n"),
    );
    expect(multi.app_triggers.map((t) => [t.connector_id, t.line])).toEqual([
      ["calendar", 6],
    ]);
    expect(multi.links.map((l) => l.target)).toEqual([
      "https://out.span",
      "app://calendar",
    ]);
    expect(multi.errors).toEqual([]);
  });

  test("attribute keys that collide with object prototypes are malformed", () => {
    expect(parseAttributes('id="12345" __proto__="x"')).toBeNull();
    expect(parseAttributes('constructor="x"')).toBeNull();
    const document = parseOutput(
      ':::writing{id="12345" variant="note" __proto__="x"}\nbody\n:::',
    );
    expect(document.errors[0]?.code).toBe("malformed_fence");
    expect(writingBlocks(document)).toHaveLength(0);
    expect(Object.getPrototypeOf(parseAttributes('a="1"'))).toBe(
      Object.prototype,
    );
  });

  test("codex review links import with the same keys", () => {
    const document = parseOutput(
      "[x](codex://review?pr=https://github.com/o/r/pull/2&path=lib/a.ts&line=7&side=left)",
    );
    expect(document.review_links).toEqual([
      {
        label: "x",
        scheme: "codex",
        pr: "https://github.com/o/r/pull/2",
        path: "lib/a.ts",
        line_start: 7,
        line_end: 7,
        side: "left",
        line: 1,
      },
    ]);
    expect(
      parseOutput("[x](mars://review?pr=https://g.h/p/1&path=../a&line=1)")
        .errors[0]?.code,
    ).toBe("malformed_review_link");
    expect(
      parseOutput("[x](mars://review?pr=https://g.h/p/1&path=a&line=5&end=4)")
        .errors[0]?.code,
    ).toBe("malformed_review_link");
    expect(
      parseOutput(
        "[x](mars://review?pr=https://g.h/p/1&path=a&line=1&side=top)",
      ).errors[0]?.code,
    ).toBe("malformed_review_link");
  });
});

describe("helpers", () => {
  test("parseAttributes handles quoting, escapes and rejects malformed lists", () => {
    expect(
      parseAttributes(
        'id="12345" subject="Say \\"hi\\" \\\\ now" variant=note',
      ),
    ).toEqual({
      id: "12345",
      subject: 'Say "hi" \\ now',
      variant: "note",
    });
    expect(parseAttributes("")).toEqual({});
    expect(parseAttributes('id="1"id="2"')).toBeNull();
    expect(parseAttributes("id=")).toBeNull();
    expect(parseAttributes('a="1" a="2"')).toBeNull();
    expect(parseAttributes("=x")).toBeNull();
  });

  test("canonicalAddress accepts exactly one address, bare or bracketed", () => {
    expect(canonicalAddress("Ana@Example.com")).toBe("ana@example.com");
    expect(canonicalAddress("Ana Lopez <ana@example.com>")).toBe(
      "ana@example.com",
    );
    expect(
      canonicalAddress("User <allowed@example.com> evil@example.com"),
    ).toBeNull();
    expect(canonicalAddress("allowed@example.com evil@example.com")).toBeNull();
    expect(canonicalAddress("<a@b.co><c@d.co>")).toBeNull();
    expect(canonicalAddress("not an address")).toBeNull();
    const block =
      ':::writing{id="12345" variant="email" recipient="User <allowed@example.com> evil@example.com"}\nx\n:::';
    const result = validateOutput(parseOutput(block), {
      connector_ids: [],
      allowed_addresses: ["allowed@example.com"],
    });
    expect(codes(result.errors)).toEqual(["invented_address"]);
    const mailto = validateOutput(parseOutput("[m](mailto:evil@example.com)"), {
      connector_ids: [],
      allowed_addresses: ["allowed@example.com"],
    });
    expect(codes(mailto.errors)).toEqual(["invented_address"]);
  });

  test("collectAddresses finds user-supplied addresses once", () => {
    expect(
      collectAddresses([
        "Mail ana@example.com and Ana@Example.com, cc bob@example.com.",
      ]),
    ).toEqual(["ana@example.com", "Ana@Example.com", "bob@example.com"]);
    const document = parseOutput(
      ':::writing{id="12345" variant="email" recipient="Ana@Example.com"}\nx\n:::',
    );
    expect(
      validateOutput(document, {
        connector_ids: [],
        allowed_addresses: ["ana@example.com"],
      }).ok,
    ).toBe(true);
  });

  test("replacing a block's id, variant or email header wins over stale attributes", async () => {
    const document = parseOutput(await fixture("reply.md"));
    const replaced = rewriteWritingBlocks(document, (block) => ({
      kind: "replace",
      block: {
        ...block,
        id: "99999",
        email: block.email && {
          ...block.email,
          subject: "New",
          recipient: ["new@example.com"],
          cc: [],
          bcc: ["Bob <bob@example.com>"],
        },
      },
    }));
    const [block] = writingBlocks(replaced);
    expect(block?.id).toBe("99999");
    expect(block?.email).toEqual({
      subject: "New",
      recipient: ["new@example.com"],
      cc: [],
      bcc: ["Bob <bob@example.com>"],
    });
    expect(block?.attributes).toEqual({
      id: "99999",
      variant: "email",
      subject: "New",
      recipient: "new@example.com",
      cc: "",
      bcc: "Bob <bob@example.com>",
    });
    const note = rewriteWritingBlocks(document, (b) => ({
      kind: "replace",
      block: { ...b, variant: "note", email: null },
    }));
    expect(writingBlocks(note)[0]).toMatchObject({
      variant: "note",
      email: null,
    });
    expect(headerAttributes(writingBlocks(note)[0] as never)).toEqual({
      id: "48213",
      variant: "note",
      subject: "Re: launch",
      recipient: "ana@example.com",
      cc: "bob@example.com, eve@evil.example",
    });
  });

  test("serializer escapes follow-up prompts and quotes bare attributes canonically", () => {
    const text = [
      '- :mars-followup[Say "hi"]{prompt="Reply \\"hi\\" to Ana"}',
      ":::writing{id=12345 variant=note}",
      "x",
      ":::",
    ].join("\n");
    const document = parseOutput(text);
    expect(followUps(document)[0]?.prompt).toBe('Reply "hi" to Ana');
    const canonical = serializeOutput(document);
    expect(canonical).toBe(
      [
        '- :mars-followup[Say "hi"]{prompt="Reply \\"hi\\" to Ana"}',
        ':::writing{id="12345" variant="note"}',
        "x",
        ":::",
      ].join("\n"),
    );
    expect(parseOutput(canonical)).toEqual(document);
  });

  test("prompt fragment is short and names every construct", () => {
    expect(OUTPUT_FORMAT_PROMPT.length).toBeLessThan(2000);
    for (const needle of [
      ":::writing",
      "::tone[",
      "app://",
      "mars://review",
      ":mars-followup",
      "never invent",
    ])
      expect(OUTPUT_FORMAT_PROMPT).toContain(needle);
  });
});
