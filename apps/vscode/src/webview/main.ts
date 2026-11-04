/// <reference lib="dom" />
import type {
  DiffFileView,
  EventView,
  HostMessage,
  SelectedView,
  VerificationBadge,
  ViewState,
  WebviewMessage,
} from "../messages";
import { button, h } from "./dom";
import { renderOutput } from "./output";

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const app = document.getElementById("app") as HTMLElement;
let state: ViewState | null = null;
let approvalTask: string | null = null;

function field(
  labelText: string,
  control: HTMLElement,
  hint?: string,
): HTMLElement {
  const id = `f-${labelText.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`;
  control.id = id;
  const label = h("label", {}, labelText);
  label.htmlFor = id;
  return h(
    "div",
    { class: "field" },
    label,
    control,
    hint ? h("span", { class: "hint" }, hint) : null,
  );
}

function numberInput(
  placeholder: string,
  min: string,
  step: string,
): HTMLInputElement {
  const input = h("input");
  input.type = "number";
  input.min = min;
  input.step = step;
  input.placeholder = placeholder;
  input.required = true;
  return input;
}

// ---------------------------------------------------------------- persistent form

const newTask = (() => {
  const request = h("textarea");
  request.rows = 4;
  request.placeholder = "What should MARS do?";
  const criteria = h("textarea");
  criteria.rows = 3;
  criteria.placeholder = "One acceptance criterion per line";
  const tokens = numberInput("e.g. 200000", "1", "1");
  const usd = numberInput("0 for free models only", "0", "0.01");
  const seconds = numberInput("e.g. 1800", "1", "1");
  const depth = numberInput("e.g. 0", "0", "1");
  const concurrency = numberInput("e.g. 1", "1", "1");
  const details = h("details", { class: "new-task" });
  const summary = h("summary", { key: "new-task-summary" }, "New task");
  const create = button("Create task", "create-task", () => {
    vscode.postMessage({
      type: "createTask",
      request: request.value,
      acceptanceCriteria: criteria.value.split("\n"),
      budget: {
        max_tokens: Number(tokens.value),
        max_usd: Number(usd.value),
        max_duration_ms: Math.round(Number(seconds.value) * 1000),
        max_depth: Number(depth.value),
        max_concurrency: Number(concurrency.value),
      },
    });
  });
  const saved = vscode.getState() as
    | { request?: unknown; criteria?: unknown }
    | undefined;
  if (typeof saved?.request === "string") request.value = saved.request;
  if (typeof saved?.criteria === "string") criteria.value = saved.criteria;
  const persist = () =>
    vscode.setState({ request: request.value, criteria: criteria.value });
  request.addEventListener("input", persist);
  criteria.addEventListener("input", persist);
  details.append(
    summary,
    field("Request", request),
    field("Acceptance criteria", criteria),
    h(
      "div",
      { class: "grid" },
      field("Max tokens", tokens),
      field("Max USD", usd, "Paid usage still requires server policy."),
      field("Max duration (s)", seconds),
      field("Max depth", depth),
      field("Max concurrency", concurrency),
    ),
    h(
      "p",
      { class: "hint" },
      "Creating a task does not run it. You approve and start it explicitly.",
    ),
    create,
  );
  return { details, request, create };
})();

const steerBox = h("textarea");
steerBox.rows = 2;
steerBox.placeholder = "Steer the running task…";
const approvals = { read: h("input"), write: h("input"), execute: h("input") };
for (const box of Object.values(approvals)) box.type = "checkbox";

function resetApprovals(taskId: string): void {
  if (approvalTask === taskId) return;
  approvalTask = taskId;
  approvals.read.checked = true;
  approvals.write.checked = false;
  approvals.execute.checked = false;
  steerBox.value = "";
}

// ---------------------------------------------------------------- render

const STATUS_TEXT: Record<string, string> = {
  "no-token": "No token",
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected",
  unauthorized: "Token rejected",
  blocked: "Blocked",
  error: "Error",
};

