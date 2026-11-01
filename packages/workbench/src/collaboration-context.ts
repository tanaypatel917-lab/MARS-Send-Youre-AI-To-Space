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
import type { Approvals } from "./protocol.js";

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

/** Host-side hooks the coordinator's room tools need beyond the capability. */
export interface RoomToolHooks {
  /** Runs after a child is queued, e.g. to tick the child runner promptly. */
  afterDelegate?: () => Promise<void>;
  /** Current revision of the coordinator's own workspace, for result reviews. */
  currentBaseRevision?: () => string | null | Promise<string | null>;
  /** The room's current task revision; reviews must name it explicitly. */
  roomTaskRevision?: () => Promise<number>;
  /** The coordinator's own approvals; omitted child approvals default within them. */
  parentApprovals?: () => Approvals;
}

/** Room listings are paged by the room's page_limit; coordinators see the whole bounded set. */
const MAX_LISTING_PAGES = 32;

async function collectPages<T>(
  fetchPage: (
    cursor: string | null,
  ) => Promise<{ items: T[]; next: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_LISTING_PAGES; page++) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    if (result.next === null) break;
    cursor = result.next;
  }
  return items;
}

function delegationTools(
  agents: Collaboration["agents"],
  context: () => RequestContext,
  frozen: FrozenCollaboration,
  hooks: RoomToolHooks,
): RuntimeDelegation {
  // Read lazily: the host swaps the capability when the task is revised.
  const capability = () => frozen.capability;
  return {
    async delegate(input) {
      // Explicit defaults: read follows the coordinator, write and execute
      // are opt-in, so an ordinary delegation never asks for more than the
      // room authority allows.
      const parent = hooks.parentApprovals?.();
      const approvals = {
        read: input.read ?? parent?.read ?? true,
        write: input.write ?? false,
        execute: input.execute ?? false,
      };
      const view = await agents.delegate(
        context(),
        capability(),
        compact({
          idempotency_key: randomUUID(),
          role_label: input.role_label,
          instruction: input.instruction,
          acceptance_criteria: input.acceptance_criteria,
          solution_space: input.solution_space,
          complexity: input.complexity,
          approvals,
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
      await hooks.afterDelegate?.();
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
      await agents.cancelChild(context(), capability(), childId);
      return "Cancelled child " + childId + ".";
    },
    async children() {
      const children = await collectPages((cursor) =>
        agents
          .children(context(), capability(), cursor ? { cursor } : {})
          .then((page) => ({ items: page.children, next: page.next_cursor })),
      );
      return JSON.stringify(children);
    },
    async results() {
      const results = await collectPages((cursor) =>
        agents
          .results(context(), capability(), cursor ? { cursor } : {})
          .then((page) => ({ items: page.results, next: page.next_cursor })),
      );
      const revision = await hooks.roomTaskRevision?.();
      const header =
        revision === undefined
          ? []
          : [
              "Current task revision: " +
                revision +
                " (reviews must pass expected_task_revision=" +
                revision +
                "; proposals from earlier revisions are stale).",
            ];
      if (results.length === 0)
        return [...header, "No child results."].join("\n\n");
      return [...header, ...results.map(renderUntrustedResult)].join("\n\n");
    },
    async reviewResult(input) {
      const view = await agents.reviewResult(
        context(),
        capability(),
        input.result_id,
        {
          decision: input.decision,
          expected_task_revision: input.expected_task_revision,
          current_base_revision: (await hooks.currentBaseRevision?.()) ?? null,
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
  hooks: RoomToolHooks = {},
): RuntimeCollaboration {
  // Read lazily: the host swaps the capability when the task is revised.
  const capability = () => frozen.capability;
  return {
    ...(frozen.delegation
      ? { delegation: delegationTools(agents, context, frozen, hooks) }
      : {}),
    async send(input) {
      const view = await agents.send(context(), capability(), {
        idempotency_key: randomUUID(),
        ...input,
      });
      return `Sent ${input.kind} ${view.message_id} to ${input.recipients.length} recipient(s).`;
    },
    async inbox(cursor) {
      const page = await agents.inbox(
        context(),
        capability(),
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
        capability(),
        messageIds,
      );
      return `Acknowledged ${acknowledged} message(s).`;
    },
    async members() {
      const page = await agents.members(context(), capability(), {});
      return JSON.stringify(page.members);
    },
  };
}
