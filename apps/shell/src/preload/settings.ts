import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_MODEL_CHANNEL,
  type DesktopModelSettings,
} from "../shared/desktop-model";

contextBridge.exposeInMainWorld(
  "marsModelSettings",
  Object.freeze({
    hasKey: () => ipcRenderer.invoke(`${DESKTOP_MODEL_CHANNEL}:has-key`),
    setKey: (key) => ipcRenderer.invoke(DESKTOP_MODEL_CHANNEL, key),
    openKeyPage: () => ipcRenderer.invoke(`${DESKTOP_MODEL_CHANNEL}:key-page`),
  } satisfies DesktopModelSettings),
);
