import type { BridgeResult, ShellBridge } from "../shared/methods";
import type { ShellDocument, ShellElement } from "./dom";
import { verifyArtifact } from "./verify";
import { type ArtifactView, renderShell, type ShellState } from "./view";

const TEXT_MEDIA_TYPES = new Set(["application/json", "application/x-ndjson"]);
const MAX_RENDERED_ARTIFACT_BYTES = 256 * 1024;

function textLike(mediaType: string): boolean {
  return mediaType.startsWith("text/") || TEXT_MEDIA_TYPES.has(mediaType);
}

export function createController(
  bridge: ShellBridge,
  doc: ShellDocument,
  root: ShellElement,
) {
  let selectedId: string | undefined;
  let loading = false;
  let state: ShellState = { tasks: [], events: [], artifacts: [] };

  const render = () => root.replaceChildren(renderShell(doc, state));
  const displayError = (message: string) => {
    state = { tasks: [], events: [], artifacts: [], error: message };
    render();
  };
  const value = async <T>(pending: Promise<BridgeResult<T>>): Promise<T> => {
    const result = await pending;
    if (!result.ok) throw new Error(result.error.message);
    return result.result;
  };

  const load = async () => {
    if (loading) return;
    loading = true;
    try {
      const described = await value(bridge["workbench.describe"]({}));
      const tasks = await value(bridge["tasks.list"]({}));
      const selected =
        tasks.find((task) => task.task_id === selectedId) ?? tasks[0];
      selectedId = selected?.task_id;
      if (!selected) {
        state = { describe: described, tasks, events: [], artifacts: [] };
        render();
        return;
      }
      const inspected = await value(
        bridge["tasks.inspect"]({ task_id: selected.task_id }),
      );
      const [verification, diff, evidence, events] = await Promise.all([
        value(bridge["tasks.verification"]({ task_id: selected.task_id })),
        value(bridge["tasks.diff"]({ task_id: selected.task_id })),
        value(bridge["tasks.evidence"]({ task_id: selected.task_id })),
        value(bridge["tasks.events"]({ task_id: selected.task_id })),
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
        const fetched = await bridge["tasks.artifact"]({
          task_id: inspected.task_id,
          artifact: ref,
        });
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
        artifacts.push({
          ref,
          status: "verified",
          content: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
        });
      }
      state = {
        describe: described,
        tasks,
        selectedTask: inspected,
        verification,
        diff,
        evidence,
        events,
        artifacts,
        onSelect: (taskId) => {
          selectedId = taskId;
          void load();
        },
        onRefresh: () => void load(),
      };
      render();
    } catch (error) {
      displayError(
        error instanceof Error ? error.message : "Workbench is unavailable.",
      );
    } finally {
      loading = false;
    }
  };

  return { load };
}
