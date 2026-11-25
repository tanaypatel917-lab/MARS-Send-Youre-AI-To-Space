import type {
  ArtifactRef,
  EventEnvelope,
  Task,
  VerificationView,
} from "@mars/contracts";
import type { TranscriptProjection } from "@mars/ui-core";
import type {
  DescribeResult,
  DiffResult,
  EvidenceResult,
  InspectResult,
  PatchExportResult,
} from "../shared/methods";
import { type AssistantViewState, renderAssistant } from "./assistant-view";
import { disclosure, h, type ShellDocument, type ShellElement } from "./dom";
import { type ExtensionState, renderExtensions } from "./extensions-view";
import { renderSettings } from "./settings-view";
import { STATUS_LABEL, VERIFICATION_LABEL } from "./strings";
import { renderTeamChatPane, type TeamChatViewState } from "./team-chat-view";
import { renderTranscript } from "./transcript";
import { untrusted } from "./untrusted";

export type ArtifactView = {
  ref: ArtifactRef;
  content?: string;
  status: "verified" | "rejected" | "not rendered";
  message?: string;
};

export type ApprovalsState = {
  read: boolean;
  write: boolean;
  execute: boolean;
};

export type ComposerState = {
  request: string;
  criteria: string;
  startNow: boolean;
  approvals: ApprovalsState;
  modelChoice: "default" | "paid";
  paidModelId: string;
  paidModelConsent: boolean;
  /** Host check ids (from `workbench.describe`) required at launch. */
  checkIds: string[];
  submitting: boolean;
  error?: string;
};

export type LaunchCardState = {
  approvals: ApprovalsState;
  modelChoice: "default" | "paid";
  paidModelId: string;
  paidModelConsent: boolean;
  checkIds: string[];
  steerDraft: string;
  busy: boolean;
  actionNotice?: string;
  modelUnavailable?: boolean;
  actionError?: string;
};

export type ExportViewState = {
  busy: boolean;
  error?: string;
  result?: PatchExportResult;
  patchText?: string;
  verifiedSha256?: boolean;
};

export type WorkspacePage = "chat" | "tasks" | "extensions" | "settings";
export type ShellState = {
  page?: WorkspacePage;
  settingsError?: string | undefined;
  assistant?: AssistantViewState;
  extensions?: ExtensionState;
  inspectorOpen?: boolean;
  onPage?: (page: WorkspacePage) => void;
  onToggleInspector?: () => void;
  describe?: DescribeResult;
  tasks: Task[];
  selectedTask?: InspectResult;
  verification?: VerificationView;
  events: EventEnvelope[];
  transcript?: TranscriptProjection;
  diff?: DiffResult;
  evidence?: EvidenceResult;
  artifacts: ArtifactView[];
  verificationError?: string;
  diffError?: string;
  evidenceError?: string;
  eventsError?: string;
  eventsCapped?: boolean;
  error?: string;
  composer?: ComposerState;
  launch?: LaunchCardState;
  patchExport?: ExportViewState;
  teamChat?: TeamChatViewState;
  onSelect?: (taskId: string) => void;
  onRefresh?: () => void;
  onOpenTeamChat?: () => void;
  onComposerChange?: (patch: Partial<ComposerState>) => void;
  onComposerApprovalChange?: (
    key: keyof ApprovalsState,
    value: boolean,
  ) => void;
  onCreateTask?: () => void;
  onLaunchApprovalChange?: (key: keyof ApprovalsState, value: boolean) => void;
  onLaunchChange?: (patch: Partial<LaunchCardState>) => void;
  onComposerCheckChange?: (checkId: string, selected: boolean) => void;
  onLaunchCheckChange?: (checkId: string, selected: boolean) => void;
  onStartTask?: () => void;
  onResumeTask?: () => void;
  onSteerTask?: (instruction: string) => void;
  onCancelTask?: () => void;
  onExportPatch?: () => void;
};

export const HEADING_FOCUS_KEY = "heading";
const REFRESH_FOCUS_KEY = "refresh";
const HEADING_ATTRS = { "data-focus-key": HEADING_FOCUS_KEY, tabindex: "-1" };

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

