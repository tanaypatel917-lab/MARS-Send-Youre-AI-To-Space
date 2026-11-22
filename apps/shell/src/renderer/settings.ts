import type { DesktopModelSettings } from "../shared/desktop-model";
import { settingsActions } from "./settings-actions";

const settings = (
  globalThis as typeof globalThis & {
    marsModelSettings?: DesktopModelSettings;
  }
).marsModelSettings;
const form = document.querySelector("form");
const input = document.querySelector<HTMLInputElement>("#model-key");
const save = document.querySelector<HTMLButtonElement>("[type=submit]");
const clear = document.querySelector<HTMLButtonElement>("#clear-key");
const status = document.querySelector("#model-status");

const closeSettings = () => window.close();
document
  .querySelector("#close-settings")
  ?.addEventListener("click", closeSettings);
document.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Escape" || (event.metaKey && event.key === "w")) {
    event.preventDefault();
    closeSettings();
  }
});

if (settings && form && input && save && clear && status) {
  const { apply, openKeyPage, initialize } = settingsActions(settings, {
    input,
    save,
    clear,
    status,
    showKeyMode: (present) => {
      const labels = [
        [
          "#key-heading",
          present ? "Manage your API key" : "Connect your model",
        ],
        ["#key-step", present ? "Get a replacement key" : "1. Create your key"],
        [
          "#key-label",
          present
            ? "Paste a replacement OpenRouter API key"
            : "2. Paste your OpenRouter API key",
        ],
        ["[type=submit]", present ? "Replace key" : "Save & connect"],
      ] as const;
      for (const [selector, label] of labels) {
        const el = document.querySelector(selector);
        if (el) el.textContent = label;
      }
    },
  });
  void initialize();
  document
    .querySelector("#get-key")
    ?.addEventListener("click", () => void openKeyPage());
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void apply(input.value.trim());
  });
  clear.addEventListener("click", () => void apply(null));
}