function renderHeader(s: ViewState): HTMLElement {
  const c = s.connection;
  const actions = h("div", { class: "row" });
  if (c.status !== "connected" && c.status !== "connecting")
    actions.append(
      button("Connect", "connect", () =>
        vscode.postMessage({ type: "connect" }),
      ),
    );
  if (
    c.status === "no-token" ||
    c.status === "unauthorized" ||
    c.status === "connected"
  )
    actions.append(
      button(
        c.status === "connected" ? "Change token" : "Set token",
        "set-token",
        () => vscode.postMessage({ type: "setToken" }),
        { secondary: true },
      ),
    );
  if (c.status === "connected")
    actions.append(
      button(
        "Refresh",
        "refresh",
        () => vscode.postMessage({ type: "refresh" }),
        { secondary: true },
      ),
    );
  return h(
    "header",
    { class: "panel" },
    h(
      "div",
      { class: "row" },
      h(
        "span",
        { class: `pill status-${c.status}` },
        STATUS_TEXT[c.status] ?? c.status,
      ),
      c.workspaceLabel
        ? h(
            "span",
            { class: "muted" },
            `${c.workspaceLabel}${c.workspaceId ? ` · ${c.workspaceId}` : ""}`,
          )
        : null,
    ),
    c.server ? h("div", { class: "muted mono" }, c.server) : null,
    c.message ? h("p", { class: "message" }, c.message) : null,
    h(
      "p",
      { class: "muted small" },
      `Model: ${s.policy.modelId ?? "server default free-cloud route"}. ${s.policy.paidPolicy}`,
    ),
    actions,
  );
}

function renderTasks(s: ViewState): HTMLElement {
  const list = h("ul", { class: "tasks", label: "Tasks" });
  for (const task of s.tasks) {
    const selected = s.selected?.task.task_id === task.task_id;
    const item = button(
      "",
      `task-${task.task_id}`,
      () => vscode.postMessage({ type: "selectTask", taskId: task.task_id }),
      {
        secondary: !selected,
      },
    );
    item.setAttribute("aria-pressed", String(selected));
    item.className = `task ${selected ? "selected" : ""}`;
    item.append(
      h("span", { class: `badge s-${task.status}` }, task.status),
      h("span", { class: "grow" }, task.request),
    );
    list.append(h("li", {}, item));
  }
  if (s.tasks.length === 0)
    list.append(h("li", { class: "muted" }, "No tasks yet."));
  return h(
    "section",
    { class: "panel", label: "Task list" },
    h("h2", {}, "Tasks"),
    list,
  );
}

function meter(
  label: string,
  used: number,
  max: number,
  text: string,
): HTMLElement {
  const bar = h("progress");
  bar.max = Math.max(max, 1e-9);
  bar.value = Math.min(used, bar.max);
  bar.setAttribute("aria-label", label);
  return h(
    "div",
    { class: "meter" },
    h("span", {}, label),
    bar,
    h("span", { class: "muted small" }, text),
  );
}

/**
 * The verification badge is the host's verdict, never the task status: a
 * `completed` run shows "Unverified" until the server reports a verdict for
 * the exact candidate revision being presented.
 */
function renderVerificationBadge(
  task: SelectedView["task"],
  verification: VerificationBadge | null,
): HTMLElement[] {
  const terminal =
    task.status === "completed" ||
    task.status === "failed" ||
    task.status === "cancelled";
  if (!terminal) return [];
  if (!verification)
    return [h("span", { class: "badge v-pending" }, "Verification…")];
  const title =
    verification.state === "verified" && verification.bound
      ? `All required checks passed for candidate ${verification.bound}`
      : verification.state === "stale"
        ? `Verdict recorded for revision ${verification.bound ?? "unknown"}; current candidate is ${verification.candidate ?? "unknown"}`
        : verification.state === "unverified"
          ? "No required checks were declared for this run"
          : verification.reasons.join("; ");
  return [
    h(
      "span",
      { class: `badge v-${verification.state}`, title },
      verification.label,
    ),
  ];
}

function renderVerificationDetail(
  verification: VerificationBadge | null,
): HTMLElement[] {
  if (!verification || verification.state === "unverified") return [];
  const lines = [...verification.reasons, ...verification.diagnostics];
  const bound =
    verification.bound && verification.candidate
      ? verification.state === "stale"
        ? `Verdict bound to revision ${verification.bound}; current candidate ${verification.candidate}.`
        : `Candidate ${verification.candidate}.`
      : "";
  if (lines.length === 0 && !bound) return [];
  const list = h("ul", { class: "small" });
  for (const line of lines) list.append(h("li", {}, line));
  return [
    h(
      "div",
      { class: "verification small" },
      bound ? h("p", { class: "muted mono small" }, bound) : null,
      lines.length ? list : null,
    ),
  ];
}

function renderEvents(sel: SelectedView): HTMLElement {
  const taskId = sel.task.task_id;
  const list = h("ol", { class: "timeline", label: "Event timeline" });
  for (const event of [...sel.events].reverse())
    list.append(renderEvent(taskId, event));
  if (sel.events.length === 0)
    list.append(h("li", { class: "muted" }, "No events yet."));
  return h(
    "section",
    { class: "panel" },
    h("h3", {}, `Timeline (${sel.polling})`),
    sel.eventsTruncated
      ? h("p", { class: "muted small" }, "Older events hidden.")
      : null,
    list,
  );
}

