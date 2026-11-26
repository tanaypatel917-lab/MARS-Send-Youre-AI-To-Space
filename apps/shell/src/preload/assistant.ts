import {
  ASSISTANT_CHANNEL,
  type AssistantApi,
  type AssistantRequest,
  type AssistantResult,
} from "../shared/assistant";
import { WORKBENCH_CHANGED } from "../shared/desktop-model";

export function createAssistantPreloadApi(ipc: {
  invoke(channel: string, payload: AssistantRequest): Promise<AssistantResult>;
  on(channel: string, listener: () => void): void;
}): AssistantApi {
  return Object.freeze({
    onWorkbenchChanged: (refresh: () => void) => {
      ipc.on(WORKBENCH_CHANGED, () => refresh());
    },
    request: (payload: AssistantRequest) =>
      ipc.invoke(ASSISTANT_CHANNEL, payload),
  });
}
