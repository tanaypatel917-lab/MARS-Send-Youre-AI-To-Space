import { type MentionCandidate, mentionCandidates } from "./mentions";
import {
  MAX_MESSAGE_CHARS,
  type ReferenceInput,
  type SendMessageInput,
} from "./schemas";
import type { MentionIndex } from "./service";

/** A reference the composer will attach on send, with its display label. */
export interface ChipDraft {
  key: string;
  label: string;
  repo_name: string;
  reference: ReferenceInput;
}

export interface PickerState {
  /** Index of the `@` that opened the picker. */
  trigger_start: number;
  query: string;
  candidates: MentionCandidate[];
  selected: number;
}

export interface ReplyContext {
  message_id: string;
  author_name: string;
  excerpt: string;
}

export interface ComposerState {
  text: string;
  caret: number;
  reply_to: ReplyContext | null;
  chips: ChipDraft[];
  picker: PickerState | null;
}

export type ComposerAction =
  | { type: "input"; text: string; caret: number }
  | { type: "pickerMove"; delta: 1 | -1 }
  | { type: "pickerSelect" }
  | { type: "pickerClose" }
  | { type: "setReply"; reply: ReplyContext }
  | { type: "clearReply" }
  | { type: "removeChip"; key: string }
  | { type: "reset" };

export interface ComposerEnvironment {
  index: MentionIndex;
  activeRepoId: string | null;
  maxChips: number;
}

export const EMPTY_COMPOSER: ComposerState = {
  text: "",
  caret: 0,
  reply_to: null,
  chips: [],
  picker: null,
};

const TRIGGER = /(?:^|\s)@([^\s@]*)$/;

/** Pure reducer: every keystroke and picker move goes through here. */
export function reduceComposer(
  state: ComposerState,
  action: ComposerAction,
  env: ComposerEnvironment,
): ComposerState {
  switch (action.type) {
    case "input":
      return withPicker(
        { ...state, text: action.text, caret: action.caret },
        env,
      );
    case "pickerMove": {
      if (!state.picker || state.picker.candidates.length === 0) return state;
      const n = state.picker.candidates.length;
      const selected = (state.picker.selected + action.delta + n) % n;
      return { ...state, picker: { ...state.picker, selected } };
    }
    case "pickerSelect": {
      const picker = state.picker;
      const candidate = picker?.candidates[picker.selected];
      if (!picker || !candidate) return state;
      const before = state.text.slice(0, picker.trigger_start);
      const after = state.text.slice(state.caret);
      const text = `${before}${after}`;
      const chips = state.chips.some((c) => c.key === candidate.key)
        ? state.chips
        : state.chips.length >= env.maxChips
          ? state.chips
          : [
              ...state.chips,
              {
                key: candidate.key,
                label: candidate.label,
                repo_name: candidate.repo_name,
                reference: candidate.reference,
              },
            ];
      return { ...state, text, caret: before.length, chips, picker: null };
    }
    case "pickerClose":
      return state.picker ? { ...state, picker: null } : state;
    case "setReply":
      return { ...state, reply_to: action.reply };
    case "clearReply":
      return state.reply_to ? { ...state, reply_to: null } : state;
    case "removeChip":
      return {
        ...state,
        chips: state.chips.filter((c) => c.key !== action.key),
      };
    case "reset":
      return EMPTY_COMPOSER;
  }
}

function withPicker(
  state: ComposerState,
  env: ComposerEnvironment,
): ComposerState {
  const head = state.text.slice(0, state.caret);
  const match = TRIGGER.exec(head);
  if (!match) return { ...state, picker: null };
  const query = match[1] ?? "";
  const trigger_start = state.caret - query.length - 1;
  const candidates = mentionCandidates(env.index, query, env.activeRepoId);
  const previous = state.picker;
  const keep =
    previous && previous.trigger_start === trigger_start
      ? previous.candidates[previous.selected]?.key
      : undefined;
  const selected = Math.max(
    0,
    candidates.findIndex((c) => c.key === keep),
  );
  return { ...state, picker: { trigger_start, query, candidates, selected } };
}

export type KeyIntent =
  | "send"
  | "newline"
  | "pickerUp"
  | "pickerDown"
  | "pickerSelect"
  | "pickerClose"
  | "none";

/** Enter sends, Shift+Enter inserts a newline; the open picker owns arrows, Enter, Tab and Escape. */
export function keyIntent(
  state: ComposerState,
  key: { key: string; shiftKey: boolean; isComposing?: boolean },
): KeyIntent {
  if (key.isComposing) return "none";
  if (state.picker) {
    if (key.key === "ArrowDown") return "pickerDown";
    if (key.key === "ArrowUp") return "pickerUp";
    if (key.key === "Enter" || key.key === "Tab") return "pickerSelect";
    if (key.key === "Escape") return "pickerClose";
  }
  if (key.key === "Enter") return key.shiftKey ? "newline" : "send";
  return "none";
}

export type ComposerProblem = "empty" | "too_long";

/** Why the draft cannot be sent as-is, or null. Checked before the draft is cleared. */
export function composerProblem(state: ComposerState): ComposerProblem | null {
  const body = state.text.trim();
  if (body.length > MAX_MESSAGE_CHARS) return "too_long";
  if (body.length === 0 && state.chips.length === 0) return "empty";
  return null;
}

/** Null when the draft has a problem (see `composerProblem`). */
export function buildSend(
  state: ComposerState,
  conversationId: string,
  clientMessageId: string,
): SendMessageInput | null {
  if (composerProblem(state) !== null) return null;
  const body = state.text.trim();
  return {
    conversation_id: conversationId,
    client_message_id: clientMessageId,
    body,
    reply_to: state.reply_to?.message_id ?? null,
    references: state.chips.map((c) => c.reference),
  };
}
