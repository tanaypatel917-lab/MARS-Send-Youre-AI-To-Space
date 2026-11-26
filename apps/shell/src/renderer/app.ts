import type { AssistantApi } from "../shared/assistant";
import type { ShellBridge } from "../shared/methods";
import type { PatchHandoffApi } from "../shared/patch-handoff";
import type { TeamChatBridgeApi } from "../shared/team-chat";
import { createController } from "./controller";
import type { ShellDocument, ShellElement } from "./dom";
import type { ExtensionsApi } from "./extensions-view";

type ShellGlobal = typeof globalThis & {
  marsWorkbench?: ShellBridge;
  marsTeamChat?: TeamChatBridgeApi;
  marsAssistant?: AssistantApi;
  marsExtensions?: ExtensionsApi;
  marsPatchHandoff?: PatchHandoffApi;
  document?: ShellDocument;
  addEventListener(
    type: "pagehide",
    listener: () => void,
    options: { once: boolean },
  ): void;
};

const shell = globalThis as ShellGlobal;
const root = shell.document?.getElementById("app") as
  | ShellElement
  | null
  | undefined;
if (shell.marsWorkbench && shell.document && root) {
  const controller = createController(
    shell.marsWorkbench,
    shell.document,
    root,
    shell.marsTeamChat,
    shell.marsAssistant,
    shell.marsExtensions,
    (tick, delay) => {
      const timer = setTimeout(tick, delay);
      return () => clearTimeout(timer);
    },
    shell.marsPatchHandoff,
  );
  shell.addEventListener("pagehide", controller.dispose, { once: true });
  shell.marsAssistant?.onModelChanged?.(() => void controller.load());
  void controller.load();
}
