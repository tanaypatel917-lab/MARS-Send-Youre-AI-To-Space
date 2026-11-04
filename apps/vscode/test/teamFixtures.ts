import type { Message } from "@mars/contracts";
import { RpcError, type RpcRequest } from "../src/rpc";
import type { TeamTransport } from "../src/teamChat/client";
import type {
  TeamContext,
  TeamEvent,
  TeamRpcMethod,
} from "../src/teamChat/protocol";

/**
 * In-memory stand-in for `@mars/team` behind the client's transport
 * interface (pattern: `test/fixtures.ts` `FakeServer`). It speaks the exact
 * RPC envelope and error vocabulary of `packages/team/src/server.ts` for the
 * methods on `main`, plus the expected PR 3 methods (`reactions.set`,
 * `messages.search`) when `capabilities` enables them. Identity comes from
 * the transport the test created, never from request fields.
 */
export const TEAM_ID = "team_fixture";
export const FAKE_TEAM_TOKEN = "fake-team-token-0123456789abcdef";

interface Conversation {
  conversation_id: string;
  team_id: string;
  kind: "dm" | "group";
  title: string | null;
  dm_key: string | null;
  revision: number;
  last_seq: number;
  last_event_seq: number;
}

interface Participant {
  conversation_id: string;
  user_id: string;
  joined_seq: number;
  joined_event_seq: number;
  state: "active" | "removed";
  pinned: boolean;
  read_seq: number;
}

export interface FakeTeamOptions {
  capabilities?: { stream: boolean; reactions: boolean; search: boolean };
}

export class FakeTeamServer {
  readonly calls: RpcRequest<TeamRpcMethod, TeamContext>[] = [];
  readonly conversations = new Map<string, Conversation>();
  readonly participants: Participant[] = [];
  readonly messages: Message[] = [];
  readonly outbox: TeamEvent[] = [];
  readonly reactions: { message_id: string; user_id: string; emoji: string }[] =
    [];
  readonly members = new Set<string>();
  /** Per-viewer chips the PR 4 server would return for a reference id (default: restricted). */
  readonly chips = new Map<
    string,
    {
      reference_id: string;
      restricted: false;
      repo_id: string;
      commit_sha: string;
      path: string;
      line_start: number | null;
      line_end: number | null;
    }
  >();
  readonly capabilities: {
    stream: boolean;
    reactions: boolean;
    search: boolean;
  };
  /** When true, `messages.send` commits but the acknowledgement is lost (transport error). */
  dropNextAck = false;
  /** When true, every call fails as unavailable (server down). */
  offline = false;
  private counter = 0;
  private clock = 0;

