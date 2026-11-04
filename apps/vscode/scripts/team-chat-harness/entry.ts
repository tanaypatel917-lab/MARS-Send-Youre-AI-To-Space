/// <reference lib="dom" />
import { controller, scenario } from "./stub";
import "../../src/webview/teamChat/main";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

async function waitFor<T extends Element>(selector: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const found = document.querySelector<T>(selector);
    if (found) return found;
    await tick();
  }
  throw new Error(`harness: ${selector} never appeared`);
}

async function click(selector: string): Promise<void> {
  const element = await waitFor<HTMLElement>(selector);
  element.click();
  await tick();
}

function key(selector: string): string {
  return `[data-focus-key="${selector}"]`;
}

async function typeInComposer(text: string): Promise<void> {
  const textarea = await waitFor<HTMLTextAreaElement>(key("composer"));
  textarea.focus();
  textarea.value = text;
  textarea.setSelectionRange(text.length, text.length);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
}

async function pressEnter(): Promise<void> {
  const textarea = await waitFor<HTMLTextAreaElement>(key("composer"));
  textarea.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  await tick();
}

async function run(): Promise<void> {
  if (scenario === "service") {
    // Real adapter over the in-page stub: wait for the inbox, send through
    // messages.send, then let a poll deliver another member's message.
    await waitFor(".fixture-badge");
    await waitFor<HTMLElement>('[data-focus-key^="conv-"]');
    await typeInComposer("Sent through the RPC adapter.");
    await pressEnter();
    const server = (
      globalThis as {
        __teamServer?: {
          post(user: string, conversation: string, body: string): void;
          conversationIds(): string[];
        };
      }
    ).__teamServer;
    const first = server?.conversationIds()[0];
    if (server && first)
      server.post("user_grace", first, "Delivered by events.poll.");
    for (let i = 0; i < 100; i++) {
      if (document.body.textContent?.includes("Delivered by events.poll."))
        break;
      await tick();
    }
    return;
  }
  await waitFor(key("conv-conv_dm_ada_grace"));
  await tick();
  switch (scenario) {
    case "inbox":
      return;
    case "group":
      await click(key("conv-conv_group_release"));
      return;
    case "picker":
      await typeInComposer("Can you check this before the release? @ver");
      await pressEnterOnPickerMove();
      return;
    case "chips":
      await typeInComposer("Both sides of it: @style.css:14-23");
      await selectPicker();
      await typeInComposer("Both sides of it: and @verdictFor");
      await selectPicker();
      await click(key("reply-msg_dm_4"));
      return;
    case "panel":
    case "narrow":
      await click(key("conv-conv_group_release"));
      await click(key("chip-msg_grp_2-ref_site_banner"));
      return;
    case "pending":
      await typeInComposer("Checking the badge schema now.");
      await pressEnter();
      return;
    case "failed":
      await controller.handleMessage({
        type: "send",
        conversationId: "conv_dm_ada_grace",
        clientMessageId: "cm_ada_0001",
        body: "A retry that reuses a committed client message id with new content.",
        replyTo: null,
        references: [],
      });
      await tick();
      return;
    case "linus": {
      const select = await waitFor<HTMLSelectElement>(key("viewer"));
      select.value = "user_linus";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await tick();
      await click(key("conv-conv_group_release"));
      await click(key("chip-msg_grp_2-ref_platform_verify"));
      return;
    }
    default:
      throw new Error(`harness: unknown scenario ${scenario}`);
  }
}

async function pressEnterOnPickerMove(): Promise<void> {
  const textarea = await waitFor<HTMLTextAreaElement>(key("composer"));
  textarea.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    }),
  );
  await tick();
}

async function selectPicker(): Promise<void> {
  const textarea = await waitFor<HTMLTextAreaElement>(key("composer"));
  textarea.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  await tick();
}

run().then(
  () => {
    document.documentElement.dataset.harnessDone = "true";
  },
  (error: unknown) => {
    document.documentElement.dataset.harnessError = String(error);
  },
);
