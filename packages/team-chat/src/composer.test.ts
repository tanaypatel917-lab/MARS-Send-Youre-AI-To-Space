import { describe, expect, test } from "bun:test";
import {
  buildSend,
  type ComposerEnvironment,
  type ComposerState,
  composerProblem,
  EMPTY_COMPOSER,
  keyIntent,
  mentionOptionId,
  nextPickerStatus,
  pickerAnnouncement,
  reduceComposer,
} from "./composer";
import { FIXTURE_REPOS as R, SITE_SHA, FIXTURE_USERS as U } from "./fixture";
import { chipLabel, mentionCandidates, parseMarsInvocation } from "./mentions";
import { FixtureTeamService } from "./service";

const index = new FixtureTeamService().mentionIndex(U.ada);
const env: ComposerEnvironment = {
  index,
  activeRepoId: R.platform,
  maxChips: 8,
};

function type(state: ComposerState, text: string): ComposerState {
  return reduceComposer(
    state,
    { type: "input", text, caret: text.length },
    env,
  );
}

describe("mention candidates", () => {
  test("empty query lists files from the active repo first, then the other repo", () => {
    const candidates = mentionCandidates(index, "", R.platform);
    expect(candidates.map((c) => c.kind)).toEqual([
      "file",
      "file",
      "file",
      "file",
    ]);
    expect(
      candidates.map((c) => (c.kind === "file" ? c.repo_id : null)),
    ).toEqual([R.platform, R.platform, R.site, R.site]);
  });

  test("a path query matches files across both repos and a symbol query matches symbols", () => {
    const files = mentionCandidates(index, "src/", null);
    expect(
      new Set(files.map((c) => ("repo_id" in c ? c.repo_id : null))),
    ).toEqual(new Set([R.platform, R.site]));
    const symbols = mentionCandidates(index, "banner", R.site);
    expect(symbols.map((c) => `${c.kind}:${c.label}`)).toEqual([
      "symbol:bannerHeight",
      "symbol:--banner-height",
      "symbol:.banner",
      "symbol:.banner .verdict",
    ]);
    const second = symbols[1];
    if (!second || !("reference" in second)) {
      throw new Error("expected code candidate");
    }
    expect(second.reference).toMatchObject({
      kind: "symbol",
      path: "src/style.css",
      line_start: 5,
      line_end: 5,
      symbol: "--banner-height",
      commit_sha: SITE_SHA,
    });
  });

  test("path:start-end yields a range bounded by the blob length", () => {
    const [range] = mentionCandidates(index, "how.ts:4-6", null);
    expect(range).toMatchObject({
      kind: "range",
      label: "src/how.ts:4-6",
      reference: { line_start: 4, line_end: 6, path: "src/how.ts" },
    });
    expect(mentionCandidates(index, "how.ts:4-600", null)).toEqual([]);
    expect(mentionCandidates(index, "how.ts:0-2", null)).toEqual([]);
  });

  test("chip labels show repo, path, short SHA and range", () => {
    const [range] = mentionCandidates(index, "style.css:14-23", null);
    if (!range || !("reference" in range)) throw new Error("no candidate");
    expect(chipLabel(range.reference, range.repo_name)).toBe(
      "mars-site (fixture) · src/style.css:14-23 @ a1b2c3d",
    );
  });
});

