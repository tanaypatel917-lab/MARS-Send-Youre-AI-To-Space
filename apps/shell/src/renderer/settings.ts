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

if (settings && form && input && save && clear && status) {
  const { apply, openKeyPage, initialize } = settingsActions(settings, {
    input,
    save,
    clear,
    status,
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
