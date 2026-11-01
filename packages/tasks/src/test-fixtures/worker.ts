import type { RequestContext, Task } from "@mars/contracts";
import { createTaskStore } from "../index";

const [operation, rootDir, encoded] = Bun.argv.slice(2);
if (!operation || !rootDir || !encoded)
  throw new Error("Missing worker arguments");
const input = JSON.parse(encoded) as {
  context: RequestContext;
  task?: Task;
  taskId?: string;
};
const store = await createTaskStore({ rootDir, workspaceRoots: [] });

if (operation === "create") {
  if (!input.task) throw new Error("Missing task");
  await store.create(input.context, input.task);
} else if (operation === "append50") {
  if (!input.taskId) throw new Error("Missing task id");
  for (let index = 0; index < 50; index += 1) {
    await store.appendEvent(
      { ...input.context, request_id: `${input.context.request_id}-${index}` },
      input.taskId,
      {
        event_type: "tool.completed",
        run_id: `run-${index}`,
        producer: "test-worker",
        versions: [{ component: "test", revision: "1" }],
        payload: { index },
      },
    );
  }
} else if (operation === "leave-running") {
  if (!input.taskId) throw new Error("Missing task id");
  const task = await store.inspect(input.context, input.taskId);
  await store.update(input.context, input.taskId, task.revision, {
    status: "running",
  });
  process.exit(0);
} else {
  throw new Error(`Unknown worker operation: ${operation}`);
}

await store.close();