describe("composer reducer", () => {
  test("same-name symbols on different lines can both be attached", () => {
    const localEnv: ComposerEnvironment = {
      ...env,
      index: {
        repos: [
          {
            repo_id: R.site,
            name: "site",
            commit_sha: SITE_SHA,
            files: [
              {
                path: "src/example.ts",
                line_count: 10,
                symbols: [
                  { name: "run", line: 2 },
                  { name: "run", line: 8 },
                ],
              },
            ],
          },
        ],
      },
    };
    const input = { type: "input", text: "@run", caret: 4 } as const;
    let state = reduceComposer(EMPTY_COMPOSER, input, localEnv);
    state = reduceComposer(state, { type: "pickerSelect" }, localEnv);
    state = reduceComposer(state, input, localEnv);
    state = reduceComposer(state, { type: "pickerMove", delta: 1 }, localEnv);
    state = reduceComposer(state, { type: "pickerSelect" }, localEnv);
    expect(state.chips.map((chip) => chip.reference.line_start)).toEqual([
      2, 8,
    ]);
  });

  test("@ opens the picker, arrows move the selection, Enter attaches the chip and removes the trigger", () => {
    let state = type(EMPTY_COMPOSER, "Look at @ver");
    expect(state.picker?.query).toBe("ver");
    expect(state.picker?.candidates.length).toBeGreaterThan(1);
    expect(keyIntent(state, { key: "ArrowDown", shiftKey: false })).toBe(
      "pickerDown",
    );
    state = reduceComposer(state, { type: "pickerMove", delta: 1 }, env);
    expect(state.picker?.selected).toBe(1);
    const chosen = state.picker?.candidates[1];
    expect(keyIntent(state, { key: "Enter", shiftKey: false })).toBe(
      "pickerSelect",
    );
    state = reduceComposer(state, { type: "pickerSelect" }, env);
    expect(state.picker).toBeNull();
    expect(state.text).toBe("Look at ");
    expect(state.chips.map((c) => c.key)).toEqual([chosen?.key ?? ""]);
  });

  test("selection wraps and survives query refinement when the candidate is still listed", () => {
    let state = type(EMPTY_COMPOSER, "@");
    const n = state.picker?.candidates.length ?? 0;
    state = reduceComposer(state, { type: "pickerMove", delta: -1 }, env);
    expect(state.picker?.selected).toBe(n - 1);
    const kept = state.picker?.candidates[n - 1]?.key;
    state = type(state, "@src");
    expect(state.picker?.candidates[state.picker.selected]?.key).toBe(kept);
  });

  test("Escape closes the picker, an email address does not open it, and duplicates are not added twice", () => {
    let state = type(EMPTY_COMPOSER, "@");
    expect(keyIntent(state, { key: "Escape", shiftKey: false })).toBe(
      "pickerClose",
    );
    state = reduceComposer(state, { type: "pickerClose" }, env);
    expect(state.picker).toBeNull();
    expect(type(EMPTY_COMPOSER, "mail ada@example").picker).toBeNull();
    state = reduceComposer(
      type(EMPTY_COMPOSER, "@how.ts"),
      { type: "pickerSelect" },
      env,
    );
    state = reduceComposer(
      type(state, "@how.ts"),
      { type: "pickerSelect" },
      env,
    );
    expect(state.chips).toHaveLength(1);
    state = reduceComposer(
      state,
      { type: "removeChip", key: state.chips[0]?.key ?? "" },
      env,
    );
    expect(state.chips).toHaveLength(0);
  });

  test("chips are capped at the environment limit", () => {
    const small = { ...env, maxChips: 1 };
    let state = reduceComposer(
      type(EMPTY_COMPOSER, "@how.ts"),
      { type: "pickerSelect" },
      small,
    );
    state = reduceComposer(
      reduceComposer(state, { type: "input", text: "@style", caret: 6 }, small),
      { type: "pickerSelect" },
      small,
    );
    expect(state.chips).toHaveLength(1);
  });

  test("Enter sends, Shift+Enter is a newline, IME composition is ignored", () => {
    const state = type(EMPTY_COMPOSER, "hi");
    expect(keyIntent(state, { key: "Enter", shiftKey: false })).toBe("send");
    expect(keyIntent(state, { key: "Enter", shiftKey: true })).toBe("newline");
    expect(
      keyIntent(state, { key: "Enter", shiftKey: false, isComposing: true }),
    ).toBe("none");
    expect(keyIntent(state, { key: "a", shiftKey: false })).toBe("none");
  });

  test("buildSend carries reply context and chips, and refuses an empty draft", () => {
    expect(buildSend(EMPTY_COMPOSER, "conv", "cm")).toBeNull();
    let state = reduceComposer(
      type(EMPTY_COMPOSER, "see @style.css:14-23"),
      { type: "pickerSelect" },
      env,
    );
    state = reduceComposer(
      state,
      {
        type: "setReply",
        reply: { message_id: "msg_1", author_name: "Ada", excerpt: "x" },
      },
      env,
    );
    expect(buildSend(state, "conv", "cm_1")).toEqual({
      conversation_id: "conv",
      client_message_id: "cm_1",
      body: "see",
      reply_to: "msg_1",
      references: [
        {
          kind: "range",
          repo_id: R.site,
          commit_sha: SITE_SHA,
          path: "src/style.css",
          line_start: 14,
          line_end: 23,
          symbol: null,
        },
      ],
    });
    expect(
      reduceComposer(state, { type: "clearReply" }, env).reply_to,
    ).toBeNull();
    expect(reduceComposer(state, { type: "reset" }, env)).toBe(EMPTY_COMPOSER);
    const chipsOnly = reduceComposer(
      type(EMPTY_COMPOSER, "@how.ts"),
      { type: "pickerSelect" },
      env,
    );
    expect(buildSend(chipsOnly, "conv", "cm")?.body).toBe("");
  });
});

