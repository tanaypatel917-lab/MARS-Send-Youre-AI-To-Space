import type { ShellBridge } from "../shared/methods";
import type { TeamChatBridgeApi } from "../shared/team-chat";
import { createController } from "./controller";
import type { ShellDocument, ShellElement } from "./dom";

type ShellGlobal = typeof globalThis & {
  marsWorkbench?: ShellBridge;
  marsTeamChat?: TeamChatBridgeApi;
  document?: ShellDocument;
};

const shell = globalThis as ShellGlobal;
const root = shell.document?.getElementById("app") as
  | ShellElement
  | null
  | undefined;
if (shell.marsWorkbench && shell.document && root) {
  void createController(
    shell.marsWorkbench,
    shell.document,
    root,
    shell.marsTeamChat,
  ).load();
}
