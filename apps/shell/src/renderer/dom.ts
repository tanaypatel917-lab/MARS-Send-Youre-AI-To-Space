export interface ShellText {
  readonly textContent: string | null;
}

export interface ShellElement {
  readonly tagName: string;
  textContent: string | null;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  selectionDirection?: "forward" | "backward" | "none" | null;
  setSelectionRange?(
    start: number,
    end: number,
    direction?: "forward" | "backward" | "none",
  ): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  append(...nodes: (ShellElement | ShellText)[]): void;
  replaceChildren(...nodes: (ShellElement | ShellText)[]): void;
  querySelectorAll(selectors: string): ArrayLike<ShellElement>;
  focus(): void;
  addEventListener(
    type: string,
    listener: (event: {
      target?: unknown;
      preventDefault?: () => void;
    }) => void,
  ): void;
}

export interface ShellDocument {
  readonly activeElement: ShellElement | null;
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
  "fieldset",
  "footer",
  "form",
  "header",
  "h1",
  "h2",
  "h3",
  "input",
  "label",
  "legend",
  "li",
  "main",
  "nav",
  "ol",
  "option",
  "p",
  "pre",
  "section",
  "select",
  "small",
  "span",
  "strong",
  "summary",
  "textarea",
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