function renderEvent(taskId: string, event: EventView): HTMLElement {
  const usage = event.usage
    ? `${event.usage.input_tokens}+${event.usage.output_tokens} tok${event.usage.cost_usd === null ? "" : ` · $${event.usage.cost_usd.toFixed(4)}`}`
    : "";
  return h(
    "li",
    {},
    h(
      "div",
      { class: "row" },
      h("strong", {}, event.event_type),
      h(
        "span",
        { class: "muted small" },
        new Date(event.occurred_at).toLocaleTimeString(),
      ),
    ),
    h(
      "div",
      { class: "muted small" },
      `${event.producer} · ${event.payload.media_type} · ${event.payload.byte_length} B ${usage}`,
    ),
    h(
      "div",
      { class: "row" },
      button(
        "Inspect",
        `inspect-${event.event_id}`,
        () =>
          vscode.postMessage({
            type: "inspectArtifact",
            taskId,
            artifactId: event.payload.artifact_id,
          }),
        { secondary: true },
      ),
      button(
        "Open",
        `open-${event.event_id}`,
        () =>
          vscode.postMessage({
            type: "openArtifact",
            taskId,
            artifactId: event.payload.artifact_id,
          }),
        { secondary: true },
      ),
    ),
  );
}

function renderDiff(sel: SelectedView): HTMLElement {
  const taskId = sel.task.task_id;
  const section = h("section", { class: "panel" }, h("h3", {}, "Changes"));
  section.append(
    button(
      sel.diff ? "Reload changes" : "Load changes",
      "load-diff",
      () => vscode.postMessage({ type: "loadDiff", taskId }),
      { secondary: true },
    ),
  );
  if (!sel.diff) return section;
  const list = h("ul", { class: "files" });
  for (const file of sel.diff) list.append(renderFile(taskId, file));
  if (sel.diff.length === 0)
    list.append(h("li", { class: "muted" }, "No file changes."));
  section.append(list);
  return section;
}

function renderFile(taskId: string, file: DiffFileView): HTMLElement {
  return h(
    "li",
    { class: "row" },
    h(
      "span",
      { class: `badge f-${file.status}` },
      file.status[0]?.toUpperCase() ?? "?",
    ),
    h("span", { class: "grow mono", title: file.path }, file.path),
    h("span", { class: "add" }, `+${file.additions}`),
    h("span", { class: "del" }, `-${file.deletions}`),
    button(
      "Open diff",
      `diff-${file.index}`,
      () => vscode.postMessage({ type: "openDiff", taskId, index: file.index }),
      {
        secondary: true,
        disabled: !file.safe,
        ...(file.reason ? { title: file.reason } : {}),
      },
    ),
  );
}

function renderCheckpoints(s: ViewState, sel: SelectedView): HTMLElement {
  const taskId = sel.task.task_id;
  const section = h("section", { class: "panel" }, h("h3", {}, "Checkpoints"));
  section.append(
    sel.workspace
      ? h(
          "p",
          { class: "muted small mono" },
          `Workspace ${sel.workspace.workspace_id} (${sel.workspace.provider}) @ ${sel.workspace.revision}`,
        )
      : h(
          "p",
          { class: "muted small" },
          "Create a checkpoint to see workspace identity.",
        ),
    button(
      "Create checkpoint",
      "checkpoint",
      () => vscode.postMessage({ type: "createCheckpoint", taskId }),
      {
        secondary: true,
        disabled: !s.connection.canCheckpoint,
      },
    ),
  );
  const list = h("ul", { class: "files" });
  for (const cp of sel.checkpoints)
    list.append(
      h(
        "li",
        { class: "row" },
        h(
          "span",
          { class: "grow mono" },
          `${cp.checkpoint_id} @ ${cp.workspace.revision}`,
        ),
        button(
          "Restore…",
          `restore-${cp.checkpoint_id}`,
          () =>
            vscode.postMessage({
              type: "restoreCheckpoint",
              taskId,
              checkpointId: cp.checkpoint_id,
            }),
          { danger: true },
        ),
      ),
    );
  section.append(list);
  return section;
}

