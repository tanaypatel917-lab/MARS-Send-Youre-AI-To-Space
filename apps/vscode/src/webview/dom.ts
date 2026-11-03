/// <reference lib="dom" />

export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: {
    class?: string;
    key?: string;
    title?: string;
    role?: string;
    label?: string;
  } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.class) element.className = props.class;
  if (props.key) element.dataset.focusKey = props.key;
  if (props.title) element.title = props.title;
  if (props.role) element.setAttribute("role", props.role);
  if (props.label) element.setAttribute("aria-label", props.label);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(
      typeof child === "string" ? document.createTextNode(child) : child,
    );
  }
  return element;
}

export function button(
  text: string,
  key: string,
  onClick: () => void,
  options: {
    secondary?: boolean;
    disabled?: boolean;
    title?: string;
    danger?: boolean;
  } = {},
): HTMLButtonElement {
  const element = h("button", {
    class: [
      options.secondary ? "secondary" : "",
      options.danger ? "danger" : "",
    ]
      .join(" ")
      .trim(),
    key,
    ...(options.title ? { title: options.title } : {}),
  });
  element.type = "button";
  element.textContent = text;
  element.disabled = !!options.disabled;
  element.addEventListener("click", onClick);
  return element;
}
