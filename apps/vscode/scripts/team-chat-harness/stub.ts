/// <reference lib="dom" />
// Browser-side stand-in for the VS Code webview API: routes webview messages to
// an in-page TeamChatController over the fixture and posts its state back.
// Dev harness only; never bundled into the extension.
import { TeamChatController } from "../../src/teamChat/controller";

const params = new URLSearchParams(window.location.search);
export const scenario = params.get("scenario") ?? "inbox";

let saved: unknown;
export const controller = new TeamChatController({
  post: (state) => window.postMessage({ type: "state", state }, "*"),
  sendDelayMs: scenario === "pending" ? 60_000 : 0,
});

Object.assign(globalThis, {
  acquireVsCodeApi: () => ({
    postMessage: (message: unknown) => {
      void controller.handleMessage(message);
    },
    getState: () => saved,
    setState: (state: unknown) => {
      saved = state;
    },
  }),
});
