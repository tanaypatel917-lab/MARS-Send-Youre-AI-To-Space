/// <reference lib="dom" />
// Browser-side stand-in for the VS Code webview API: routes webview messages to
// an in-page TeamChatController over the fixture and posts its state back.
// Dev harness only; never bundled into the extension.
import { TeamClient } from "../../src/teamChat/client";
import { TeamChatController } from "../../src/teamChat/controller";
import { TeamRealtime } from "../../src/teamChat/realtime";
import { RpcTeamService } from "../../src/teamChat/service";
import { FakeTeamServer } from "../../test/teamFixtures";

const params = new URLSearchParams(window.location.search);
export const scenario = params.get("scenario") ?? "inbox";

let saved: unknown;

/**
 * The "service" scenario drives the real `RpcTeamService` + `TeamRealtime`
 * against an in-page stubbed team server (no network, no token outside this
 * page): the same code path the extension host runs.
 */
function serviceController(): TeamChatController {
  const server = new FakeTeamServer();
  server.seedDm("user_ada", "user_grace", [
    "Hi Ada, the launch key evidence is in the review now.",
    "Thanks! Looking at it this afternoon.",
    "The verdict layout lives host-side; chips stay restricted until refs land.",
  ]);
  server.seedGroup(
    "Release room",
    ["user_ada", "user_grace", "user_linus"],
    [
      "Release checklist is at #4. @MARS can summarize later.",
      "Pinning this one for the week.",
    ],
  );
  const client = new TeamClient(server.transport("user_ada"));
  const service = new RpcTeamService(client);
  let controller: TeamChatController | undefined;
  const realtime = new TeamRealtime({
    client,
    streamUrl: null,
    streamSupported: () => false,
    getToken: () => Promise.resolve("harness-token-not-a-secret"),
    onEvent: (event) =>
      controller?.notifyDelivery(
        event.conversation_id,
        event.kind,
        event.message_seq,
      ),
    onStatus: (state) => controller?.notifyConnection(state),
    onResync: () =>
      controller?.handleMessage({ type: "ready" }).then(() => undefined),
    pollIntervalMs: 200,
  });
  controller = new TeamChatController({
    post: (state) => window.postMessage({ type: "state", state }, "*"),
    service,
    realtime,
    viewer: "service",
    pageSize: 50,
  });
  Object.assign(globalThis, { __teamServer: server });
  return controller;
}

export const controller =
  scenario === "service"
    ? serviceController()
    : new TeamChatController({
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
