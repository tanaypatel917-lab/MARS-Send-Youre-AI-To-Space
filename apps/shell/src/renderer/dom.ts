export interface ShellText {
  readonly textContent: string | null;
}

export interface ShellElement {
  readonly tagName: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  append(...nodes: (ShellElement | ShellText)[]): void;
  replaceChildren(...nodes: (ShellElement | ShellText)[]): void;
  addEventListener(
    type: string,
    listener: (event: { target?: unknown }) => void,
  ): void;
}

export interface ShellDocument {
  createElement(tagName: string): ShellElement;
  createTextNode(text: string): ShellText;
  getElementById(id: string): ShellElement | null;
}

type AttributeValue = string | boolean;
type Child = ShellElement | ShellText | string | number | null | undefined;

const TAGS = new Set([
  "article",
  "aside",
  "button",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "footer",
  "header",
  "h1",
  "h2",
  "h3",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "small",
  "span",
  "strong",
  "summary",
  "time",
  "ul",
]);

const FORBIDDEN_ATTRIBUTES =
  /^(?:on.*|style|srcdoc|href|src|action|formaction)$/i;

export function h(
  doc: ShellDocument,
  tag: string,
  attrs: Record<string, AttributeValue> | undefined,
  ...children: Child[]
): ShellElement {
  if (!TAGS.has(tag)) throw new Error("Unsupported element.");
  const element = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (FORBIDDEN_ATTRIBUTES.test(name))
      throw new Error("Unsupported attribute.");
    if (value === false) continue;
    element.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    element.append(
      typeof child === "string" || typeof child === "number"
        ? doc.createTextNode(String(child))
        : child,
    );
  }
  return element;
}