function renderSelected(s: ViewState, sel: SelectedView): HTMLElement {
  const task = sel.task;
  resetApprovals(task.task_id);
  const taskId = task.task_id;
  const live = task.status === "running" || task.status === "paused";
  const usage = sel.usage;
  const controls = h("div", { class: "panel" });
  if (task.status === "pending") {
    approvals.execute.disabled = !s.connection.canExecute;
    if (!s.connection.canExecute) approvals.execute.checked = false;
    controls.append(
      h("h3", {}, "Approve and start"),
      h(
        "div",
        { class: "row" },
        checkbox("Read files", approvals.read),
        checkbox("Write files", approvals.write),
        checkbox(
          s.connection.canExecute
            ? "Execute commands"
            : "Execute (unavailable)",
          approvals.execute,
        ),
      ),
      button("Start…", "start", () =>
        vscode.postMessage({
          type: "startTask",
          taskId,
          approvals: {
            read: approvals.read.checked,
            write: approvals.write.checked,
            execute: approvals.execute.checked,
          },
        }),
      ),
    );
  }
  const actions = h("div", { class: "row" });
  if (task.status === "paused")
    actions.append(
      button("Resume…", "resume", () =>
        vscode.postMessage({ type: "resumeTask", taskId }),
      ),
    );
  if (task.status === "pending" || live)
    actions.append(
      button(
        "Cancel…",
        "cancel",
        () => vscode.postMessage({ type: "cancelTask", taskId }),
        { danger: true },
      ),
    );
  controls.append(actions);
  if (live)
    controls.append(
      field("Steer", steerBox),
      button(
        "Send instruction",
        "steer",
        () => {
          vscode.postMessage({
            type: "steerTask",
            taskId,
            instruction: steerBox.value,
          });
          steerBox.value = "";
        },
        { secondary: true },
      ),
    );

  const criteria = h("ul", {});
  for (const line of task.acceptance_criteria)
    criteria.append(h("li", {}, line));
  const artifact = sel.artifact
    ? h(
        "section",
        { class: "panel" },
        h("h3", {}, `Artifact ${sel.artifact.artifact_id}`),
        h(
          "p",
          { class: "muted small" },
          `${sel.artifact.media_type} · ${sel.artifact.byte_length} B${sel.artifact.note ? ` · ${sel.artifact.note}` : ""}`,
        ),
        ...(sel.artifact.text === null
          ? []
          : sel.artifact.final_text
            ? renderOutput(task, sel.artifact.text, (message) =>
                vscode.postMessage(message),
              )
            : [h("pre", { class: "artifact" }, sel.artifact.text)]),
      )
    : null;
  return h(
    "section",
    { class: "selected", label: "Selected task" },
    h(
      "div",
      { class: "panel" },
      h(
        "div",
        { class: "row" },
        h("span", { class: `badge s-${task.status}` }, task.status),
        ...renderVerificationBadge(task, sel.verification),
        h(
          "span",
          { class: "muted mono small" },
          `${task.task_id} · rev ${task.revision}`,
        ),
      ),
      h("p", { class: "request" }, task.request),
      ...renderVerificationDetail(sel.verification),
      h("h4", {}, "Acceptance criteria"),
      criteria,
      meter(
        "Tokens",
        usage.input_tokens + usage.output_tokens,
        usage.budget.max_tokens,
        `${usage.input_tokens + usage.output_tokens} / ${usage.budget.max_tokens}`,
      ),
      meter(
        "Cost",
        usage.cost_usd,
        usage.budget.max_usd,
        `$${usage.cost_usd.toFixed(4)} / $${usage.budget.max_usd}${usage.cost_unknown ? " (some costs unknown)" : ""}`,
      ),
      h(
        "p",
        { class: "muted small" },
        `Duration limit ${Math.round(usage.budget.max_duration_ms / 1000)} s · depth ${usage.budget.max_depth} · concurrency ${usage.budget.max_concurrency}`,
      ),
    ),
    controls,
    renderEvents(sel),
    artifact,
    renderDiff(sel),
    renderCheckpoints(s, sel),
  );
}

function checkbox(text: string, input: HTMLInputElement): HTMLElement {
  return h("label", { class: "check" }, input, text);
}

function render(): void {
  if (!state) return;
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset
    ?.focusKey;
  const s = state;
  const notice = s.notice
    ? h(
        "div",
        {
          class: `notice ${s.notice.kind}`,
          role: s.notice.kind === "info" ? "status" : "alert",
        },
        s.notice.text,
      )
    : null;
  const connected = s.connection.status === "connected";
  newTask.create.disabled = !connected || s.busy !== null;
  app.replaceChildren(
    renderHeader(s),
    s.busy ? h("div", { class: "busy", role: "status" }, `${s.busy}…`) : "",
    notice ?? "",
    connected ? newTask.details : "",
    connected ? renderTasks(s) : "",
    connected && s.selected ? renderSelected(s, s.selected) : "",
  );
  if (focusKey) {
    const target = Array.from(
      app.querySelectorAll<HTMLElement>("[data-focus-key]"),
    ).find((element) => element.dataset.focusKey === focusKey);
    target?.focus();
  }
}

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message?.type === "state") {
    state = message.state;
    render();
  } else if (message?.type === "focusNewTask") {
    newTask.details.open = true;
    newTask.request.focus();
  }
});

vscode.postMessage({ type: "ready" });
