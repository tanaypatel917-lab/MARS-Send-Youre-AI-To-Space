import { expect, test } from "bun:test";
import { parseOutput } from "./parse";
import { processOutput } from "./process";
import { renderTerminal } from "./render-terminal";

const SAMPLE = `Here is the draft you asked for, plus a shorter version.

:::writing{id="48213" variant="email" subject="Launch timing" recipient="ada@example.com" cc="grace@example.com"}
::tone[Formal]
Dear Ada,

The launch window opens on Thursday. Please confirm the payload manifest by Wednesday noon so the integration team can finish the checklist without rushing the final review.

Best regards,
MARS
::tone[Casual]
Hi Ada — launch window opens Thursday. Can you confirm the manifest by Wednesday noon?
:::

:::writing{id="77001" variant="document"}
# Checklist

- Payload manifest signed
- Range safety brief
:::

Open the channel with [$Notify crew](app://slack) or look at [the diff](mars://review?pr=https://github.com/acme/rocket/pull/7&path=src/launch.ts&line=10&end=14&side=right). Avoid [this](file:///etc/hosts).

- :mars-followup[Send the formal email]{prompt="Send writing block 48213 using the Formal tone to ada@example.com"}
- :mars-followup[Shorten the checklist]{prompt="Rewrite block 77001 as three bullet points"}
`;

const ESC = "\u001b";

const CONTEXT = {
  connector_ids: ["calendar"],
  allowed_addresses: ["ada@example.com"],
};

const GOLDEN = `Here is the draft you asked for, plus a shorter version.

┌──────────────────────────────────────────────────────────┐
│ email #48213                                             │
│ Subject: Launch timing                                   │
│ To: ada@example.com                                      │
│ Cc: grace@example.com                                    │
├──────────────────────────────────────────────────────────┤
│ ── Formal ──                                             │
│ Dear Ada,                                                │
│                                                          │
│ The launch window opens on Thursday. Please confirm the  │
│ payload manifest by Wednesday noon so the integration    │
│ team can finish the checklist without rushing the final  │
│ review.                                                  │
│                                                          │
│ Best regards,                                            │
│ MARS                                                     │
├──────────────────────────────────────────────────────────┤
│ ── Casual ──                                             │
│ Hi Ada — launch window opens Thursday. Can you confirm   │
│ the manifest by Wednesday noon?                          │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ document #77001                                          │
├──────────────────────────────────────────────────────────┤
│ # Checklist                                              │
│                                                          │
│ - Payload manifest signed                                │
│ - Range safety brief                                     │
└──────────────────────────────────────────────────────────┘

Open the channel with [$Notify crew](app://slack) or look at [the diff](mars://review?pr=https://github.com/acme/rocket/pull/7&path=src/launch.ts&line=10&end=14&side=right). Avoid [this](file:///etc/hosts).

Follow-ups
  1. Send the formal email
     prompt: Send writing block 48213 using the Formal tone to ada@example.com
  2. Shorten the checklist
     prompt: Rewrite block 77001 as three bullet points

Proposed actions (not executed)
  - App trigger "$Notify crew": connector slack (line 22) — rejected (unknown_connector)
  - Review "the diff": https://github.com/acme/rocket/pull/7 src/launch.ts:10-14 (right, line 22)

Format errors
  - line 3 [invented_address] block 48213: Email cc "grace@example.com" was not supplied by the user.
  - line 22 [forbidden_link_scheme]: file:// links are not allowed; reference local files by absolute or workspace-relative path.
  - line 22 [unknown_connector]: No registered connector "slack".
`;

test("renderTerminal matches the golden rendering at width 60", () => {
  const processed = processOutput(SAMPLE, CONTEXT);
  expect(processed.ok).toBe(false);
  expect(processed.document.app_triggers).toHaveLength(1);
  expect(processed.document.review_links).toHaveLength(1);
  expect(
    renderTerminal(processed.document, { errors: processed.errors, width: 60 }),
  ).toBe(GOLDEN);
});

test("renderTerminal is deterministic and defaults to width 80 without ANSI codes", () => {
  const document = parseOutput(SAMPLE);
  const first = renderTerminal(document);
  expect(renderTerminal(document)).toBe(first);
  expect(first).not.toContain(ESC);
  const frame = first.split("\n").find((line) => line.startsWith("┌"));
  expect(frame).toHaveLength(80);
  for (const line of first.split("\n"))
    if (line.startsWith("│")) expect(line).toHaveLength(80);
});

test("renderTerminal lists parse errors by default and shows every hidden prompt", () => {
  const document = parseOutput(SAMPLE);
  const rendered = renderTerminal(document);
  expect(rendered).toContain("Format errors");
  expect(rendered).toContain("[forbidden_link_scheme]");
  expect(rendered).not.toContain("[invented_address]");
  expect(rendered).toContain(
    "Follow-ups\n  1. Send the formal email\n     prompt: Send writing block 48213",
  );
  expect(rendered).toContain(
    "  2. Shorten the checklist\n     prompt: Rewrite block 77001",
  );
  expect(rendered).toContain("Proposed actions (not executed)");
  expect(rendered).toContain(
    'App trigger "$Notify crew": connector slack (line 22)',
  );
  expect(rendered).not.toContain("rejected");
});

test("renderTerminal marks proposals that failed validation as rejected", () => {
  const processed = processOutput(SAMPLE, CONTEXT);
  const rendered = renderTerminal(processed.document, {
    errors: processed.errors,
  });
  expect(rendered).toContain(
    "connector slack (line 22) — rejected (unknown_connector)",
  );
  expect(rendered).toContain("src/launch.ts:10-14 (right, line 22)\n");
});

test("renderTerminal truncates long headers and wraps long bodies inside the frame", () => {
  const long = "word ".repeat(40).trim();
  const document = parseOutput(
    `:::writing{id="11111" variant="email" subject="${long}" recipient="ada@example.com"}
${long}
:::`,
  );
  const lines = renderTerminal(document, { width: 40 }).split("\n");
  for (const line of lines) if (line.length > 0) expect(line).toHaveLength(40);
  expect(lines[2]).toBe("│ Subject: word word word word word w… │");
  expect(
    lines.filter((line) => line.includes("word word")).length,
  ).toBeGreaterThan(5);
});

test("renderTerminal emits ANSI codes only when color is requested", () => {
  const document = parseOutput(SAMPLE);
  const colored = renderTerminal(document, { color: true, width: 60 });
  expect(colored).toContain(`${ESC}[1mFollow-ups${ESC}[0m`);
  expect(colored.split(new RegExp(`${ESC}\\[[0-9;]*m`)).join("")).toBe(
    renderTerminal(document, { width: 60 }),
  );
});

test("renderTerminal renders an empty document as a single newline", () => {
  expect(renderTerminal(parseOutput(""))).toBe("\n");
});
