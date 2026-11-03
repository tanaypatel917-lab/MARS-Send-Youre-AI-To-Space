/// <reference lib="dom" />
import type {
  FollowUp,
  OutputSegment,
  ReviewLink,
  Task,
  WritingBlock,
} from "@mars/contracts";
import type { WebviewMessage } from "../messages";
import { button, h } from "./dom";
import {
  blockErrors,
  buildOutputView,
  type OutputView,
  tonePreamble,
  withinSpan,
} from "./outputView";

type Post = (message: WebviewMessage) => void;

/**
 * Renders the model's final text as MARS Output Format. Model text only ever
 * becomes text nodes; follow-ups, review links and app triggers are shown
 * with their hidden target and act only on an explicit click, which the host
 * confirms or validates again.
 */
export function renderOutput(task: Task, text: string, post: Post): Node[] {
  const view = buildOutputView(text, task);
  const taskId = task.task_id;
  const nodes: Node[] = [];
  let followUps: FollowUp[] = [];
  const flushFollowUps = () => {
    if (followUps.length === 0) return;
    const row = h("div", { class: "row follow-ups" });
    for (const [index, item] of followUps.entries())
      row.append(
        button(
          item.label,
          `followup-${item.span.start_line}-${index}`,
          () => post({ type: "followUp", taskId, prompt: item.prompt }),
          { secondary: true, title: item.prompt },
        ),
      );
    nodes.push(
      h(
        "p",
        { class: "muted small" },
        "Suggested follow-ups (confirmed before sending):",
      ),
      row,
    );
    followUps = [];
  };
  for (const segment of view.segments) {
    if (segment.kind === "follow_up") {
      followUps.push(segment);
      continue;
    }
    flushFollowUps();
    nodes.push(
      segment.kind === "writing"
        ? renderWriting(taskId, segment, view, post)
        : renderMarkdown(taskId, segment, view, post),
    );
  }
  flushFollowUps();
  if (view.errors.length > 0) {
    const list = h("ul", { class: "muted small" });
    for (const error of view.errors)
      list.append(
        h(
          "li",
          {},
          `line ${error.line}${error.block_id ? ` (block ${error.block_id})` : ""}: ${error.code} — ${error.message}`,
        ),
      );
    nodes.push(h("p", { class: "muted small" }, "Format errors:"), list);
  }
  return nodes;
}

function renderMarkdown(
  taskId: string,
  segment: Extract<OutputSegment, { kind: "markdown" }>,
  view: OutputView,
  post: Post,
): HTMLElement {
  return h(
    "div",
    {},
    h("pre", { class: "artifact" }, segment.text),
    renderLinkActions(taskId, segment.span, view, post),
  );
}

function renderWriting(
  taskId: string,
  block: WritingBlock,
  view: OutputView,
  post: Post,
): HTMLElement {
  const header = h(
    "div",
    { class: "row" },
    h("span", { class: "badge" }, block.variant),
    h("span", { class: "muted mono small" }, `id ${block.id}`),
    h("span", { class: "grow" }),
    button(
      "Copy",
      `copy-${block.id}`,
      () => post({ type: "copyText", text: block.body }),
      { secondary: true, title: "Copy the block body to the clipboard" },
    ),
  );
  const panel = h("section", { class: "panel writing" }, header);
  if (block.email) {
    const email = block.email;
    const fields: Array<[string, string]> = [
      ["Subject", email.subject ?? ""],
      ["To", email.recipient.join(", ")],
      ["Cc", email.cc.join(", ")],
      ["Bcc", email.bcc.join(", ")],
    ];
    for (const [name, value] of fields)
      if (value)
        panel.append(
          h("div", { class: "small" }, h("strong", {}, `${name}: `), value),
        );
  }
  const errors = blockErrors(view.errors, block.id);
  if (errors.length > 0) {
    const list = h("ul", { class: "muted small" });
    for (const error of errors)
      list.append(h("li", {}, `${error.code} — ${error.message}`));
    panel.append(list);
  }
  const preamble = tonePreamble(block);
  if (preamble !== null)
    panel.append(h("pre", { class: "artifact" }, preamble));
  if (block.tones.length > 0)
    for (const tone of block.tones)
      panel.append(
        h(
          "div",
          { class: "tone" },
          h("h4", {}, tone.tone),
          h("pre", { class: "artifact" }, tone.body),
        ),
      );
  else panel.append(h("pre", { class: "artifact" }, block.body));
  const actions = renderLinkActions(taskId, block.span, view, post);
  if (actions) panel.append(actions);
  return panel;
}

function renderLinkActions(
  taskId: string,
  span: WritingBlock["span"],
  view: OutputView,
  post: Post,
): HTMLElement | null {
  const reviews = withinSpan(view.reviews, span);
  const triggers = withinSpan(view.triggers, span);
  if (reviews.length === 0 && triggers.length === 0) return null;
  const row = h("div", { class: "row" });
  for (const item of reviews) row.append(renderReview(taskId, item, post));
  for (const trigger of triggers)
    row.append(
      button(
        `${trigger.label} (connector ${trigger.connector_id} not registered)`,
        `app-${trigger.line}`,
        () => {},
        {
          secondary: true,
          disabled: true,
          title: `app://${trigger.connector_id}`,
        },
      ),
    );
  return row;
}

function renderReview(
  taskId: string,
  item: { review: ReviewLink; blocked: string | null },
  post: Post,
): HTMLElement {
  const r = item.review;
  const target = `${r.path}:${r.line_start}-${r.line_end} (${r.side} side of ${r.pr})`;
  if (item.blocked)
    return h(
      "span",
      { class: "muted small", title: item.blocked },
      `${r.label} → ${target} [not opened: ${item.blocked}]`,
    );
  return button(
    `${r.label} → ${r.path}:${r.line_start}`,
    `review-${r.line}-${r.path}-${r.line_start}`,
    () =>
      post({
        type: "openReview",
        taskId,
        path: r.path,
        line_start: r.line_start,
        line_end: r.line_end,
        side: r.side,
        pr: r.pr,
      }),
    { secondary: true, title: `Open ${target}. The PR is not fetched.` },
  );
}
