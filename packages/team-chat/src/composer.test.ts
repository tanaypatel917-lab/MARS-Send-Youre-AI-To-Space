import { describe, expect, test } from "bun:test";
import {
  buildSend,
  type ComposerEnvironment,
  type ComposerState,
  composerProblem,
  EMPTY_COMPOSER,
  keyIntent,
  reduceComposer,
} from "./composer";
import { FIXTURE_REPOS as R, SITE_SHA, FIXTURE_USERS as U } from "./fixture";
import { chipLabel, mentionCandidates } from "./mentions";
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
    expect(candidates.map((c) => c.repo_id)).toEqual([
      R.platform,
      R.platform,
      R.site,
      R.site,
    ]);
  });

  test("a path query matches files across both repos and a symbol query matches symbols", () => {
    const files = mentionCandidates(index, "src/", null);
    expect(new Set(files.map((c) => c.repo_id))).toEqual(
      new Set([R.platform, R.site]),
    );
    const symbols = mentionCandidates(index, "banner", R.site);
    expect(symbols.map((c) => `${c.kind}:${c.label}`)).toEqual([
      "symbol:bannerHeight",
      "symbol:--banner-height",
      "symbol:.banner",
      "symbol:.banner .verdict",
    ]);
    expect(symbols[1]?.reference).toMatchObject({
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
    if (!range) throw new Error("no candidate");
    expect(chipLabel(range.reference, range.repo_name)).toBe(
      "mars-site (fixture) · src/style.css:14-23 @ a1b2c3d",
    );
  });
});

describe("composer reducer", () => {
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

describe("composer problems", () => {
  test("an overlength body is reported and never built into a send", () => {
    const long = type(EMPTY_COMPOSER, "x".repeat(4001));
    expect(composerProblem(long)).toBe("too_long");
    expect(buildSend(long, "conv", "cm")).toBeNull();
    expect(composerProblem(type(EMPTY_COMPOSER, "x".repeat(4000)))).toBeNull();
    expect(composerProblem(EMPTY_COMPOSER)).toBe("empty");
    expect(composerProblem(type(EMPTY_COMPOSER, "   "))).toBe("empty");
  });
});
