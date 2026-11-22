import { contextBridge, ipcRenderer } from "electron";
import { ASSISTANT_CHANNEL, type AssistantApi } from "../shared/assistant";
import { MODEL_CHANGED } from "../shared/desktop-model";
import {
  BRIDGE_CHANNEL,
  BRIDGE_GLOBAL,
  BRIDGE_METHODS,
  type ShellBridge,
} from "../shared/methods";
import {
  TEAM_CHAT_CHANNEL,
  TEAM_CHAT_GLOBAL,
  TEAM_CHAT_METHODS,
  type TeamChatBridgeApi,
} from "../shared/team-chat";

export type Invoke = (channel: string, payload: unknown) => Promise<unknown>;

export function createPreloadApi(invoke: Invoke): ShellBridge {
  const methods = Object.fromEntries(
    BRIDGE_METHODS.map((method) => [
      method,
      (params: unknown) => invoke(BRIDGE_CHANNEL, { method, params }),
    ]),
  );
  return Object.freeze(methods) as ShellBridge;
}

export function createTeamChatPreloadApi(invoke: Invoke): TeamChatBridgeApi {
  const methods = Object.fromEntries(
    TEAM_CHAT_METHODS.map((method) => [
      method,
      (params: unknown) => invoke(TEAM_CHAT_CHANNEL, { method, params }),
    ]),
  );
  return Object.freeze(methods) as TeamChatBridgeApi;
}

if (typeof contextBridge?.exposeInMainWorld === "function") {
  const invoke: Invoke = (channel, payload) =>
    ipcRenderer.invoke(channel, payload);
  contextBridge.exposeInMainWorld(BRIDGE_GLOBAL, createPreloadApi(invoke));
  contextBridge.exposeInMainWorld(
    "marsAssistant",
    Object.freeze({
      onModelChanged: (refresh: () => void) => {
        ipcRenderer.on(MODEL_CHANGED, () => refresh());
      },
      request: (payload: Parameters<AssistantApi["request"]>[0]) =>
        invoke(ASSISTANT_CHANNEL, payload),
    }),
  );
  contextBridge.exposeInMainWorld(
    TEAM_CHAT_GLOBAL,
    createTeamChatPreloadApi(invoke),
  );
}
