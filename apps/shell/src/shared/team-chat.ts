import type {
  ConversationPage,
  ConversationSummary,
  MentionIndex,
  ReactionEmoji,
  ReactionView,
  ReferencePreview,
  SearchResult,
  SendMessageInput,
  SendResult,
  TeamCapabilities,
  TeamResult,
  TeamServiceLabel,
  UserView,
} from "@mars/team-chat";

export const TEAM_CHAT_METHODS = [
  "team.state",
  "team.open",
  "team.send",
  "team.markRead",
  "team.setPinned",
  "team.setReaction",
  "team.resolveReference",
  "team.search",
  "team.switchViewer",
] as const;

export type TeamChatMethod = (typeof TEAM_CHAT_METHODS)[number];

const TEAM_CHAT_METHOD_SET: ReadonlySet<string> = new Set(TEAM_CHAT_METHODS);

export function isTeamChatMethod(value: unknown): value is TeamChatMethod {
  return typeof value === "string" && TEAM_CHAT_METHOD_SET.has(value);
}

export const TEAM_CHAT_CHANNEL = "mars-shell:team-chat";
export const TEAM_CHAT_GLOBAL = "marsTeamChat";

export type TeamChatBootstrapState = {
  label: TeamServiceLabel;
  capabilities: TeamCapabilities;
  viewer: string;
  users: UserView[];
  conversations: ConversationSummary[];
  mention_index: MentionIndex;
};

export type TeamChatParams = {
  "team.state": Record<string, never>;
  "team.open": {
    conversation_id: string;
    before?: string | null;
    limit?: number;
  };
  "team.send": { input: SendMessageInput };
  "team.markRead": { conversation_id: string; sequence: number };
  "team.setPinned": { conversation_id: string; pinned: boolean };
  "team.setReaction": {
    message_id: string;
    emoji: ReactionEmoji;
    on: boolean;
  };
  "team.resolveReference": { message_id: string; reference_id: string };
  "team.search": { query: string; conversation_id?: string | null };
  "team.switchViewer": { viewer: string };
};

export type TeamChatResults = {
  "team.state": TeamChatBootstrapState;
  "team.open": ConversationPage;
  "team.send": SendResult;
  "team.markRead": { read_cursor: number };
  "team.setPinned": { pinned: boolean };
  "team.setReaction": { reactions: ReactionView[] };
  "team.resolveReference": ReferencePreview;
  "team.search": SearchResult;
  "team.switchViewer": TeamChatBootstrapState;
};

export type TeamChatBridgeApi = {
  readonly [M in TeamChatMethod]: (
    params: TeamChatParams[M],
  ) => Promise<TeamResult<TeamChatResults[M]>>;
};
