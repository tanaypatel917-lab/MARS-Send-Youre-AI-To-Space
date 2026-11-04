import { contextBridge, ipcRenderer } from "electron";
import {
  BRIDGE_CHANNEL,
  BRIDGE_GLOBAL,
  READ_METHODS,
  type ReadMethod,
  type ShellBridge,
} from "../shared/methods";

export type Invoke = (channel: string, payload: unknown) => Promise<unknown>;

export function createPreloadApi(invoke: Invoke): ShellBridge {
  const methods = Object.fromEntries(
    READ_METHODS.map((method) => [
      method,
      (params: unknown) => invoke(BRIDGE_CHANNEL, { method, params }),
    ]),
  );
  return Object.freeze(methods) as ShellBridge;
}

contextBridge.exposeInMainWorld(
  BRIDGE_GLOBAL,
  createPreloadApi((channel, payload) => ipcRenderer.invoke(channel, payload)),
);

export type PreloadMethod = ReadMethod;
