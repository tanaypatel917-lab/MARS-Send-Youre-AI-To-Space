import { expect, test } from "bun:test";
import { h } from "../src/renderer/dom";
import { MiniDocument } from "./mini-dom";

test("the DOM helper accepts only safe elements and attributes", () => {
  const document = new MiniDocument();
  expect(() => h(document, "script", {}, "alert(1)")).toThrow(
    "Unsupported element.",
  );
  for (const attribute of [
    "onclick",
    "onerror",
    "style",
    "srcdoc",
    "href",
    "src",
    "action",
    "formaction",
  ])
    expect(() => h(document, "span", { [attribute]: "untrusted" })).toThrow(
      "Unsupported attribute.",
    );
  expect(
    h(document, "span", { "aria-label": "safe" }, "<text>").textContent,
  ).toBe("<text>");
});