function unavailable(doc: ShellDocument, message: string): ShellElement {
  return h(doc, "p", { class: "muted" }, `unavailable · ${message}`);
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

/** Mirrors the `required_checks` cap in the workbench `StartParamsSchema`. */
export const MAX_REQUIRED_CHECKS = 32;

function hostChecksField(
  doc: ShellDocument,
  state: ShellState,
  options: {
    selected: readonly string[];
    executeApproved: boolean;
    disabled?: boolean;
    prefix: string;
    onToggle: (checkId: string, selected: boolean) => void;
  },
): ShellElement {
  const checks = state.describe?.checks ?? [];
  const legend = h(doc, "legend", {}, "Required host checks");
  const readiness = state.describe?.verification_readiness;
  const readinessLine = readiness
    ? [
        h(
          doc,
          "p",
          { class: "muted", "data-verification-readiness": readiness.status },
          readiness.status === "ready"
            ? "Protected checks run in a network-disabled sandbox"
            : `${readiness.reason}. ${readiness.setup ?? "Use Project → Set Up Verification Sandbox…"}`,
        ),
      ]
    : [];
  if (checks.length === 0) {
    return h(
      doc,
      "fieldset",
      { class: "checks-group", "data-host-checks": "none" },
      legend,
      ...readinessLine,
      h(
        doc,
        "p",
        { class: "muted" },
        "No host checks configured · the host records no verdict, so the result cannot be exported. Try Project → Open Verification Example to see a protected check.",
      ),
    );
  }
  const chosen = checks.filter((check) => options.selected.includes(check.id));
  const atLimit = chosen.length >= MAX_REQUIRED_CHECKS;
  return h(
    doc,
    "fieldset",
    { class: "checks-group", "data-host-checks": "available" },
    legend,
    ...readinessLine,
    ...checks.map((check) =>
      checkboxField(doc, {
        label: check.label,
        checked: options.executeApproved && options.selected.includes(check.id),
        disabled:
          Boolean(options.disabled) ||
          !options.executeApproved ||
          (atLimit && !options.selected.includes(check.id)),
        dataKey: `${options.prefix}-check-${check.id}`,
        onChange: (checked) => options.onToggle(check.id, checked),
      }),
    ),
    h(
      doc,
      "p",
      { class: "muted" },
      !options.executeApproved
        ? "Host checks run commands in the sandbox; approve Execute to select them."
        : atLimit
          ? `At most ${MAX_REQUIRED_CHECKS} checks per launch; clear one to choose another.`
          : chosen.length === 0
            ? "No checks selected · the host records no verdict, so the result cannot be exported."
            : `The host verifies the result against: ${chosen.map((check) => check.label).join(", ")}.`,
    ),
  );
}

function checkboxField(
  doc: ShellDocument,
  options: {
    label: string;
    checked: boolean;
    disabled?: boolean;
    dataKey: string;
    onChange: (checked: boolean) => void;
  },
): ShellElement {
  const input = h(doc, "input", {
    type: "checkbox",
    checked: options.checked,
    disabled: Boolean(options.disabled),
    "data-control": options.dataKey,
  });
  input.checked = options.checked;
  input.disabled = Boolean(options.disabled);
  input.addEventListener("change", (event) => {
    const next = (event.target as { checked?: boolean } | undefined)?.checked;
    options.onChange(Boolean(next));
  });
  return h(
    doc,
    "label",
    { class: `checkbox-label${options.disabled ? " muted" : ""}` },
    input,
    ` ${options.label}`,
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
          "data-focus-key": `task:${task.task_id}`,
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
  verificationError: string | undefined,
): ShellElement {
  if (!task)
    return h(
      doc,
      "header",
      { class: "task-header" },
      h(doc, "h1", HEADING_ATTRS, "No task selected"),
      h(
        doc,
        "p",
        {},
        "Select a session or compose a new task below to get started.",
      ),
    );
  const candidateRevision =
    verification?.candidate?.revision ?? "not available";
  const verificationClass = verificationError
    ? "verification verification-unavailable"
    : `verification verification-${verification?.state ?? "unverified"}`;
  const verificationLabel = verificationError
    ? "Verification unavailable"
    : VERIFICATION_LABEL[verification?.state ?? "unverified"];
  return h(
    doc,
    "header",
    { class: "task-header" },
    h(doc, "p", { class: "eyebrow" }, "02 / WORKSPACE"),
    h(doc, "h1", HEADING_ATTRS, "Task overview"),
    h(doc, "p", { class: "task-identifier" }, `Task ${task.task_id}`),
    h(
      doc,
      "div",
      { class: "task-meta" },
      h(doc, "span", { class: verificationClass }, verificationLabel),
      status(doc, task),
      h(
        doc,
        "span",
        { class: "meta-value" },
        `Candidate revision: ${candidateRevision}`,
      ),
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

function approvalAndLifecycleCard(
  doc: ShellDocument,
  state: ShellState,
): ShellElement | null {
  const task = state.selectedTask;
  const launch = state.launch;
  if (!task || !launch) return null;

  const canExecute = Boolean(state.describe?.capabilities.execute);
  const notice = launch.actionNotice
    ? h(doc, "p", { class: "action-notice" }, launch.actionNotice)
    : null;
  const error = launch.actionError
    ? h(doc, "p", { class: "error", role: "alert" }, launch.actionError)
    : null;

  if (task.status === "pending") {
    const keyMissing =
      state.assistant?.canConfigure && !state.assistant.configured;
    const modelHelp =
      launch.modelUnavailable && keyMissing
        ? h(
            doc,
            "button",
            {
              type: "button",
              class: "connect-action",
              "data-focus-key": "task-add-key",
            },
            "Add OpenRouter API key",
          )
        : null;
    modelHelp?.addEventListener("click", () => {
      state.assistant?.onSettings?.();
    });
    const modelSelect = h(
      doc,
      "select",
      {
        class: "model-select",
        "aria-label": "Model selection",
        "data-control": "launch-model",
      },
      h(
        doc,
        "option",
        { value: "default", selected: launch.modelChoice === "default" },
        "Host default model (no extra cost)",
      ),
      h(
        doc,
        "option",
        { value: "paid", selected: launch.modelChoice === "paid" },
        `Paid frontier model (${launch.paidModelId})`,
      ),
    );
    modelSelect.value = launch.modelChoice;
    modelSelect.addEventListener("change", (event) => {
      const value = (event.target as { value?: string } | undefined)?.value;
      state.onLaunchChange?.({
        modelChoice: value === "paid" ? "paid" : "default",
        paidModelConsent: false,
      });
    });

    const paidConsentNeeded = launch.modelChoice === "paid";
    const paidModelInput = paidConsentNeeded
      ? h(doc, "input", {
          type: "text",
          class: "paid-model-input",
          value: launch.paidModelId,
          placeholder: "Host-configured paid model ID",
          disabled: launch.busy,
          "aria-label": "Paid model ID",
          "data-control": "launch-paid-model-id",
          "data-focus-key": "launch-paid-model-id",
        })
      : null;
    if (paidModelInput) {
      paidModelInput.value = launch.paidModelId;
      paidModelInput.disabled = launch.busy;
      paidModelInput.addEventListener("input", (event) => {
        const next =
          (event.target as { value?: string } | undefined)?.value ?? "";
        state.onLaunchChange?.({
          paidModelId: next,
          paidModelConsent: false,
        });
      });
    }
    const trimmedPaidModelId = launch.paidModelId.trim();
    const paidConsentBox = paidConsentNeeded
      ? h(
          doc,
          "div",
          { class: "consent-card", "data-card": "paid-model-consent" },
          h(doc, "strong", {}, "Paid-model consent required"),
          h(
            doc,
            "label",
            { class: "paid-model-label" },
            "Model ID ",
            paidModelInput,
          ),
          h(
            doc,
            "p",
            { class: "muted" },
            `Launching with ${trimmedPaidModelId || "a paid model"} may incur metered model charges within the task budget ($${task.budget.max_usd}).`,
          ),
          checkboxField(doc, {
            label: "I consent to paid model usage for this task",
            checked: launch.paidModelConsent,
            disabled: launch.busy || trimmedPaidModelId.length === 0,
            dataKey: "launch-paid-consent",
            onChange: (checked) =>
              state.onLaunchChange?.({ paidModelConsent: checked }),
          }),
        )
      : null;

    const startBlocked =
      launch.busy ||
      (paidConsentNeeded &&
        (!launch.paidModelConsent || trimmedPaidModelId.length === 0));
    const startBtn = h(
      doc,
      "button",
      {
        type: "button",
        class: "primary-btn",
        disabled: startBlocked,
        "data-action": "start-task",
      },
      launch.busy ? "Starting…" : "Approve & start task",
    );
    startBtn.disabled = startBlocked;
    startBtn.addEventListener("click", () => state.onStartTask?.());

    const cancelBtn = h(
      doc,
      "button",
      {
        type: "button",
        class: "danger-btn",
        disabled: launch.busy,
        "data-action": "cancel-task",
      },
      "Cancel task",
    );
    cancelBtn.disabled = launch.busy;
    cancelBtn.addEventListener("click", () => state.onCancelTask?.());

    return h(
      doc,
      "section",
      { class: "action-card", "data-card": "approval-card" },
      heading(doc, "Approvals & Launch Consent"),
      h(
        doc,
        "fieldset",
        { class: "approvals-group" },
        h(doc, "legend", {}, "Independent capability approvals"),
        checkboxField(doc, {
          label: "Read workspace",
          checked: launch.approvals.read,
          dataKey: "approval-read",
          onChange: (checked) =>
            state.onLaunchApprovalChange?.("read", checked),
        }),
        checkboxField(doc, {
          label: "Write workspace",
          checked: launch.approvals.write,
          dataKey: "approval-write",
          onChange: (checked) =>
            state.onLaunchApprovalChange?.("write", checked),
        }),
        checkboxField(doc, {
          label: canExecute
            ? "Execute commands"
            : "Execute commands (disabled by host)",
          checked: canExecute && launch.approvals.execute,
          disabled: !canExecute,
          dataKey: "approval-execute",
          onChange: (checked) =>
            state.onLaunchApprovalChange?.("execute", checked),
        }),
      ),
      hostChecksField(doc, state, {
        selected: launch.checkIds,
        executeApproved: canExecute && launch.approvals.execute,
        disabled: launch.busy,
        prefix: "launch",
        onToggle: (checkId, checked) =>
          state.onLaunchCheckChange?.(checkId, checked),
      }),
      h(
        doc,
        "div",
        { class: "model-row" },
        h(doc, "label", {}, h(doc, "span", {}, "Model"), modelSelect),
      ),
      paidConsentBox,
      h(doc, "div", { class: "action-buttons" }, startBtn, cancelBtn),
      notice,
      modelHelp ? null : error,
      modelHelp
        ? h(
            doc,
            "div",
            { class: "connect-notice", role: "alert" },
            h(
              doc,
              "p",
              {},
              "No OpenRouter key is configured. Add a key to start this task.",
            ),
            modelHelp,
            state.settingsError
              ? h(doc, "p", { class: "error" }, state.settingsError)
              : null,
          )
        : null,
    );
  }

  if (task.status === "paused") {
    const resumeBtn = h(
      doc,
      "button",
      {
        type: "button",
        class: "primary-btn",
        disabled: launch.busy,
        "data-action": "resume-task",
      },
      launch.busy ? "Resuming…" : "Resume task",
    );
    resumeBtn.disabled = launch.busy;
    resumeBtn.addEventListener("click", () => state.onResumeTask?.());

    const cancelBtn = h(
      doc,
      "button",
      {
        type: "button",
        class: "danger-btn",
        disabled: launch.busy,
        "data-action": "cancel-task",
      },
      "Cancel task",
    );
    cancelBtn.disabled = launch.busy;
    cancelBtn.addEventListener("click", () => state.onCancelTask?.());

    return h(
      doc,
      "section",
      { class: "action-card", "data-card": "lifecycle-card" },
      heading(doc, "Task Controls"),
      h(doc, "div", { class: "action-buttons" }, resumeBtn, cancelBtn),
      notice,
      error,
    );
  }

  if (task.status === "running") {
    const steerInput = h(doc, "input", {
      type: "text",
      class: "steer-input",
      placeholder: "Send steering instruction to running task…",
      value: launch.steerDraft,
      "aria-label": "Steer instruction",
      "data-control": "steer-input",
    });
    steerInput.value = launch.steerDraft;
    steerInput.addEventListener("input", (event) => {
      const next =
        (event.target as { value?: string } | undefined)?.value ?? "";
      state.onLaunchChange?.({ steerDraft: next });
    });

    const steerBtn = h(
      doc,
      "button",
      {
        type: "button",
        class: "primary-btn",
        disabled: launch.busy,
        "data-action": "steer-task",
      },
      "Steer task",
    );
    steerBtn.disabled = launch.busy;
    steerBtn.addEventListener("click", () => {
      const text = (steerInput.value ?? launch.steerDraft).trim();
      if (text) state.onSteerTask?.(text);
    });

    const cancelBtn = h(
      doc,
      "button",
      {
        type: "button",
        class: "danger-btn",
        disabled: launch.busy,
        "data-action": "cancel-task",
      },
      "Cancel task",
    );
    cancelBtn.disabled = launch.busy;
    cancelBtn.addEventListener("click", () => state.onCancelTask?.());

    return h(
      doc,
      "section",
      { class: "action-card", "data-card": "lifecycle-card" },
      heading(doc, "Active Task Controls"),
      h(doc, "div", { class: "steer-row" }, steerInput, steerBtn, cancelBtn),
      notice,
      error,
    );
  }

  if (notice || error) {
    return h(
      doc,
      "section",
      { class: "action-card", "data-card": "lifecycle-notice" },
      notice,
      error,
    );
  }
  return null;
}

function promptComposer(
  doc: ShellDocument,
  state: ShellState,
): ShellElement | null {
  const composer = state.composer;
  if (!composer) return null;

  const canExecute = Boolean(state.describe?.capabilities.execute);
  const requestInput = h(doc, "textarea", {
    class: "composer-textarea",
    rows: "3",
    placeholder: "What would you like the agent to do?",
    "aria-label": "Task prompt",
    "data-control": "composer-request",
    "data-focus-key": "composer-request",
  });
  requestInput.value = composer.request;
  requestInput.addEventListener("input", (event) => {
    const next = (event.target as { value?: string } | undefined)?.value ?? "";
    state.onComposerChange?.({ request: next });
  });

  const criteriaInput = h(doc, "input", {
    type: "text",
    class: "composer-criteria",
    placeholder: "Optional acceptance criteria (comma-separated)",
    value: composer.criteria,
    "aria-label": "Acceptance criteria",
    "data-control": "composer-criteria",
  });
  criteriaInput.value = composer.criteria;
  criteriaInput.addEventListener("input", (event) => {
    const next = (event.target as { value?: string } | undefined)?.value ?? "";
    state.onComposerChange?.({ criteria: next });
  });

  const modelSelect = h(
    doc,
    "select",
    {
      class: "model-select",
      disabled: composer.submitting,
      "aria-label": "Composer model",
      "data-control": "composer-model",
    },
    h(
      doc,
      "option",
      { value: "default", selected: composer.modelChoice === "default" },
      "Host default model",
    ),
    h(
      doc,
      "option",
      { value: "paid", selected: composer.modelChoice === "paid" },
      `Paid model (${composer.paidModelId})`,
    ),
  );
  modelSelect.value = composer.modelChoice;
  modelSelect.disabled = composer.submitting;
  modelSelect.addEventListener("change", (event) => {
    const value = (event.target as { value?: string } | undefined)?.value;
    state.onComposerChange?.({
      modelChoice: value === "paid" ? "paid" : "default",
      paidModelConsent: false,
    });
  });

  const paidConsentNeeded =
    composer.startNow && composer.modelChoice === "paid";
  const composerPaidModelInput = paidConsentNeeded
    ? h(doc, "input", {
        type: "text",
        class: "paid-model-input",
        value: composer.paidModelId,
        placeholder: "Host-configured paid model ID",
        disabled: composer.submitting,
        "aria-label": "Composer paid model ID",
        "data-control": "composer-paid-model-id",
        "data-focus-key": "composer-paid-model-id",
      })
    : null;
  if (composerPaidModelInput) {
    composerPaidModelInput.value = composer.paidModelId;
    composerPaidModelInput.disabled = composer.submitting;
    composerPaidModelInput.addEventListener("input", (event) => {
      const next =
        (event.target as { value?: string } | undefined)?.value ?? "";
      state.onComposerChange?.({
        paidModelId: next,
        paidModelConsent: false,
      });
    });
  }
  const trimmedComposerPaidModelId = composer.paidModelId.trim();
  const paidConsent = paidConsentNeeded
    ? h(
        doc,
        "div",
        { class: "consent-card", "data-card": "composer-paid-consent" },
        h(
          doc,
          "label",
          { class: "paid-model-label" },
          "Model ID ",
          composerPaidModelInput,
        ),
        checkboxField(doc, {
          label: `I consent to paid model usage (${trimmedComposerPaidModelId || "paid model"})`,
          checked: composer.paidModelConsent,
          disabled:
            composer.submitting || trimmedComposerPaidModelId.length === 0,
          dataKey: "composer-paid-consent",
          onChange: (checked) =>
            state.onComposerChange?.({ paidModelConsent: checked }),
        }),
      )
    : null;

  const submitDisabled =
    composer.submitting ||
    (paidConsentNeeded &&
      (!composer.paidModelConsent || trimmedComposerPaidModelId.length === 0));
  const submitBtn = h(
    doc,
    "button",
    {
      type: "button",
      class: "primary-btn",
      disabled: submitDisabled,
      "data-action": "create-task",
    },
    composer.submitting
      ? "Submitting…"
      : composer.startNow
        ? "Create & launch task"
        : "Create task",
  );
  submitBtn.disabled = submitDisabled;
  submitBtn.addEventListener("click", () => state.onCreateTask?.());

  return h(
    doc,
    "section",
    { class: "composer-card", "data-panel": "prompt-composer" },
    h(doc, "p", { class: "eyebrow" }, "NEW TASK"),
    heading(doc, "Give your agent a task"),
    requestInput,
    criteriaInput,
    h(
      doc,
      "div",
      { class: "composer-options" },
      checkboxField(doc, {
        label: "Start immediately",
        checked: composer.startNow,
        dataKey: "composer-start-now",
        onChange: (checked) => state.onComposerChange?.({ startNow: checked }),
      }),
      composer.startNow
        ? checkboxField(doc, {
            label: "Read",
            checked: composer.approvals.read,
            dataKey: "composer-read",
            onChange: (checked) =>
              state.onComposerApprovalChange?.("read", checked),
          })
        : null,
      composer.startNow
        ? checkboxField(doc, {
            label: "Write",
            checked: composer.approvals.write,
            dataKey: "composer-write",
            onChange: (checked) =>
              state.onComposerApprovalChange?.("write", checked),
          })
        : null,
      composer.startNow
        ? checkboxField(doc, {
            label: canExecute ? "Execute" : "Execute (off)",
            checked: canExecute && composer.approvals.execute,
            disabled: !canExecute,
            dataKey: "composer-execute",
            onChange: (checked) =>
              state.onComposerApprovalChange?.("execute", checked),
          })
        : null,
      composer.startNow ? modelSelect : null,
    ),
    composer.startNow || state.describe?.verification_readiness
      ? hostChecksField(doc, state, {
          selected: composer.checkIds,
          executeApproved: canExecute && composer.approvals.execute,
          disabled: composer.submitting || !composer.startNow,
          prefix: "composer",
          onToggle: (checkId, checked) =>
            state.onComposerCheckChange?.(checkId, checked),
        })
      : null,
    paidConsent,
    h(doc, "div", { class: "action-buttons" }, submitBtn),
    composer.error
      ? h(doc, "p", { class: "error", role: "alert" }, composer.error)
      : null,
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
    h(
      doc,
      "h2",
      {
        tabindex: "-1",
        "data-inspector-heading": "true",
        "data-focus-key": "inspector-heading",
      },
      "Task",
    ),
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
  error: string | undefined,
): ShellElement {
  if (error)
    return h(
      doc,
      "section",
      { class: "inspector-section" },
      heading(doc, "Verification"),
      unavailable(doc, error),
    );
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

function changesSection(doc: ShellDocument, state: ShellState): ShellElement {
  const diff = state.diff;
  const error = state.diffError;
  const verification = state.verification;
  const exportState = state.patchExport;

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
      disclosure(
        doc,
        "patch-details",
        `patch:${file.path}`,
        "Patch",
        untrusted(doc, file.patch, "workspace diff"),
      ),
    );
  });

  const canExport =
    verification?.state === "verified" &&
    Boolean(verification.candidate?.revision) &&
    Boolean(verification.patch_sha256) &&
    (diff?.files.length ?? 0) > 0;

  let exportBox: ShellElement | null = null;
  if (state.selectedTask && !error && (diff?.files.length ?? 0) > 0) {
    const exportBtn = h(
      doc,
      "button",
      {
        type: "button",
        class: "primary-btn export-btn",
        disabled: !canExport || Boolean(exportState?.busy),
        "data-action": "export-patch",
      },
      exportState?.busy ? "Exporting…" : "Export verified patch",
    );
    exportBtn.disabled = !canExport || Boolean(exportState?.busy);
    exportBtn.addEventListener("click", () => state.onExportPatch?.());

    exportBox = h(
      doc,
      "div",
      { class: "export-card", "data-card": "patch-export" },
      h(doc, "strong", {}, "Verified Patch Export"),
      canExport
        ? h(
            doc,
            "p",
            { class: "muted" },
            `Revision ${verification?.candidate?.revision} · sha256 ${verification?.patch_sha256}`,
          )
        : h(
            doc,
            "p",
            { class: "muted" },
            "Host verification must be Verified before exporting a patch.",
          ),
      exportBtn,
      exportState?.error
        ? h(doc, "p", { class: "error", role: "alert" }, exportState.error)
        : null,
      exportState?.result
        ? h(
            doc,
            "div",
            { class: "export-result", "data-export-verified": "true" },
            h(
              doc,
              "p",
              { class: "action-notice" },
              `Exported ${exportState.result.artifact.artifact_id} (${exportState.result.artifact.byte_length} bytes · sha256 verified)`,
            ),
            h(
              doc,
              "small",
              { class: "digest" },
              `sha256 ${exportState.result.patch_sha256}`,
            ),
            exportState.patchText
              ? disclosure(
                  doc,
                  "patch-details",
                  `export:${exportState.result.patch_sha256}`,
                  "Verified exported patch",
                  untrusted(
                    doc,
                    exportState.patchText,
                    `exported patch · sha256 verified`,
                  ),
                )
              : null,
          )
        : null,
    );
  }

  return h(
    doc,
    "section",
    { class: "inspector-section" },
    heading(doc, "Changes"),
    ...(error
      ? [unavailable(doc, error)]
      : files.length
        ? [...files, exportBox]
        : [h(doc, "p", {}, "No diff files.")]),
  );
}

function evidenceSection(
  doc: ShellDocument,
  evidence: EvidenceResult | undefined,
  error: string | undefined,
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
        `${record.verdict} · ${record.verified ? "verified" : "not verified"} · ${record.stale ? "stale" : "current"}${record.binding_error ? ` · binding unavailable (${record.binding_error})` : ""} · ${record.recorded_at}`,
      ),
    ),
  );
  return h(
    doc,
    "section",
    { class: "inspector-section" },
    heading(doc, "Evidence"),
    ...(error
      ? [unavailable(doc, error)]
      : records.length
        ? records
        : [h(doc, "p", {}, "No evidence records.")]),
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
  const masthead = h(
    doc,
    "header",
    { class: "masthead" },
    h(doc, "span", { class: "masthead-dots", "aria-hidden": "true" }),
    h(doc, "span", { class: "masthead-title" }, "MARS"),
    h(doc, "span", { class: "masthead-subtitle" }, "Your mission control"),
  );
  if (state.error && !state.assistant) {
    const retry = h(
      doc,
      "button",
      { class: "retry", type: "button", "data-focus-key": REFRESH_FOCUS_KEY },
      "Retry",
    );
    retry.addEventListener("click", () => state.onRefresh?.());
    return h(
      doc,
      "div",
      {},
      masthead,
      h(
        doc,
        "main",
        { class: "connection-error", role: "alert" },
        h(doc, "h1", HEADING_ATTRS, "MARS"),
        h(doc, "p", {}, state.error),
        retry,
      ),
    );
  }
  if (state.error) {
    const retry = h(
      doc,
      "button",
      { type: "button", class: "retry", "data-focus-key": "workbench-retry" },
      "Retry",
    );
    retry.addEventListener("click", () => state.onRefresh?.());
    masthead.append(
      h(
        doc,
        "span",
        { class: "workspace-alert", role: "alert" },
        `Workbench unavailable: ${state.error}`,
      ),
      retry,
    );
  }
  const task = state.selectedTask;
  const navButton = (
    text: string,
    selected: boolean,
    callback: () => void,
    className = "nav-item",
    disabled = false,
  ) => {
    const button = h(
      doc,
      "button",
      {
        type: "button",
        class: `${className}${selected ? " selected" : ""}`,
        ...(className === "details-toggle"
          ? { "data-focus-key": "task-details" }
          : {}),
        "aria-pressed": String(selected),
        disabled,
      },
      text,
    );
    button.addEventListener("click", callback);
    return button;
  };
  const isChat = state.page === "chat" && !state.teamChat?.open;
  const refresh = h(
    doc,
    "button",
    { class: "refresh", type: "button", "data-focus-key": REFRESH_FOCUS_KEY },
    "Refresh",
  );
  refresh.addEventListener("click", () => state.onRefresh?.());

  const teamChatAvailable = Boolean(state.teamChat?.available);
  const unreadTotal = (state.teamChat?.conversations ?? []).reduce(
    (sum, conv) => sum + conv.unread_count,
    0,
  );
  const teamChatBtn = h(
    doc,
    "button",
    {
      type: "button",
      class: `team-chat-toggle${state.teamChat?.open ? " selected" : ""}`,
      disabled: !teamChatAvailable,
      "aria-disabled": teamChatAvailable ? "false" : "true",
      "aria-pressed": state.teamChat?.open ? "true" : "false",
      "data-action": "toggle-team-chat",
      "data-focus-key": "team-chat-toggle",
    },
    unreadTotal > 0 ? `Team chat (${unreadTotal})` : "Team chat",
  );
  teamChatBtn.disabled = !teamChatAvailable;
  teamChatBtn.addEventListener("click", () => state.onOpenTeamChat?.());

  const destination = (id: WorkspacePage, label: string) => {
    const el = navButton(
      label,
      (state.page ?? "tasks") === id && !state.teamChat?.open,
      () => state.onPage?.(id),
    );
    el.setAttribute("data-focus-key", `nav-${id}`);
    el.setAttribute("data-page", id);
    return el;
  };
  const sidebar = h(
    doc,
    "nav",
    { class: "sidebar", "aria-label": "Sidebar", "data-scroll-key": "sidebar" },
    h(
      doc,
      "div",
      { class: "brand-row" },
      h(doc, "span", { class: "brand-orbit", "aria-hidden": "true" }),
      h(doc, "h1", { class: "brand" }, "MARS"),
      h(doc, "span", { class: "brand-tag" }, "YOUR IDEAS. IN ORBIT."),
    ),
    h(
      doc,
      "div",
      { class: "workspace-switcher" },
      h(doc, "span", { class: "workspace-label" }, "WORKSPACE"),
      h(doc, "strong", {}, state.describe?.workspaceLabel ?? "Local workspace"),
    ),
    state.assistant ? destination("chat", "Chat") : null,
    destination("tasks", "Tasks"),
    state.assistant ? destination("extensions", "Extensions") : null,
    state.assistant ? destination("settings", "Settings") : null,
    h(
      doc,
      "div",
      { class: "sidebar-history", "data-scroll-key": "sidebar-history" },
      ...(isChat && state.assistant
        ? [
            h(doc, "h2", { class: "sidebar-label" }, "Conversations"),
            navButton(
              "+  New conversation",
              false,
              () => state.assistant?.onNew?.(),
              "new-conversation",
              state.assistant.busy,
            ),
            ...state.assistant.sessions.map((session) =>
              navButton(
                session.title,
                session.id === state.assistant?.activeId,
                () => state.assistant?.onSelect?.(session.id),
                "conversation-item",
                state.assistant?.busy,
              ),
            ),
            ...(state.assistant.unsentIds ?? []).map((id, index) =>
              navButton(
                `Unsent draft ${index + 1}`,
                false,
                () => state.assistant?.onSelect?.(id),
                "conversation-item",
                state.assistant?.busy,
              ),
            ),
          ]
        : (!state.page || state.page === "tasks") && !state.teamChat?.open
          ? [
              h(doc, "h2", { class: "sidebar-label" }, "Agent sessions"),
              ...taskList(doc, state.tasks, task?.task_id, state.onSelect),
            ]
          : []),
    ),
    h(
      doc,
      "section",
      { class: "team-chat sidebar-bottom" },
      h(doc, "span", { class: "sidebar-label" }, "BETTER TOGETHER"),
      teamChatBtn,
      h(
        doc,
        "p",
        { class: "muted" },
        teamChatAvailable
          ? `${state.teamChat?.label === "FIXTURE" ? "Local demo" : "Team workspace"} · ${state.teamChat?.conversations.length ?? 0} conversation${state.teamChat?.conversations.length === 1 ? "" : "s"}`
          : "team chat unavailable",
      ),
    ),
  );

  const main =
    state.teamChat?.open && state.teamChat.available
      ? h(
          doc,
          "main",
          { class: "main", "data-scroll-key": "team-main" },
          renderTeamChatPane(doc, state.teamChat),
        )
      : state.page === "settings" && state.assistant
        ? renderSettings(
            doc,
            state.assistant,
            state.settingsError,
            () => state.onPage?.("extensions"),
            () => state.onRefresh?.(),
            state.describe?.verification_readiness,
          )
        : state.page === "extensions"
          ? renderExtensions(doc, state.extensions)
          : isChat && state.assistant
            ? renderAssistant(doc, state.assistant)
            : h(
                doc,
                "main",
                {
                  class: "main",
                  "data-scroll-key": `main:${task?.task_id ?? ""}`,
                },
                h(
                  doc,
                  "div",
                  { class: "main-toolbar" },
                  taskHeader(
                    doc,
                    task,
                    state.verification,
                    state.verificationError,
                  ),
                  refresh,
                  navButton(
                    state.inspectorOpen ? "Hide details" : "Task details",
                    Boolean(state.inspectorOpen),
                    () => state.onToggleInspector?.(),
                    "details-toggle",
                  ),
                ),
                approvalAndLifecycleCard(doc, state),
                h(
                  doc,
                  "section",
                  {
                    class: "transcript",
                    "data-scroll-key": `transcript:${task?.task_id ?? ""}`,
                    role: "log",
                    "aria-live": "polite",
                  },
                  state.eventsError
                    ? unavailable(doc, state.eventsError)
                    : h(
                        doc,
                        "div",
                        { class: "transcript-entries" },
                        ...renderTranscript(
                          doc,
                          state.transcript,
                          state.events.length,
                          state.eventsCapped,
                        ),
                      ),
                ),
                promptComposer(doc, state),
              );

  const inspector = h(
    doc,
    "aside",
    {
      class: "inspector",
      "aria-label": "Task inspector",
      "data-scroll-key": `inspector:${task?.task_id ?? ""}`,
    },
    task
      ? taskInspector(doc, task)
      : h(
          doc,
          "section",
          {},
          heading(doc, "Task"),
          h(doc, "p", {}, "Select a task."),
        ),
    verificationSection(doc, state.verification, state.verificationError),
    changesSection(doc, state),
    evidenceSection(doc, state.evidence, state.evidenceError),
    artifactsSection(doc, state.artifacts),
  );

  const footer = h(
    doc,
    "footer",
    { class: "status-bar" },
    h(
      doc,
      "span",
      {},
      state.describe ? "Workbench online" : "Workbench offline",
    ),
    h(doc, "span", {}, state.describe?.workspaceLabel ?? "No workspace"),
    h(doc, "span", {}, "loopback"),
    h(doc, "span", {}, "interactive"),
    h(
      doc,
      "span",
      {},
      `execute: ${state.describe?.capabilities.execute ? "on" : "off"}`,
    ),
    state.teamChat?.label
      ? h(doc, "span", {}, `team chat: ${state.teamChat.label}`)
      : null,
  );

  return h(
    doc,
    "div",
    {
      class: `app-shell${!state.error ? " clean-chrome" : ""}${isChat || state.page === "extensions" || state.page === "settings" || state.teamChat?.open || !state.inspectorOpen ? " inspector-hidden" : ""}`,
    },
    masthead,
    sidebar,
    h(
      doc,
      "div",
      { class: "workspace-panels", "data-scroll-key": "workspace" },
      main,
      inspector,
    ),
    footer,
  );
}
