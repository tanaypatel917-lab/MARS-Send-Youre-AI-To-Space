import { MARS_AGENT_USER_ID } from "@mars/contracts";
import { z } from "zod";
import { invalidInput, notFound, TeamError } from "./errors";
import type { TeamStore } from "./store";
import { type ConversationRow, idSchema } from "./store-db";
import type { StoreScope } from "./store-scope";

/** Kill switch, metrics and team membership (`team.*`, host-only member admin). */
export function teamOperations(
  scope: StoreScope,
): Pick<
  TeamStore,
  | "isEnabled"
  | "setEnabled"
  | "metricsSnapshot"
  | "setTeamMember"
  | "removeTeamMember"
  | "activeTeamIds"
  | "teamMemberState"
  | "teamMemberRole"
  | "describe"
> {
  const {
    db,
    limits,
    agentOptions,
    timestamp,
    metrics,
    readEnabled,
    memberRow,
    membership,
    requireTeamMember,
    emitEvent,
    saveConversation,
    removeParticipant,
    notify,
    write,
    read,
  } = scope;
  return {
    isEnabled() {
      return readEnabled();
    },
    setEnabled(enabled) {
      if (typeof enabled !== "boolean")
        throw invalidInput("enabled must be boolean");
      return write(() => {
        const before = readEnabled();
        db.query(
          "INSERT INTO meta (key, value) VALUES ('team.enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(enabled ? "1" : "0");
        if (!enabled) notify({ type: "disabled" });
        return { enabled, changed: before !== enabled };
      });
    },
    metricsSnapshot(actor) {
      return read(() => {
        const member = requireTeamMember(actor);
        if (member.role !== "admin")
          throw new TeamError("forbidden", "Team admin role required");
        return metrics.snapshot();
      });
    },
    setTeamMember(input) {
      const parsed = z
        .object({
          team_id: idSchema,
          user_id: idSchema,
          role: z.enum(["admin", "member"]),
        })
        .strict()
        .parse(input);
      if (parsed.user_id === MARS_AGENT_USER_ID)
        throw invalidInput("The agent user id is reserved");
      return write(() => {
        const existing = memberRow(parsed.team_id, parsed.user_id);
        const at = timestamp();
        if (existing)
          db.query(
            "UPDATE members SET role = ?, state = 'active', revision = revision + 1, updated_at = ? WHERE team_id = ? AND user_id = ?",
          ).run(parsed.role, at, parsed.team_id, parsed.user_id);
        else
          db.query(
            "INSERT INTO members (team_id, user_id, role, state, revision, created_at, updated_at) VALUES (?, ?, ?, 'active', 0, ?, ?)",
          ).run(parsed.team_id, parsed.user_id, parsed.role, at, at);
        const row = memberRow(parsed.team_id, parsed.user_id);
        if (!row) throw new TeamError("corrupt_record", "Member row missing");
        return membership(row);
      });
    },
    removeTeamMember(input) {
      const parsed = z
        .object({ team_id: idSchema, user_id: idSchema })
        .strict()
        .parse(input);
      return write(() => {
        const existing = memberRow(parsed.team_id, parsed.user_id);
        if (!existing) throw notFound();
        db.query(
          "UPDATE members SET state = 'removed', revision = revision + 1, updated_at = ? WHERE team_id = ? AND user_id = ?",
        ).run(timestamp(), parsed.team_id, parsed.user_id);
        // Leaving the team leaves every conversation in it.
        const rows = db
          .query<ConversationRow, [string, string]>(
            "SELECT c.* FROM conversations c JOIN participants p ON p.conversation_id = c.conversation_id WHERE c.team_id = ? AND p.user_id = ? AND p.state = 'active'",
          )
          .all(parsed.team_id, parsed.user_id);
        for (const conversation of rows) {
          removeParticipant(conversation.conversation_id, parsed.user_id);
          conversation.revision += 1;
          emitEvent(
            conversation,
            "membership",
            conversation.last_seq,
            null,
            conversation.revision,
          );
          saveConversation(conversation);
        }
        const row = memberRow(parsed.team_id, parsed.user_id);
        if (!row) throw new TeamError("corrupt_record", "Member row missing");
        return membership(row);
      });
    },
    activeTeamIds(user_id) {
      const parsed = idSchema.safeParse(user_id);
      if (!parsed.success) return [];
      return read(() =>
        db
          .query<{ team_id: string }, [string]>(
            "SELECT team_id FROM members WHERE user_id = ? AND state = 'active' ORDER BY team_id ASC",
          )
          .all(parsed.data)
          .map((row) => row.team_id),
      );
    },
    teamMemberState(input) {
      const parsed = z
        .object({ team_id: idSchema, user_id: idSchema })
        .strict()
        .safeParse(input);
      if (!parsed.success) return null;
      return read(() => {
        const row = memberRow(parsed.data.team_id, parsed.data.user_id);
        if (!row) return null;
        return row.state === "active" ? "active" : "removed";
      });
    },
    teamMemberRole(input) {
      const parsed = z
        .object({ team_id: idSchema, user_id: idSchema })
        .strict()
        .safeParse(input);
      if (!parsed.success) return null;
      return read(() => {
        const row = memberRow(parsed.data.team_id, parsed.data.user_id);
        if (!row) return null;
        return row.role === "admin" ? "admin" : "member";
      });
    },
    describe(actor) {
      return read(() => {
        const member = requireTeamMember(actor);
        return {
          team_id: member.team_id,
          user_id: member.user_id,
          role: member.role === "admin" ? "admin" : "member",
          enabled: readEnabled(),
          limits,
          capabilities: {
            stream: true,
            reactions: true,
            search: true,
            references: false,
            agent: agentOptions !== undefined,
          },
        };
      });
    },
  };
}