describe("picker announcement", () => {
  test("announces the result count and highlighted candidate on open, nothing on arrow moves, and the no-match state", () => {
    expect(pickerAnnouncement(EMPTY_COMPOSER.picker)).toEqual({
      results: "",
      highlighted: "",
      text: "",
    });
    const open = type(EMPTY_COMPOSER, "@");
    const candidates = open.picker?.candidates ?? [];
    expect(candidates.length).toBeGreaterThan(1);
    const first = pickerAnnouncement(open.picker);
    expect(first.text).toBe(
      `${candidates.length} suggestions, ${candidates[0]?.label} (${candidates[0]?.kind}) highlighted. Use Up and Down arrows to choose, Enter or Tab to attach.`,
    );
    const moved = reduceComposer(open, { type: "pickerMove", delta: 1 }, env);
    expect(pickerAnnouncement(moved.picker).results).toBe(first.results);
    const none = type(EMPTY_COMPOSER, "@zzzz-no-such-thing");
    expect(none.picker?.candidates).toEqual([]);
    const empty = pickerAnnouncement(none.picker);
    expect(empty.text).toBe("No matching file, symbol or range.");
    expect(empty.results).not.toBe("");
    const one = open.picker
      ? { ...open.picker, candidates: candidates.slice(0, 1) }
      : null;
    expect(pickerAnnouncement(one).text).toMatch(/^1 suggestion, /);
  });

  test("a same-count replacement of the results is re-announced and moves the active descendant", () => {
    const open = type(EMPTY_COMPOSER, "@");
    const all = open.picker?.candidates ?? [];
    expect(all.length).toBeGreaterThanOrEqual(4);
    const base = open.picker as NonNullable<typeof open.picker>;
    const before = { ...base, candidates: all.slice(0, 2), selected: 0 };
    const after = { ...base, candidates: all.slice(2, 4), selected: 0 };
    const a = pickerAnnouncement(before);
    const b = pickerAnnouncement(after);
    expect(b.results).not.toBe(a.results);
    expect(b.text).toContain(`${all[2]?.label} (${all[2]?.kind}) highlighted`);
    const [x, y] = [all[0], all[2]] as [
      (typeof all)[number],
      (typeof all)[number],
    ];
    expect(mentionOptionId(0, x)).not.toBe(mentionOptionId(0, y));
    expect(mentionOptionId(0, x)).toBe(mentionOptionId(0, x));
    const ids = all.map((c, i) => mentionOptionId(i, c));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^mention-\d+-[0-9a-z]+$/);
  });
});

describe("picker status updates", () => {
  test("announces new result sets, clears stale highlight text on arrow moves, and stays put otherwise", () => {
    const closed = pickerAnnouncement(null);
    const open = type(EMPTY_COMPOSER, "@ver");
    const opened = pickerAnnouncement(open.picker);
    expect(nextPickerStatus(closed, opened)).toBe(opened.text);
    expect(nextPickerStatus(opened, opened)).toBeNull();
    const moved = pickerAnnouncement(
      reduceComposer(open, { type: "pickerMove", delta: 1 }, env).picker,
    );
    expect(moved.highlighted).not.toBe(opened.highlighted);
    expect(nextPickerStatus(opened, moved)).toBe("");
    expect(nextPickerStatus(moved, moved)).toBeNull();
    const refined = pickerAnnouncement(type(open, "@verd").picker);
    expect(nextPickerStatus(moved, refined)).toBe(refined.text);
    expect(refined.text).toContain("Verdict (symbol) highlighted");
    expect(nextPickerStatus(refined, closed)).toBe("");
  });
});

