import "./preload";
import { contextBridge, ipcRenderer } from "electron";
import {
  type DesktopExtensions,
  EXTENSION_CHANNEL,
  EXTENSIONS_CHANGED,
} from "../runtime/extension-catalog";

contextBridge.exposeInMainWorld(
  "marsExtensions",
  Object.freeze({
    onChanged: (refresh: () => void) => {
      const notify = () => refresh();
      ipcRenderer.on(EXTENSIONS_CHANGED, notify);
      return () => {
        ipcRenderer.removeListener(EXTENSIONS_CHANGED, notify);
      };
    },
    list: () => ipcRenderer.invoke(EXTENSION_CHANNEL, { action: "list" }),
    install: (id: string) =>
      ipcRenderer.invoke(EXTENSION_CHANNEL, { action: "install", id }),
    remove: (id: string) =>
      ipcRenderer.invoke(EXTENSION_CHANNEL, { action: "remove", id }),
  } satisfies DesktopExtensions),
);