  constructor(options: FakeTeamOptions = {}) {
    this.capabilities = options.capabilities ?? {
      stream: false,
      reactions: false,
      search: false,
    };
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${String(this.counter).padStart(4, "0")}`;
  }

  private now(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.clock)).toISOString();
  }

  conversationIds(): string[] {
    return [...this.conversations.keys()];
  }

  seedDm(a: string, b: string, bodies: string[] = []): string {
    const id = this.nextId("conv_dm");
    this.conversations.set(id, {
      conversation_id: id,
      team_id: TEAM_ID,
      kind: "dm",
      title: null,
      dm_key: fakeSha256([a, b].sort().join("\n")),
      revision: 1,
      last_seq: 0,
      last_event_seq: 0,
    });
    for (const user of [a, b]) this.join(id, user);
    bodies.forEach((body, i) => {
      this.post(i % 2 === 0 ? b : a, id, body);
    });
    return id;
  }

  seedGroup(title: string, users: string[], bodies: string[] = []): string {
    const id = this.nextId("conv_grp");
    this.conversations.set(id, {
      conversation_id: id,
      team_id: TEAM_ID,
      kind: "group",
      title,
      dm_key: null,
      revision: 1,
      last_seq: 0,
      last_event_seq: 0,
    });
    for (const user of users) this.join(id, user);
    bodies.forEach((body, i) => {
      this.post(users[i % users.length] ?? users[0] ?? "", id, body);
    });
    return id;
  }

  join(conversationId: string, userId: string): void {
    const conversation = this.must(conversationId);
    this.members.add(userId);
    this.participants.push({
      conversation_id: conversationId,
      user_id: userId,
      joined_seq: conversation.last_seq,
      joined_event_seq: conversation.last_event_seq,
      state: "active",
      pinned: false,
      read_seq: conversation.last_seq,
    });
  }

  /** Removes a member: later reads answer `not_found` like the real store. */
  remove(conversationId: string, userId: string): void {
    const participant = this.participant(conversationId, userId);
    if (participant) participant.state = "removed";
    const conversation = this.must(conversationId);
    conversation.revision += 1;
    this.event(conversation, "membership", null, null);
  }

  /** Server-side post by another member (what a delivery event announces). */
  post(
    author: string,
    conversationId: string,
    body: string,
    options: { client_message_id?: string; reply_to?: string } = {},
  ): Message {
    const conversation = this.must(conversationId);
    conversation.last_seq += 1;
    const message: Message = {
      message_id: this.nextId("msg"),
      conversation_id: conversationId,
      author_id: author,
      seq: conversation.last_seq,
      client_message_id: options.client_message_id ?? this.nextId("cm"),
      body,
      body_sha256: "0".repeat(64),
      reply_to: options.reply_to ?? null,
      reference_ids: [],
      created_at: this.now(),
      edited_at: null,
      deleted: false,
    };
    this.messages.push(message);
    this.event(conversation, "message", message.seq, message.message_id);
    return message;
  }

  private event(
    conversation: Conversation,
    kind: "message" | "membership" | "reaction",
    message_seq: number | null,
    message_id: string | null,
  ): void {
    conversation.last_event_seq += 1;
    this.outbox.push({
      conversation_id: conversation.conversation_id,
      event_seq: conversation.last_event_seq,
      kind,
      message_seq: message_seq ?? 0,
      message_id,
      revision: conversation.revision,
    });
  }

  private must(conversationId: string): Conversation {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error(`fake team: unknown ${conversationId}`);
    return conversation;
  }

  private participant(conversationId: string, userId: string) {
    return this.participants.find(
      (p) => p.conversation_id === conversationId && p.user_id === userId,
    );
  }

  private view(conversationId: string, userId: string) {
    const participant = this.participant(conversationId, userId);
    const conversation = this.conversations.get(conversationId);
    if (!participant || participant.state !== "active" || !conversation)
      throw rpc("not-found", "not_found", 404);
    return {
      participant,
      members: this.participants
        .filter((p) => p.conversation_id === conversationId)
        .map((p) => ({
          user_id: p.user_id,
          state: p.state,
          joined_seq: p.joined_seq,
        })),
    };
  }

  private publicConversation(conversation: Conversation) {
    const { last_event_seq: _ignored, ...rest } = conversation;
    return rest;
  }

  private publicParticipant(participant: Participant) {
    const { joined_event_seq: _ignored, ...rest } = participant;
    return rest;
  }

  private conversationView(conversationId: string, userId: string) {
    const view = this.view(conversationId, userId);
    return {
      conversation: this.publicConversation(this.must(conversationId)),
      participant: this.publicParticipant(view.participant),
      members: view.members,
    };
  }

  /** Transport bound to one authenticated user; `token: null` simulates a missing secret. */
  transport(
    userId: string,
    token: string | null = FAKE_TEAM_TOKEN,
  ): TeamTransport {
    return {
      send: async (request, signal) => {
        if (signal?.aborted) throw rpc("cancelled", undefined, undefined);
        if (!token)
          throw new RpcError("no-token", "No team token is configured.");
        if (token !== FAKE_TEAM_TOKEN)
          throw rpc("unauthorized", "unauthorized", 401);
        this.calls.push(structuredClone(request));
        if (this.offline) throw rpc("disconnected", undefined, undefined);
        if (!this.members.has(userId)) throw rpc("forbidden", "forbidden", 403);
        if (
          request.method !== "team.describe" &&
          request.context?.team_id !== TEAM_ID
        )
          throw rpc("server", "invalid_request", 400);
        return structuredClone(this.dispatch(userId, request));
      },
    };
  }

  private dispatch(
    userId: string,
    request: RpcRequest<TeamRpcMethod, TeamContext>,
  ): unknown {
    const p = request.params;
    switch (request.method) {
      case "team.describe":
        return {
          team_id: TEAM_ID,
          user_id: userId,
          role: "member",
          limits: { page_limit: 200, max_body_bytes: 16384 },
          // `references` is what `main` ships since PR 4 (always present).
          capabilities: { ...this.capabilities, references: false },
        };
      case "conversations.list":
        return [...this.conversations.keys()]
          .filter((id) => this.participant(id, userId)?.state === "active")
          .map((id) => {
            const view = this.conversationView(id, userId);
            if (!this.capabilities.stream) return view;
            // PR 3 service shape: per-participant counters on list items.
            const rows = this.messages.filter(
              (m) =>
                m.conversation_id === id && m.seq > view.participant.joined_seq,
            );
            return {
              ...view,
              unread_count: rows.filter(
                (m) =>
                  m.seq > view.participant.read_seq && m.author_id !== userId,
              ).length,
              last_message_at: rows.at(-1)?.created_at ?? null,
            };
          });
      case "conversations.open":
        return this.conversationView(String(p.conversation_id), userId);
      case "conversations.mark_read": {
        const view = this.view(String(p.conversation_id), userId);
        const seq = Number(p.read_seq);
        if (seq > this.must(view.participant.conversation_id).last_seq)
          throw rpc("server", "invalid_request", 400);
        view.participant.read_seq = Math.max(view.participant.read_seq, seq);
        return this.publicParticipant(view.participant);
      }
      case "conversations.pin": {
        const view = this.view(String(p.conversation_id), userId);
        view.participant.pinned = Boolean(p.pinned);
        return this.publicParticipant(view.participant);
      }
      case "messages.send": {
        const view = this.view(String(p.conversation_id), userId);
        const existing = this.messages.find(
          (m) =>
            m.conversation_id === view.participant.conversation_id &&
            m.author_id === userId &&
            m.client_message_id === p.client_message_id,
        );
        if (existing) {
          if (existing.body !== p.body) throw rpc("conflict", "conflict", 409);
          return existing;
        }
        const message = this.post(
          userId,
          view.participant.conversation_id,
          String(p.body),
          {
            client_message_id: String(p.client_message_id),
            ...(typeof p.reply_to === "string" ? { reply_to: p.reply_to } : {}),
          },
        );
        if (this.dropNextAck) {
          this.dropNextAck = false;
          throw rpc("timeout", undefined, undefined);
        }
        return this.decorate(message, userId, view.participant.joined_seq);
      }
      case "messages.history": {
        const view = this.view(String(p.conversation_id), userId);
        const floor = view.participant.joined_seq;
        const limit = Number(p.limit ?? 50);
        let rows = this.messages
          .filter(
            (m) =>
              m.conversation_id === view.participant.conversation_id &&
              m.seq > floor,
          )
          .sort((a, b) => a.seq - b.seq);
        if (typeof p.after_seq === "number") {
          const after = p.after_seq;
          rows = rows.filter((m) => m.seq > after).slice(0, limit);
        } else {
          const before =
            typeof p.before_seq === "number"
              ? p.before_seq
              : Number.POSITIVE_INFINITY;
          rows = rows.filter((m) => m.seq < before);
          rows = rows.slice(Math.max(0, rows.length - limit));
        }
        return rows.map((m) => this.decorate(m, userId, floor));
      }
      case "events.poll": {
        const cursors = p.cursors as {
          conversation_id: string;
          after_event_seq: number;
        }[];
        const events: TeamEvent[] = [];
        for (const cursor of cursors) {
          const view = this.view(cursor.conversation_id, userId);
          const conversation = this.must(cursor.conversation_id);
          if (cursor.after_event_seq > conversation.last_event_seq)
            throw rpc("server", "invalid_request", 400);
          for (const event of this.outbox)
            if (
              event.conversation_id === cursor.conversation_id &&
              event.event_seq > cursor.after_event_seq &&
              event.event_seq > view.participant.joined_event_seq
            )
              events.push(event);
        }
        return events.slice(0, Number(p.limit ?? 1000));
      }
      case "reactions.set": {
        if (!this.capabilities.reactions)
          throw rpc("server", "invalid_request", 400);
        const message = this.messages.find(
          (m) => m.message_id === p.message_id,
        );
        if (!message) throw rpc("not-found", "not_found", 404);
        const view = this.view(message.conversation_id, userId);
        const index = this.reactions.findIndex(
          (r) =>
            r.message_id === message.message_id &&
            r.user_id === userId &&
            r.emoji === p.emoji,
        );
        const changed = (p.on && index === -1) || (!p.on && index !== -1);
        if (p.on && index === -1)
          this.reactions.push({
            message_id: message.message_id,
            user_id: userId,
            emoji: String(p.emoji),
          });
        if (!p.on && index !== -1) this.reactions.splice(index, 1);
        if (changed)
          this.event(
            this.must(view.participant.conversation_id),
            "reaction",
            message.seq,
            message.message_id,
          );
        const same = this.reactions.filter(
          (r) => r.message_id === message.message_id && r.emoji === p.emoji,
        );
        return {
          message_id: message.message_id,
          emoji: String(p.emoji),
          count: same.length,
          reacted: same.some((r) => r.user_id === userId),
        };
      }
      case "messages.search": {
        if (!this.capabilities.search)
          throw rpc("server", "invalid_request", 400);
        const needle = String(p.query).toLowerCase();
        if (needle.length < 2) throw rpc("server", "invalid_request", 400);
        const hits = this.messages
          .filter((m) => {
            const participant = this.participant(m.conversation_id, userId);
            return (
              participant?.state === "active" &&
              m.seq > participant.joined_seq &&
              (!p.conversation_id || m.conversation_id === p.conversation_id) &&
              m.body.toLowerCase().includes(needle)
            );
          })
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
          .slice(0, Number(p.limit ?? 50))
          .map((m) => ({
            conversation_id: m.conversation_id,
            message_id: m.message_id,
            seq: m.seq,
            author_id: m.author_id,
            created_at: m.created_at,
            excerpt: m.body.slice(0, 200),
            cut_before: false,
            cut_after: m.body.length > 200,
          }));
        return { hits, next_cursor: null };
      }
      default:
        throw rpc("server", "invalid_request", 400);
    }
  }

  /** PR 3 history item shape (reaction summaries + reply excerpt) when the server advertises reactions. */
  private decorate(message: Message, userId: string, floor: number): unknown {
    // `main` (PR 4) always adds per-viewer chips to history/send results.
    const withChips = {
      ...message,
      references: message.reference_ids.map(
        (id) => this.chips.get(id) ?? { reference_id: id, restricted: true },
      ),
    };
    if (!this.capabilities.reactions) return withChips;
    const summaries = new Map<
      string,
      { emoji: string; count: number; reacted: boolean }
    >();
    for (const r of this.reactions)
      if (r.message_id === message.message_id) {
        const entry = summaries.get(r.emoji) ?? {
          emoji: r.emoji,
          count: 0,
          reacted: false,
        };
        entry.count += 1;
        if (r.user_id === userId) entry.reacted = true;
        summaries.set(r.emoji, entry);
      }
    const target = message.reply_to
      ? this.messages.find((m) => m.message_id === message.reply_to)
      : undefined;
    const restricted = target !== undefined && target.seq <= floor;
    return {
      ...withChips,
      reactions: [...summaries.values()].sort((a, b) =>
        a.emoji < b.emoji ? -1 : 1,
      ),
      reply_excerpt: target && !restricted ? target.body.slice(0, 200) : null,
      reply_restricted: restricted,
    };
  }

  /** Builds an SSE body (PR 3 frame layout) for the events after the given cursors; `close` ends it on purpose. */
  sseBody(
    cursors: { conversation_id: string; after_event_seq: number }[],
    close?: "membership" | "not_found" | "unavailable" | "internal_error",
  ): string {
    const frames: string[] = [": connected\n\n"];
    for (const cursor of cursors)
      for (const event of this.outbox)
        if (
          event.conversation_id === cursor.conversation_id &&
          event.event_seq > cursor.after_event_seq
        )
          frames.push(
            `id: ${event.event_seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`,
          );
    if (close)
      frames.push(
        `event: close\ndata: ${JSON.stringify({ reason: close })}\n\n`,
      );
    return frames.join("");
  }
}

/** Browser-safe stand-in for the sha256 dm key (64 hex chars, deterministic); the harness bundles this file. */
function fakeSha256(input: string): string {
  let hex = "";
  for (let i = 0; i < input.length; i++)
    hex += input.charCodeAt(i).toString(16).padStart(2, "0");
  return (hex + "0".repeat(64)).slice(0, 64);
}

function rpc(
  kind: RpcError["kind"],
  code: string | undefined,
  status: number | undefined,
): RpcError {
  return new RpcError(kind, `fake team ${kind}`, code, status);
}
