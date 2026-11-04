import type {
  ShellDocument,
  ShellElement,
  ShellText,
} from "../src/renderer/dom";

export class MiniText implements ShellText {
  constructor(readonly textContent: string) {}
}

export class MiniElement implements ShellElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: (MiniElement | MiniText)[] = [];
  private readonly listeners = new Map<
    string,
    ((event: { target?: unknown }) => void)[]
  >();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get textContent(): string {
    return this.children.map((child) => child.textContent ?? "").join("");
  }

  set textContent(value: string | null) {
    this.children.length = 0;
    if (value) this.children.push(new MiniText(value));
  }

  get innerHTML(): string {
    throw new Error("HTML serialization is disabled.");
  }

  set innerHTML(_value: string) {
    throw new Error("HTML serialization is disabled.");
  }

  get outerHTML(): string {
    throw new Error("HTML serialization is disabled.");
  }

  set outerHTML(_value: string) {
    throw new Error("HTML serialization is disabled.");
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  append(...nodes: (ShellElement | ShellText)[]): void {
    this.children.push(...(nodes as (MiniElement | MiniText)[]));
  }

  replaceChildren(...nodes: (ShellElement | ShellText)[]): void {
    this.children.splice(
      0,
      this.children.length,
      ...(nodes as (MiniElement | MiniText)[]),
    );
  }

  addEventListener(
    type: string,
    listener: (event: { target?: unknown }) => void,
  ): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  insertAdjacentHTML(): never {
    throw new Error("HTML serialization is disabled.");
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? [])
      listener({ target: this });
  }
}

export class MiniDocument implements ShellDocument {
  readonly root = new MiniElement("div");

  constructor() {
    this.root.setAttribute("id", "app");
  }

  createElement(tagName: string): ShellElement {
    return new MiniElement(tagName);
  }

  createTextNode(text: string): ShellText {
    return new MiniText(text);
  }

  getElementById(id: string): ShellElement | null {
    const visit = (element: MiniElement): MiniElement | null => {
      if (element.getAttribute("id") === id) return element;
      for (const child of element.children) {
        if (child instanceof MiniElement) {
          const found = visit(child);
          if (found) return found;
        }
      }
      return null;
    };
    return visit(this.root);
  }
}

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}

export function serialize(node: MiniElement | MiniText, depth = 0): string {
  const indentation = " ".repeat(depth);
  if (node instanceof MiniText)
    return `${indentation}${escapeText(node.textContent)}`;
  const attributes = [...node.attributes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
  const tag = node.tagName.toLowerCase();
  const open = `${indentation}<${tag}${attributes}>`;
  if (!node.children.some((child) => child instanceof MiniElement))
    return `${open}${node.children.map(serialize).join("")}</${tag}>`;
  return `${open}\n${node.children
    .map((child) => serialize(child, depth + 2))
    .join("\n")}\n${indentation}</${tag}>`;
}

export function findAll(
  root: MiniElement,
  predicate: (element: MiniElement) => boolean,
): MiniElement[] {
  const found: MiniElement[] = [];
  const visit = (element: MiniElement) => {
    if (predicate(element)) found.push(element);
    for (const child of element.children)
      if (child instanceof MiniElement) visit(child);
  };
  visit(root);
  return found;
}