describe("composer problems", () => {
  test("a text-required send preserves attached chips until there is accompanying text", () => {
    const draft = reduceComposer(
      type(EMPTY_COMPOSER, "@how.ts"),
      { type: "pickerSelect" },
      env,
    );
    expect(draft.chips).toHaveLength(1);
    const requireText = true;
    for (const state of [draft, type(draft, "   ")]) {
      expect(composerProblem(state, requireText)).toBe("text_required");
      expect(buildSend(state, "conv", "cm", requireText)).toBeNull();
    }
    const withText = type(draft, "See this file");
    expect(composerProblem(withText, requireText)).toBeNull();
    expect(buildSend(withText, "conv", "cm", requireText)).toMatchObject({
      body: "See this file",
      references: [draft.chips[0]?.reference],
    });
  });

  test("an overlength body is reported and never built into a send", () => {
    const long = type(EMPTY_COMPOSER, "x".repeat(4001));
    expect(composerProblem(long)).toBe("too_long");
    expect(buildSend(long, "conv", "cm")).toBeNull();
    expect(composerProblem(type(EMPTY_COMPOSER, "x".repeat(4000)))).toBeNull();
    expect(composerProblem(EMPTY_COMPOSER)).toBe("empty");
    expect(composerProblem(type(EMPTY_COMPOSER, "   "))).toBe("empty");
  });
});

describe("@MARS invocations", () => {
  test.each([
    [
      "@MARS, can you summarize the selected transport details?",
      "can you summarize the selected transport details?",
    ],
    [" \t@mArS:summarize this", "summarize this"],
    ["@mars? What changed?", "What changed?"],
    ["@MARS. Summarize the changes.", "Summarize the changes."],
    ["@MARS.Summarize the changes.", "Summarize the changes."],
    ["Please @MARS summarize this", "Please summarize this"],
    ["\n @mArS? ", ""],
    ["@MARS", ""],
    ["@MARS.", ""],
  ])("extracts the prompt from %j", (text, prompt) => {
    expect(parseMarsInvocation(text)).toEqual({ prompt });
  });

  test.each([
    "Email dev@mars.example for details",
    "@MARSHALL, can you summarize?",
    "@MARS_TEAM can you summarize?",
  ])("treats %j as an ordinary message", (text) => {
    expect(parseMarsInvocation(text)).toBeNull();
  });

  test("a complete picker-inserted dotted teammate takes precedence over an agent invocation", () => {
    const teammate = {
      user_id: "mars.ops",
      handle: "mars.ops",
      display_name: "Ops",
    };
    const mentionEnv = {
      ...env,
      index: { repos: [], users: [teammate], agent_available: true },
    };
    const query = "@mars.ops";
    const draft = reduceComposer(
      reduceComposer(
        EMPTY_COMPOSER,
        { type: "input", text: query, caret: query.length },
        mentionEnv,
      ),
      { type: "pickerSelect" },
      mentionEnv,
    );
    expect(draft.text).toBe("@mars.ops ");
    const options = { teammates: [teammate] };
    expect(
      parseMarsInvocation(`${draft.text}review this?`, options),
    ).toBeNull();
    expect(parseMarsInvocation("@MARS.OPS, review this?", options)).toBeNull();
    expect(parseMarsInvocation("@MARS.Summarize this", options)).toEqual({
      prompt: "Summarize this",
    });
  });

  test.each([
    "@mars.svg:1 needs a new icon",
    "@mars.svg:1-4 needs a new icon",
    "@MARS.config.ts:12, see this line",
    "look at @mars.svg:1",
    "is it @mars.svg:1-4?",
    "see @mars.svg:7.",
    "@mars.svg:7,@mars.css:8 both need new icons",
    "@mars.svg:7; @mars.css:8-9. Both need new icons",
    "@mars.svg:1) and the other one",
    "See @mars.svg:7…",
    "@mars.svg:7。",
    "@mars.svg:7！ needs a new icon",
    "is it @mars.svg:1-3？",
  ])("leaves the file-and-line token in %j as ordinary chat", (text) => {
    expect(parseMarsInvocation(text)).toBeNull();
    expect(parseMarsInvocation(text, { leadingOnly: true })).toBeNull();
    expect(parseMarsInvocation("@MARS.Summarize this")).toEqual({
      prompt: "Summarize this",
    });
    expect(parseMarsInvocation("@MARS: 1 question")).toEqual({
      prompt: "1 question",
    });
  });

  test.each([
    ["@MARS.Summarize:2.0 migration risks", "Summarize:2.0 migration risks"],
    ["@MARS.Compare:1-2x speedups", "Compare:1-2x speedups"],
    ["@MARS.Explain:3rd option", "Explain:3rd option"],
    ["@MARS.rate:10/10 ideas", "rate:10/10 ideas"],
    ["@MARS.Summarize:2,3 and 4", "Summarize:2,3 and 4"],
    ["@MARS.check:7-day window", "check:7-day window"],
    ["@MARS.Review:20% discount proposal", "Review:20% discount proposal"],
    ["@MARS.Compare:2× speedup", "Compare:2× speedup"],
    ["@MARS.Sum:2+2 please", "Sum:2+2 please"],
    ["@MARS.Estimate:$5 budget", "Estimate:$5 budget"],
    ['@MARS.Quote:5" screens', 'Quote:5" screens'],
    ["@MARS，总结一下", "总结一下"],
    ["@MARS… what changed?", "what changed?"],
    ["@MARS。Summarize this", "Summarize this"],
    ["@MARS？", ""],
  ])("keeps %j a private agent command", (text, prompt) => {
    expect(parseMarsInvocation(text)).toEqual({ prompt });
    expect(parseMarsInvocation(text, { leadingOnly: true })).toEqual({
      prompt,
    });
  });

  test("the picker never offers a teammate whose handle is a casing of @MARS", () => {
    const users = [
      { user_id: "MARS", handle: "MARS", display_name: "Mars Person" },
      { user_id: "marsha", handle: "marsha", display_name: "Marsha" },
    ];
    for (const agent_available of [false, true]) {
      const picked = mentionCandidates(
        { repos: [], users, agent_available },
        "mars",
        null,
      );
      expect(
        picked.filter((c) => c.kind === "user").map((c) => c.label),
      ).toEqual(["@marsha"]);
      expect(picked.some((c) => c.kind === "agent")).toBe(agent_available);
    }
    // Picking the remaining teammate and sending stays ordinary chat.
    const mentionEnv = { ...env, index: { repos: [], users } };
    const draft = reduceComposer(
      reduceComposer(
        EMPTY_COMPOSER,
        { type: "input", text: "@mars", caret: 5 },
        mentionEnv,
      ),
      { type: "pickerSelect" },
      mentionEnv,
    );
    expect(draft.text).toBe("@marsha ");
    expect(
      parseMarsInvocation(`${draft.text}can you review this?`, {
        teammates: users,
        leadingOnly: true,
      }),
    ).toBeNull();
  });

  test("only leading invocations are reserved when the agent is disabled", () => {
    const options = { leadingOnly: true };
    expect(parseMarsInvocation("Is @MARS enabled here?", options)).toBeNull();
    expect(parseMarsInvocation(" \t@mArS: summarize this", options)).toEqual({
      prompt: "summarize this",
    });
  });
});

