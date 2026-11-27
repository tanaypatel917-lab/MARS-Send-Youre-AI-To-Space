import {
  ASSISTANT_CHANNEL,
  ASSISTANT_SETUP_CHANNEL,
  type AssistantApi,
  type AssistantRequest,
  type AssistantResult,
} from "../shared/assistant";
import { WORKBENCH_CHANGED } from "../shared/desktop-model";
import type { SetupSummary } from "../shared/setup";

export function createAssistantPreloadApi(ipc: {
  invoke(channel: string, payload?: AssistantRequest): Promise<unknown>;
  on(channel: string, listener: () => void): void;
}): AssistantApi {
  return Object.freeze({
    onWorkbenchChanged: (refresh: () => void) => {
      ipc.on(WORKBENCH_CHANGED, () => refresh());
    },
    request: (payload: AssistantRequest) =>
      ipc.invoke(ASSISTANT_CHANNEL, payload) as Promise<AssistantResult>,
    setup: () =>
      ipc.invoke(ASSISTANT_SETUP_CHANNEL) as Promise<SetupSummary | undefined>,
  });
}
