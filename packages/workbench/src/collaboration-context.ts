import { randomUUID } from "node:crypto";
import type {
  ChildRuntimeAdapter,
  Collaboration,
  createOhMyPiChildAdapter,
  OpenRoomInput,
  ResultView,
} from "@mars/collaboration";
import {
  AgentCapabilitySchema,
  renderUntrustedMessage,
} from "@mars/collaboration";
import type { RequestContext } from "@mars/contracts";
import { BudgetSchema } from "@mars/contracts";
import type { RuntimeCollaboration, RuntimeDelegation } from "@mars/execution";
import { z } from "zod";

/** Room binding persisted in private launch metadata so resume reuses it. */
export const FrozenCollaborationSchema = z
  .object({
    room_id: z.string().min(1),
    capability: AgentCapabilitySchema,
    budget: BudgetSchema,
    delegation: z.boolean().default(false),
  })
  .strict();
export type FrozenCollaboration = z.infer<typeof FrozenCollaborationSchema>;

export type ChildWorkspaceBinder = Parameters<
  typeof createOhMyPiChildAdapter
>[0]["workspaceFor"];

/**
 * Enables delegation for every room the host opens. Children run under the
 * host's own child runner; the workbench never grants a child wider approvals
 * than the launch itself, never pays for child models, and lets children
 * delegate no further.
 */
export interface WorkbenchDelegation {
  pool: NonNullable<OpenRoomInput["delegation_pool"]>;
  limits?: OpenRoomInput["limits"];
  /** Replaces the Oh My Pi child adapter; receives the host's workspace binder. */
  adapter?: (host: {
    workspaceFor: ChildWorkspaceBinder;
  }) => ChildRuntimeAdapter;
  tickMs?: number;
}

export type WorkbenchCollaboration = Pick<Collaboration, "host" | "agents"> & {
  delegation?: WorkbenchDelegation;
};

/** Renders a child result as clearly untrusted evidence. */
export function renderUntrustedResult(result: ResultView): string {
  const header = [
    "[untrusted child result " + result.result_id,
    "from " + result.child_agent_id,
    "status=" + result.status,
    "outcome=" + result.outcome,
    "task_revision=" + result.source_task_revision,
    "base_revision=" + (result.base_revision ?? "none"),
    "artifacts=" + result.artifacts.length,
    result.unsafe_artifacts > 0
      ? "dropped_artifacts=" + result.unsafe_artifacts
      : "",
    result.summary_truncated ? "truncated" : "",
    result.unsafe_summary ? "summary_redacted" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return [
    header + "]",
    "--- untrusted summary begin ---",
    result.summary,
    "--- untrusted summary end ---",
  ].join("\n");
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function delegationTools(
  agents: Collaboration["agents"],
  context: () => RequestContext,
  frozen: FrozenCollaboration,
  afterDelegate: () => Promise<void>,
): RuntimeDelegation {
  const capability = frozen.capability;
  return {
    async delegate(input) {
      const approvals = compact({
        read: input.read,
        write: input.write,
        execute: input.execute,
      });
      const view = await agents.delegate(
        context(),
        capability,
        compact({
          idempotency_key: randomUUID(),
          role_label: input.role_label,
          instruction: input.instruction,
          acceptance_criteria: input.acceptance_criteria,
          solution_space: input.solution_space,
          complexity: input.complexity,
          approvals: Object.keys(approvals).length > 0 ? approvals : undefined,
          paid_models: false,
          may_delegate: false,
          budget: {
            max_tokens: input.max_tokens,
            max_duration_ms: input.max_duration_ms,
            max_steps: input.max_steps,
            max_messages: input.max_messages,
          },
          workspace: input.workspace,
          write_paths: input.write_paths,
        }),
      );
      await afterDelegate();
      return (
        "Delegated " +
        view.role_label +
        " as " +
        view.agent_id +
        " (" +
        view.state +
        ", depth " +
        view.depth +
        ")."
      );
    },
    async cancelChild(childId) {
      await agents.cancelChild(context(), capability, childId);
      return "Cancelled child " + childId + ".";
    },
    async children() {
      const page = await agents.children(context(), capability, {});
      return JSON.stringify(page.children);
    },
    async results() {
      const page = await agents.results(context(), capability, {});
      if (page.results.length === 0) return "No child results.";
      return page.results.map(renderUntrustedResult).join("\n\n");
    },
    async reviewResult(input) {
      const view = await agents.reviewResult(
        context(),
        capability,
        input.result_id,
        {
          decision: input.decision,
          expected_task_revision: input.expected_task_revision,
        },
      );
      return JSON.stringify({ result_id: view.result_id, status: view.status });
    },
  };
}

/**
 * Binds the coordinator's room tools to its capability host-side. The model
 * sees rendered, untrusted text only; it never sees the capability token.
 */
export function collaborationTools(
  agents: Collaboration["agents"],
  context: () => RequestContext,
  frozen: FrozenCollaboration,
  afterDelegate: () => Promise<void> = async () => undefined,
): RuntimeCollaboration {
  const capability = frozen.capability;
  return {
    ...(frozen.delegation
      ? { delegation: delegationTools(agents, context, frozen, afterDelegate) }
      : {}),
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
