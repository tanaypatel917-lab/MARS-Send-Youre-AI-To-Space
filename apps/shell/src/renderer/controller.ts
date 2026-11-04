import type { EventEnvelope } from "@mars/contracts";
import type { BridgeResult, ShellBridge } from "../shared/methods";
import type { ShellDocument, ShellElement } from "./dom";
import { verifyArtifact } from "./verify";
import { type ArtifactView, renderShell, type ShellState } from "./view";

const TEXT_MEDIA_TYPES = new Set(["application/json", "application/x-ndjson"]);
const MAX_RENDERED_ARTIFACT_BYTES = 256 * 1024;
const EVENT_PAGE_SIZE = 100;
const MAX_TASK_EVENTS = 1000;

type OptionalValue<T> = { ok: true; value: T } | { ok: false; error: string };

function textLike(mediaType: string): boolean {
  return mediaType.startsWith("text/") || TEXT_MEDIA_TYPES.has(mediaType);
}

export function createController(
  bridge: ShellBridge,
  doc: ShellDocument,
  root: ShellElement,
) {
  let selectedId: string | undefined;
  let loadRequested = false;
  let loadPromise: Promise<void> | undefined;
  let state: ShellState = { tasks: [], events: [], artifacts: [] };

  const render = () => root.replaceChildren(renderShell(doc, state));
  const displayError = (message: string) => {
    state = {
      tasks: [],
      events: [],
      artifacts: [],
      error: message,
      onRefresh: () => void load(),
    };
    render();
  };
  const value = async <T>(pending: Promise<BridgeResult<T>>): Promise<T> => {
    const result = await pending;
    if (!result.ok) throw new Error(result.error.message);
    return result.result;
  };
  const optionalValue = async <T>(
    operation: () => Promise<T>,
  ): Promise<OptionalValue<T>> => {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "Workbench is unavailable.",
      };
    }
  };
  const loadEvents = async (taskId: string): Promise<EventEnvelope[]> => {
    const events: EventEnvelope[] = [];
    let afterEventId: string | undefined;
    while (events.length < MAX_TASK_EVENTS) {
      const params = afterEventId
        ? { task_id: taskId, after_event_id: afterEventId }
        : { task_id: taskId };
      const page = await value(bridge["tasks.events"](params));
      events.push(...page.slice(0, MAX_TASK_EVENTS - events.length));
      if (page.length < EVENT_PAGE_SIZE) break;
      afterEventId = page.at(-1)?.event_id;
      if (!afterEventId) break;
    }
    return events;
  };

  const loadOnce = async () => {
    try {
      const described = await value(bridge["workbench.describe"]({}));
      const tasks = await value(bridge["tasks.list"]({}));
      const selected =
        tasks.find((task) => task.task_id === selectedId) ?? tasks[0];
      selectedId = selected?.task_id;
      if (!selected) {
        state = {
          describe: described,
          tasks,
          events: [],
          artifacts: [],
          onRefresh: () => void load(),
        };
        render();
        return;
      }
      const inspected = await value(
        bridge["tasks.inspect"]({ task_id: selected.task_id }),
      );
      const [verification, diff, evidence, events] = await Promise.all([
        optionalValue(() =>
          value(bridge["tasks.verification"]({ task_id: selected.task_id })),
        ),
        optionalValue(() =>
          value(bridge["tasks.diff"]({ task_id: selected.task_id })),
        ),
        optionalValue(() =>
          value(bridge["tasks.evidence"]({ task_id: selected.task_id })),
        ),
        optionalValue(() => loadEvents(selected.task_id)),
      ]);
      const artifacts: ArtifactView[] = [];
      for (const ref of inspected.artifacts) {
        if (
          !textLike(ref.media_type) ||
          ref.byte_length > MAX_RENDERED_ARTIFACT_BYTES
        ) {
          artifacts.push({ ref, status: "not rendered" });
          continue;
        }
        let fetched: Awaited<ReturnType<ShellBridge["tasks.artifact"]>>;
        try {
          fetched = await bridge["tasks.artifact"]({
            task_id: inspected.task_id,
            artifact: ref,
          });
        } catch {
          artifacts.push({ ref, status: "not rendered" });
          continue;
        }
        if (!fetched.ok) {
          artifacts.push({
            ref,
            status:
              fetched.error.kind === "hash_mismatch"
                ? "rejected"
                : "not rendered",
          });
          continue;
        }
        if (
          !(await verifyArtifact(ref, fetched.result, globalThis.crypto.subtle))
        ) {
          artifacts.push({ ref, status: "rejected" });
          continue;
        }
        const bytes = Uint8Array.from(
          atob(fetched.result.data_base64),
          (character) => character.charCodeAt(0),
        );
        try {
          artifacts.push({
            ref,
            status: "verified",
            content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          });
        } catch {
          artifacts.push({
            ref,
            status: "not rendered",
            message: "not valid UTF-8 · not rendered",
          });
        }
      }
      const nextState: ShellState = {
        describe: described,
        tasks,
        selectedTask: inspected,
        events: events.ok ? events.value : [],
        artifacts,
        onSelect: (taskId) => {
          selectedId = taskId;
          void load();
        },
        onRefresh: () => void load(),
      };
      if (verification.ok) nextState.verification = verification.value;
      else nextState.verificationError = verification.error;
      if (diff.ok) nextState.diff = diff.value;
      else nextState.diffError = diff.error;
      if (evidence.ok) nextState.evidence = evidence.value;
      else nextState.evidenceError = evidence.error;
      if (!events.ok) nextState.eventsError = events.error;
      state = nextState;
      render();
    } catch (error) {
      displayError(
        error instanceof Error ? error.message : "Workbench is unavailable.",
      );
    }
  };

  const load = () => {
    loadRequested = true;
    if (!loadPromise) {
      loadPromise = (async () => {
        while (loadRequested) {
          loadRequested = false;
          await loadOnce();
        }
      })().finally(() => {
        loadPromise = undefined;
        if (loadRequested) void load();
      });
    }
    return loadPromise;
  };

  const settled = async () => {
    while (loadPromise) await loadPromise;
  };

  return { load, settled };
}
