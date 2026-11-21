import type {
  ConnectionResult,
  LocalConnection,
} from "@mars/contracts/connection-file";
import {
  type BridgeErrorKind,
  bridgeError,
  bridgeFailure,
  isBridgeMethod,
} from "../shared/methods";
import { type Bridge, createBridge } from "./bridge";
import type { RpcTransport } from "./transport";

const RETRYABLE_ERRORS = new Set<BridgeErrorKind>([
  "not_connected",
  "unavailable",
  "unauthorized",
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
        if (!result.ok && RETRYABLE_ERRORS.has(result.error.kind))
          activeBridge = undefined;
        return result;
      } catch {
        activeBridge = undefined;
        return bridgeFailure("unavailable");
      }
    },
  };
}
