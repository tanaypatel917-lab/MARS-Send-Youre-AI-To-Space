import { randomUUID } from "node:crypto";
import type { Collaboration } from "@mars/collaboration";
import {
  AgentCapabilitySchema,
  renderUntrustedMessage,
} from "@mars/collaboration";
import type { RequestContext } from "@mars/contracts";
import { BudgetSchema } from "@mars/contracts";
import type { RuntimeCollaboration } from "@mars/execution";
import { z } from "zod";

/** Room binding persisted in private launch metadata so resume reuses it. */
export const FrozenCollaborationSchema = z
  .object({
    room_id: z.string().min(1),
    capability: AgentCapabilitySchema,
    budget: BudgetSchema,
  })
  .strict();
export type FrozenCollaboration = z.infer<typeof FrozenCollaborationSchema>;

export type WorkbenchCollaboration = Pick<Collaboration, "host" | "agents">;

/**
 * Binds the coordinator's room tools to its capability host-side. The model
 * sees rendered, untrusted text only; it never sees the capability token.
 */
export function collaborationTools(
  agents: Collaboration["agents"],
  context: () => RequestContext,
  frozen: FrozenCollaboration,
): RuntimeCollaboration {
  const capability = frozen.capability;
  return {
    async send(input) {
      const view = await agents.send(context(), capability, {
        idempotency_key: randomUUID(),
        ...input,
      });
      return `Sent ${input.kind} ${view.message_id} to ${input.recipients.length} recipient(s).`;
    },
    async inbox(cursor) {
      const page = await agents.inbox(
        context(),
        capability,
        cursor ? { cursor } : {},
      );
      if (page.messages.length === 0) return "No new messages.";
      return [
        ...page.messages.map(renderUntrustedMessage),
        page.next_cursor
          ? `More messages: pass cursor ${page.next_cursor}.`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    },
    async ack(messageIds) {
      const { acknowledged } = await agents.ack(
        context(),
        capability,
        messageIds,
      );
      return `Acknowledged ${acknowledged} message(s).`;
    },
    async members() {
      const page = await agents.members(context(), capability, {});
      return JSON.stringify(page.members);
    },
  };
}
