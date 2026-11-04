import { h, type ShellDocument, type ShellElement } from "./dom";

export function untrusted(
  doc: ShellDocument,
  text: string,
  provenance: string,
): ShellElement {
  return h(
    doc,
    "section",
    { class: "untrusted", "data-provenance": provenance, role: "note" },
    h(doc, "span", { class: "provenance" }, `untrusted · ${provenance}`),
    h(doc, "pre", { class: "untrusted-text" }, text),
  );
}
