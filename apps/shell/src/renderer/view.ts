import type {
  ArtifactRef,
  EventEnvelope,
  Task,
  VerificationView,
} from "@mars/contracts";
import type {
  DescribeResult,
  DiffResult,
  EvidenceResult,
  InspectResult,
} from "../shared/methods";
import { h, type ShellDocument, type ShellElement } from "./dom";
import { STATUS_LABEL, VERIFICATION_LABEL } from "./strings";
import { untrusted } from "./untrusted";

export type ArtifactView = {
  ref: ArtifactRef;
  content?: string;
  status: "verified" | "rejected" | "not rendered";
  message?: string;
};

export type ShellState = {
  describe?: DescribeResult;
  tasks: Task[];
  selectedTask?: InspectResult;
  verification?: VerificationView;
  events: EventEnvelope[];
  diff?: DiffResult;
  evidence?: EvidenceResult;
  artifacts: ArtifactView[];
  error?: string;
  onSelect?: (taskId: string) => void;
  onRefresh?: () => void;
};

const STATUS_ORDER: Task["status"][] = [
  "running",
  "paused",
  "pending",
  "completed",
  "failed",
  "cancelled",
];

function heading(doc: ShellDocument, text: string): ShellElement {
  return h(doc, "h2", { class: "section-title" }, text);
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function status(doc: ShellDocument, task: Task): ShellElement {
  const label = STATUS_LABEL[task.status];
  return h(
    doc,
    "span",
    { class: `status status-${task.status}`, "aria-label": label.word },
    `${label.glyph} ${label.word}`,
  );
}

function taskList(
  doc: ShellDocument,
  tasks: Task[],
  selectedId: string | undefined,
  onSelect?: (taskId: string) => void,
): ShellElement[] {
  const groups: ShellElement[] = [];
  for (const statusValue of STATUS_ORDER) {
    const group = tasks.filter((task) => task.status === statusValue);
    if (group.length === 0) continue;
    const items = group.map((task) => {
      const button = h(
        doc,
        "button",
        {
          class: `session${task.task_id === selectedId ? " selected" : ""}`,
          "data-task-id": task.task_id,
          "aria-pressed": task.task_id === selectedId ? "true" : "false",
          title: task.task_id,
          type: "button",
        },
        status(doc, task),
        h(
          doc,
          "span",
          { class: "provenance", "data-provenance": "task request" },
          "untrusted · task request",
        ),
        h(doc, "span", { class: "session-request" }, firstLine(task.request)),
        h(
          doc,
          "span",
          { class: "session-runtime" },
          h(doc, "span", { class: "runtime-label" }, "oh-my-pi"),
          h(
            doc,
            "span",
            { class: "session-id", title: task.task_id },
            task.task_id,
          ),
        ),
      );
      button.addEventListener("click", () => onSelect?.(task.task_id));
      return h(doc, "li", { class: "session-item" }, button);
    });
    groups.push(
      h(
        doc,
        "section",
        { class: "session-group", "aria-label": statusValue },
        h(doc, "h3", { class: "group-title" }, statusValue),
        h(doc, "ul", { class: "session-list" }, ...items),
      ),
    );
  }
  return groups;
}

function taskHeader(
  doc: ShellDocument,
  task: InspectResult | undefined,
  verification: VerificationView | undefined,
): ShellElement {
  if (!task)
    return h(
      doc,
      "header",
      { class: "task-header" },
      h(doc, "h1", {}, "No task selected"),
      h(doc, "p", {}, "Select a session to inspect its read-only details."),
    );
  const state = verification?.state ?? "unverified";
  const candidateRevision =
    verification?.candidate?.revision ?? "not available";
  return h(
    doc,
    "header",
    { class: "task-header" },
    h(doc, "h1", {}, `Task ${task.task_id}`),
    h(
      doc,
      "div",
      { class: "task-meta" },
      h(
        doc,
        "span",
        { class: `verification verification-${state}` },
        VERIFICATION_LABEL[state],
      ),
      status(doc, task),
      h(
        doc,
        "span",
        { class: "meta-value" },
        `Candidate revision: ${candidateRevision}`,
      ),
      h(doc, "span", { class: "meta-value" }, "Mode: not reported by host"),
      h(
        doc,
        "span",
        { class: "meta-value" },
        `Model · tier: ${task.model_tier ?? "not reported by host"}`,
      ),
      h(
        doc,
        "span",
        { class: "meta-value" },
        `Task revision: ${task.revision}`,
      ),
    ),
  );
}

function taskInspector(doc: ShellDocument, task: Task): ShellElement {
  const criteria = task.acceptance_criteria.map((criterion) =>
    untrusted(doc, criterion, "acceptance criterion"),
  );
  return h(
    doc,
    "section",
    { class: "inspector-section" },
    heading(doc, "Task"),
    h(doc, "h3", { class: "minor-title" }, "Request"),
    untrusted(doc, task.request, "task request"),
    h(doc, "h3", { class: "minor-title" }, "Acceptance criteria"),
    h(doc, "div", { class: "criteria-list" }, ...criteria),
    h(
      doc,
      "dl",
      { class: "budget" },
      h(doc, "dt", {}, "Budget"),
      h(
        doc,
        "dd",
        {},
        `${task.budget.max_tokens} tokens · $${task.budget.max_usd} · ${task.budget.max_duration_ms} ms · depth ${task.budget.max_depth} · concurrency ${task.budget.max_concurrency}`,
      ),
    ),
  );
}

function verificationSection(
  doc: ShellDocument,
  view: VerificationView | undefined,
): ShellElement {
  if (!view)
    return h(
      doc,
      "section",
      { class: "inspector-section" },
      heading(doc, "Verification"),
      h(doc, "p", {}, "No verification view available."),
    );
  const reasons = view.reasons.map((reason) =>
    untrusted(doc, reason, "host verdict reason"),
  );
  const records = view.records.map((record) =>
    h(
      doc,
      "article",
      { class: "record" },
      h(
        doc,
        "p",
        {},
        `${record.verdict} · ${record.candidate?.revision ?? "no candidate"} · ${record.recorded_at}`,
      ),
      ...record.reasons.map((reason) =>
        untrusted(doc, reason, "host verdict reason"),
      ),
    ),
  );
  return h(
    doc,
    "section",
    { class: "inspector-section" },
    heading(doc, "Verification"),
    h(
      doc,
      "p",
      { class: `verification verification-${view.state}` },
      VERIFICATION_LABEL[view.state],
    ),
    ...reasons,
    h(doc, "div", { class: "records" }, ...records),
  );
}

function countPatch(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function changesSection(
  doc: ShellDocument,
  diff: DiffResult | undefined,
): ShellElement {
  const files = (diff?.files ?? []).map((file) => {
    const counts = countPatch(file.patch);
    return h(
      doc,
      "article",
      { class: "change-file" },
      h(
        doc,
        "p",
        { class: "change-summary" },
        `${file.status} · +${counts.added} −${counts.removed}`,
      ),
      untrusted(doc, file.path, "workspace diff"),
      diff?.digest
        ? h(doc, "small", { class: "digest" }, `sha256 ${diff.digest}`)
        : null,
      h(
        doc,
        "details",
        { class: "patch-details" },
        h(doc, "summary", {}, "Patch"),
        untrusted(doc, file.patch, "workspace diff"),
      ),
    );
  });
  return h(
    doc,
    "section",
    { class: "inspector-section" },
    heading(doc, "Changes"),
    ...(files.length ? files : [h(doc, "p", {}, "No diff files.")]),
  );
}

function evidenceSection(
  doc: ShellDocument,
  evidence: EvidenceResult | undefined,
): ShellElement {
  const records = (evidence?.verify_records ?? []).map((record) =>
    h(
      doc,
      "article",
      { class: "record" },
      untrusted(doc, record.event_id, "evidence id"),
      h(
        doc,
        "p",
        {},
        `${record.verdict} · ${record.verified ? "verified" : "not verified"} · ${record.stale ? "stale" : "current"} · ${record.recorded_at}`,
      ),
    ),
  );
  return h(
    doc,
    "section",
    { class: "inspector-section" },
    heading(doc, "Evidence"),
    ...(records.length ? records : [h(doc, "p", {}, "No evidence records.")]),
  );
}

function artifactsSection(
  doc: ShellDocument,
  artifacts: ArtifactView[],
): ShellElement {
  const rows = artifacts.map((artifact) => {
    const { ref } = artifact;
    const content =
      artifact.status === "verified" && artifact.content !== undefined
        ? untrusted(
            doc,
            artifact.content,
            `artifact ${ref.artifact_id} · sha256 verified`,
          )
        : h(
            doc,
            "p",
            { class: artifact.status === "rejected" ? "error" : "muted" },
            artifact.status === "rejected"
              ? "rejected: sha256 mismatch"
              : (artifact.message ?? "not rendered"),
          );
    return h(
      doc,
      "article",
      { class: "artifact" },
      h(
        doc,
        "p",
        {},
        `${ref.artifact_id} · ${ref.media_type} · ${ref.byte_length} bytes`,
      ),
      content,
    );
  });
  return h(
    doc,
    "section",
    { class: "inspector-section" },
    heading(doc, "Artifacts"),
    ...(rows.length ? rows : [h(doc, "p", {}, "No artifacts.")]),
  );
}

export function renderShell(
  doc: ShellDocument,
  state: ShellState,
): ShellElement {
  if (state.error)
    return h(
      doc,
      "main",
      { class: "connection-error", role: "alert" },
      h(doc, "h1", {}, "MARS Shell"),
      h(doc, "p", {}, state.error),
    );
  const task = state.selectedTask;
  const refresh = h(
    doc,
    "button",
    { class: "refresh", type: "button" },
    "Refresh",
  );
  refresh.addEventListener("click", () => state.onRefresh?.());
  const sidebar = h(
    doc,
    "nav",
    { class: "sidebar", "aria-label": "Sidebar" },
    h(doc, "h1", { class: "brand" }, "MARS Shell"),
    h(doc, "h2", { class: "section-title" }, "Sessions"),
    ...taskList(doc, state.tasks, task?.task_id, state.onSelect),
    h(
      doc,
      "section",
      { class: "workspace-placeholder" },
      h(doc, "h2", { class: "section-title" }, "Workspace tree"),
      h(doc, "p", {}, "arrives with @mars/ui-core"),
    ),
    h(
      doc,
      "section",
      { class: "team-chat" },
      h(
        doc,
        "button",
        { type: "button", disabled: true, "aria-disabled": "true" },
        "Team chat",
      ),
      h(doc, "p", {}, "reserved · not in this build"),
    ),
  );
  const main = h(
    doc,
    "main",
    { class: "main" },
    h(
      doc,
      "div",
      { class: "main-toolbar" },
      taskHeader(doc, task, state.verification),
      refresh,
    ),
    h(
      doc,
      "section",
      { class: "transcript", role: "log", "aria-live": "polite" },
      h(
        doc,
        "p",
        {},
        `Transcript projection arrives with @mars/ui-core. ${state.events.length >= 1000 ? "1000+" : state.events.length} task event${state.events.length === 1 ? "" : "s"} available via tasks.events (content not rendered in this build).`,
      ),
    ),
  );
  const inspector = h(
    doc,
    "aside",
    { class: "inspector", "aria-label": "Task inspector" },
    task
      ? taskInspector(doc, task)
      : h(
          doc,
          "section",
          {},
          heading(doc, "Task"),
          h(doc, "p", {}, "Select a task."),
        ),
    verificationSection(doc, state.verification),
    changesSection(doc, state.diff),
    evidenceSection(doc, state.evidence),
    artifactsSection(doc, state.artifacts),
  );
  const footer = h(
    doc,
    "footer",
    { class: "status-bar" },
    h(doc, "span", {}, state.describe ? "Connected" : "Not connected"),
    h(doc, "span", {}, state.describe?.workspaceLabel ?? "No workspace"),
    h(doc, "span", {}, "loopback"),
    h(doc, "span", {}, "read-only"),
    h(
      doc,
      "span",
      {},
      `execute: ${state.describe?.capabilities.execute ? "on" : "off"}`,
    ),
  );
  return h(
    doc,
    "div",
    { class: "app-shell" },
    sidebar,
    main,
    inspector,
    footer,
  );
}
