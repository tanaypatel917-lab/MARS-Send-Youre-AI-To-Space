import { fail } from "@mars/team-chat";
import {
  ASSISTANT_CHANNEL,
  ASSISTANT_SETUP_CHANNEL,
} from "../shared/assistant";
import { BRIDGE_CHANNEL, bridgeFailure } from "../shared/methods";
import {
  PATCH_HANDOFF_CHANNEL,
  type PatchHandoffResult,
} from "../shared/patch-handoff";
import { TEAM_CHAT_CHANNEL } from "../shared/team-chat";
import type { createAssistant } from "./assistant";
import type { Bridge } from "./bridge";
import { RendererExportParamsSchema } from "./protocol";
import type { TeamChatBridge } from "./team-chat-bridge";

export type IpcEventLike = {
  sender: object;
  senderFrame: { url: string } | null;
};

type SenderPolicy = {
  trustedOrigin: string;
  trustedContents: { readonly mainFrame: { url: string } };
};

export type IpcMainLike = {
  handle(
    channel: string,
    listener: (event: IpcEventLike, payload: unknown) => unknown,
  ): void;
};

function trustedSender(event: IpcEventLike, policy: SenderPolicy): boolean {
  try {
    const frame = event.senderFrame;
    if (
      !frame ||
      event.sender !== policy.trustedContents ||
      frame !== policy.trustedContents.mainFrame
    )
      return false;
    const trusted = new URL(policy.trustedOrigin);
    const sender = new URL(frame.url);
    return (
      sender.protocol === trusted.protocol &&
      sender.host === trusted.host &&
      sender.pathname === "/index.html" &&
      sender.username === "" &&
      sender.password === ""
    );
  } catch {
    return false;
  }
}

export function registerAssistantBridge(
  ipcMain: IpcMainLike,
  assistant: ReturnType<typeof createAssistant>,
  options: SenderPolicy,
): void {
  ipcMain.handle(ASSISTANT_CHANNEL, async (event, payload) => {
    if (!trustedSender(event, options))
      return { ok: false, error: "Chat request refused." };
    try {
      return await assistant.call(payload);
    } catch {
      return { ok: false, error: "Chat is unavailable. Please try again." };
    }
  });
  ipcMain.handle(ASSISTANT_SETUP_CHANNEL, async (event) => {
    if (!trustedSender(event, options)) return undefined;
    try {
      return await assistant.setup();
    } catch {
      return undefined;
    }
  });
}

function requestPayload(
  payload: unknown,
): { method: unknown; params: unknown } | undefined {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.getPrototypeOf(payload) !== Object.prototype
  )
    return undefined;
  const record = payload as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, "method") ||
    !Object.hasOwn(record, "params")
  )
    return undefined;
  return { method: record.method, params: record.params };
}

export function registerBridge(
  ipcMain: IpcMainLike,
  bridge: Bridge,
  options: SenderPolicy,
): void {
  ipcMain.handle(BRIDGE_CHANNEL, async (event, payload) => {
    try {
      if (!trustedSender(event, options)) return bridgeFailure("refused");
      const request = requestPayload(payload);
      if (!request) return bridgeFailure("refused");
      if (request.method === "tasks.export") {
        const parsed = RendererExportParamsSchema.safeParse(request.params);
        if (!parsed.success) return bridgeFailure("protocol");
        return await bridge.call(request.method, parsed.data);
      }
      return await bridge.call(request.method, request.params);
    } catch {
      return bridgeFailure("protocol");
    }
  });
}

export function registerPatchHandoff(
  ipcMain: IpcMainLike,
  save: (payload: unknown) => Promise<PatchHandoffResult>,
  options: SenderPolicy,
): void {
  ipcMain.handle(PATCH_HANDOFF_CHANNEL, async (event, payload) =>
    trustedSender(event, options)
      ? save(payload)
      : { status: "blocked", reason: "Patch handoff request refused." },
  );
}

export function registerTeamChatBridge(
  ipcMain: IpcMainLike,
  teamChat: TeamChatBridge,
  options: SenderPolicy,
): void {
  ipcMain.handle(TEAM_CHAT_CHANNEL, async (event, payload) => {
    try {
      if (!trustedSender(event, options)) return fail("forbidden");
      const request = requestPayload(payload);
      if (!request) return fail("invalid");
      return await teamChat.call(request.method, request.params);
    } catch {
      return fail("unavailable");
    }
  });
}
