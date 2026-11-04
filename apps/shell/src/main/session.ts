import type {
  BridgeErrorKind,
  BridgeResult,
  ReadMethod,
} from "../shared/methods";
import { READ_METHODS } from "../shared/methods";
import { type Bridge, createBridge } from "./bridge";
import type { ConnectionResult, LocalConnection } from "./connection";
import type { RpcTransport } from "./transport";

const RETRYABLE_ERRORS = new Set<BridgeErrorKind>([
  "not_connected",
  "unavailable",
  "unauthorized",
]);

const unavailable = (): BridgeResult<unknown> => ({
  ok: false,
  error: { kind: "unavailable", message: "Workbench is unavailable." },
});

function isReadMethod(value: unknown): value is ReadMethod {
  return (
    typeof value === "string" && READ_METHODS.includes(value as ReadMethod)
  );
}

export function createReconnectingBridge(options: {
  resolve: () => Promise<ConnectionResult>;
  makeTransport: (connection: LocalConnection) => RpcTransport;
}): Bridge {
  let activeBridge: Bridge | undefined;
  const refusalBridge = createBridge({
    connectionError: {
      kind: "not_connected",
      message: "Workbench is unavailable.",
    },
  });

  return {
    async call(method, params) {
      if (!isReadMethod(method)) return refusalBridge.call(method, params);
      if (!activeBridge) {
        let connection: ConnectionResult;
        try {
          connection = await options.resolve();
        } catch {
          return {
            ok: false,
            error: {
              kind: "not_connected",
              message: "Workbench is unavailable.",
            },
          };
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
          return unavailable();
        }
      }

      const bridge = activeBridge;
      if (!bridge) return unavailable();
      try {
        const result = await bridge.call(method, params);
        if (!result.ok && RETRYABLE_ERRORS.has(result.error.kind))
          activeBridge = undefined;
        return result;
      } catch {
        activeBridge = undefined;
        return unavailable();
      }
    },
  };
}
