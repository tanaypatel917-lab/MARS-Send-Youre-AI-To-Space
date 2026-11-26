import type {
  ConnectionResult,
  LocalConnection,
} from "@mars/contracts/connection-file";
import { WORKBENCH_CHANGED } from "../shared/desktop-model";
import {
  type BridgeErrorKind,
  bridgeError,
  bridgeFailure,
  isBridgeMethod,
} from "../shared/methods";
import { type Bridge, createBridge } from "./bridge";
import type { RpcTransport } from "./transport";

const CONNECTION_INVALIDATING_ERRORS = new Set<BridgeErrorKind>([
  "not_connected",
  "unavailable",
  "unauthorized",
  "timeout",
]);

export function createReconnectingBridge(options: {
  resolve: () => Promise<ConnectionResult>;
  makeTransport: (connection: LocalConnection) => RpcTransport;
}): Bridge {
  let activeBridge: Bridge | undefined;
  const refusalBridge = createBridge({
    connectionError: bridgeError("not_connected"),
  });

  return {
    async call(method, params) {
      if (!isBridgeMethod(method)) return refusalBridge.call(method, params);
      if (!activeBridge) {
        let connection: ConnectionResult;
        try {
          connection = await options.resolve();
        } catch {
          return bridgeFailure("not_connected");
        }
        if (!connection.ok)
          return {
            ok: false,
            error: { kind: "not_connected", message: connection.reason },
          };
        try {
          activeBridge = createBridge({
            transport: options.makeTransport(connection.connection),
            connectionScope: connection.connection.scope,
          });
        } catch {
          return bridgeFailure("unavailable");
        }
      }

      const bridge = activeBridge;
      if (!bridge) return bridgeFailure("unavailable");
      try {
        const result = await bridge.call(method, params);
        if (!result.ok && CONNECTION_INVALIDATING_ERRORS.has(result.error.kind))
          activeBridge = undefined;
        return result;
      } catch {
        activeBridge = undefined;
        return bridgeFailure("unavailable");
      }
    },
  };
}

export type DesktopChange = "project" | "model" | "sandbox";

export function createManagedWorkbenchBridge(options: {
  connect(): Bridge;
  isChanging(): boolean;
  webContents: {
    reload(): void;
    send(channel: string): void;
  };
}) {
  let bridge = options.connect();
  let pendingLaunches = 0;
  return {
    async call(method: unknown, params: unknown) {
      if (method !== "tasks.start" && method !== "tasks.resume")
        return bridge.call(method, params);
      if (options.isChanging()) return bridgeFailure("unavailable");
      pendingLaunches++;
      try {
        return await bridge.call(method, params);
      } finally {
        pendingLaunches--;
      }
    },
    hasPendingLaunch: () => pendingLaunches > 0,
    currentBridge: () => bridge,
    reconnect(kind: DesktopChange) {
      bridge = options.connect();
      if (kind === "project") options.webContents.reload();
      else options.webContents.send(WORKBENCH_CHANGED);
    },
  };
}
