import "./preload";
import { contextBridge, ipcRenderer } from "electron";
import {
  type DesktopExtensions,
  EXTENSION_CHANNEL,
} from "../runtime/extension-catalog";

contextBridge.exposeInMainWorld(
  "marsExtensions",
  Object.freeze({
    list: () => ipcRenderer.invoke(EXTENSION_CHANNEL, { action: "list" }),
    install: (id: string) =>
      ipcRenderer.invoke(EXTENSION_CHANNEL, { action: "install", id }),
  } satisfies DesktopExtensions),
);
