import { fail } from "@mars/team-chat";
import { BRIDGE_CHANNEL, bridgeFailure } from "../shared/methods";
import { TEAM_CHAT_CHANNEL } from "../shared/team-chat";
import type { Bridge } from "./bridge";
import type { TeamChatBridge } from "./team-chat-bridge";

export type IpcEventLike = {
  senderFrame?: { url?: string } | null;
};

export type IpcMainLike = {
  handle(
    channel: string,
    listener: (event: IpcEventLike, payload: unknown) => unknown,
  ): void;
};

function trustedSender(event: IpcEventLike, trustedOrigin: string): boolean {
  try {
    const trusted = new URL(trustedOrigin);
    const sender = new URL(event.senderFrame?.url ?? "");
    return (
      sender.protocol === trusted.protocol &&
      sender.host === trusted.host &&
      sender.username === "" &&
      sender.password === ""
    );
  } catch {
    return false;
  }
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
  options: { trustedOrigin: string },
): void {
  ipcMain.handle(BRIDGE_CHANNEL, async (event, payload) => {
    try {
      if (!trustedSender(event, options.trustedOrigin))
        return bridgeFailure("refused");
      const request = requestPayload(payload);
      if (!request) return bridgeFailure("refused");
      return await bridge.call(request.method, request.params);
    } catch {
      return bridgeFailure("protocol");
    }
  });
}

export function registerTeamChatBridge(
  ipcMain: IpcMainLike,
  teamChat: TeamChatBridge,
  options: { trustedOrigin: string },
): void {
  ipcMain.handle(TEAM_CHAT_CHANNEL, async (event, payload) => {
    try {
      if (!trustedSender(event, options.trustedOrigin))
        return fail("forbidden");
      const request = requestPayload(payload);
      if (!request) return fail("invalid");
      return await teamChat.call(request.method, request.params);
    } catch {
      return fail("unavailable");
    }
  });
}