describe("dynamic remote path search mentions", () => {
  test("supports remote search results with unknown line_count for both file and range mentions", () => {
    const dynamicEnv = {
      index: {
        repos: [
          {
            repo_id: "repo_live",
            name: "mars",
            commit_sha: "abcdef1234567890abcdef1234567890abcdef12",
            files: [{ path: "src/auth.ts", line_count: 0, symbols: [] }],
          },
        ],
      },
      activeRepoId: "repo_live",
      maxChips: 5,
    };
    const fileCandidates = mentionCandidates(
      dynamicEnv.index,
      "src/auth",
      "repo_live",
    );
    expect(fileCandidates).toHaveLength(1);
    expect(fileCandidates[0]?.kind).toBe("file");
    expect(fileCandidates[0]?.detail).toBe("mars @ abcdef1");

    const rangeCandidates = mentionCandidates(
      dynamicEnv.index,
      "src/auth.ts:10-25",
      "repo_live",
    );
    expect(rangeCandidates).toHaveLength(1);
    expect(rangeCandidates[0]?.kind).toBe("range");
    if (rangeCandidates[0]?.kind === "range") {
      expect(rangeCandidates[0].reference.line_start).toBe(10);
      expect(rangeCandidates[0].reference.line_end).toBe(25);
    }
  });
});
