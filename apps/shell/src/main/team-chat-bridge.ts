import {
  FixtureTeamService,
  fail,
  ReactionEmojiSchema,
  SendMessageInputSchema,
  type TeamResult,
  type TeamService,
} from "@mars/team-chat";
import { z } from "zod";
import {
  isTeamChatMethod,
  type TeamChatBootstrapState,
  type TeamChatMethod,
} from "../shared/team-chat";

const idString = z.string().min(1).max(256);

const TeamChatParamSchemas = {
  "team.state": z.object({}).strict(),
  "team.open": z
    .object({
      conversation_id: idString,
      before: z.string().min(1).max(256).nullable().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  "team.send": z
    .object({
      input: SendMessageInputSchema,
    })
    .strict(),
  "team.markRead": z
    .object({
      conversation_id: idString,
      sequence: z.number().int().min(0),
    })
    .strict(),
  "team.setPinned": z
    .object({
      conversation_id: idString,
      pinned: z.boolean(),
    })
    .strict(),
  "team.setReaction": z
    .object({
      message_id: idString,
      emoji: ReactionEmojiSchema,
      on: z.boolean(),
    })
    .strict(),
  "team.resolveReference": z
    .object({
      message_id: idString,
      reference_id: idString,
    })
    .strict(),
  "team.search": z
    .object({
      query: z.string().max(512),
      conversation_id: idString.nullable().optional(),
    })
    .strict(),
  "team.switchViewer": z
    .object({
      viewer: idString,
    })
    .strict(),
} satisfies Record<TeamChatMethod, z.ZodTypeAny>;

export interface TeamChatBridge {
  call(method: unknown, params: unknown): Promise<TeamResult<unknown>>;
}

export interface TeamChatBridgeOptions {
  service?: TeamService;
  viewer?: string;
}

export function createTeamChatBridge(
  options: TeamChatBridgeOptions = {},
): TeamChatBridge {
  const service: TeamService = options.service ?? new FixtureTeamService();
  const label = service.label;
  const capabilities = service.capabilities;
  const initialUsers = service.users();
  let viewer =
    service.currentUser?.() ??
    options.viewer ??
    initialUsers[0]?.user_id ??
    "user-maya";

  const bootstrap = async (): Promise<TeamResult<TeamChatBootstrapState>> => {
    const listed = await service.listConversations(viewer);
    if (!listed.ok) return listed;
    return {
      ok: true,
      value: {
        label,
        capabilities,
        viewer,
        users: service.users(),
        conversations: listed.value,
        mention_index: service.mentionIndex(viewer),
      },
    };
  };

  return {
    async call(method, params): Promise<TeamResult<unknown>> {
      if (!isTeamChatMethod(method)) return fail("forbidden");
      if (service.disabled?.()) return fail("unavailable");

      const parsed = TeamChatParamSchemas[method].safeParse(params ?? {});
      if (!parsed.success) return fail("invalid");

      try {
        switch (method) {
          case "team.state":
            return await bootstrap();
          case "team.open": {
            const p = parsed.data as z.infer<
              (typeof TeamChatParamSchemas)["team.open"]
            >;
            const openOpts: { before?: string | null; limit?: number } = {};
            if (p.before !== undefined) openOpts.before = p.before;
            if (p.limit !== undefined) openOpts.limit = p.limit;
            return await service.openConversation(
              viewer,
              p.conversation_id,
              openOpts,
            );
          }
          case "team.send": {
            const p = parsed.data as z.infer<
              (typeof TeamChatParamSchemas)["team.send"]
            >;
            return await service.sendMessage(viewer, p.input);
          }
          case "team.markRead": {
            const p = parsed.data as z.infer<
              (typeof TeamChatParamSchemas)["team.markRead"]
            >;
            return await service.markRead(
              viewer,
              p.conversation_id,
              p.sequence,
            );
          }
          case "team.setPinned": {
            const p = parsed.data as z.infer<
              (typeof TeamChatParamSchemas)["team.setPinned"]
            >;
            return await service.setPinned(viewer, p.conversation_id, p.pinned);
          }
          case "team.setReaction": {
            const p = parsed.data as z.infer<
              (typeof TeamChatParamSchemas)["team.setReaction"]
            >;
            return await service.setReaction(
              viewer,
              p.message_id,
              p.emoji,
              p.on,
            );
          }
          case "team.resolveReference": {
            const p = parsed.data as z.infer<
              (typeof TeamChatParamSchemas)["team.resolveReference"]
            >;
            return await service.resolveReference(
              viewer,
              p.message_id,
              p.reference_id,
            );
          }
          case "team.search": {
            const p = parsed.data as z.infer<
              (typeof TeamChatParamSchemas)["team.search"]
            >;
            return await service.searchMessages(
              viewer,
              p.query,
              p.conversation_id,
            );
          }
          case "team.switchViewer": {
            if (service.currentUser !== undefined) return fail("forbidden");
            const p = parsed.data as z.infer<
              (typeof TeamChatParamSchemas)["team.switchViewer"]
            >;
            const validUser = service
              .users()
              .some((user) => user.user_id === p.viewer);
            if (!validUser) return fail("not_found");
            viewer = p.viewer;
            return await bootstrap();
          }
        }
      } catch {
        return fail("unavailable");
      }
    },
  };
}
