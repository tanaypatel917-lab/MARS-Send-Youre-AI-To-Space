import type {
  DesktopModelSettings,
  ModelSettingsResult,
} from "../shared/desktop-model";

const messages: Record<ModelSettingsResult, string> = {
  saved: "Key saved in your system’s secure storage.",
  session:
    "Secure storage is unavailable. The key will be used only until MARS quits.",
  cleared: "Key removed from MARS. It was not revoked at OpenRouter.",
  invalid: "Check your key: it must start with sk-or-v1-.",
  refused: "Model settings are unavailable.",
  unavailable: "Could not update the key.",
};

export function settingsActions(
  settings: DesktopModelSettings,
  controls: {
    input: Pick<HTMLInputElement, "value" | "disabled" | "focus">;
    showKeyMode?: (present: boolean) => void;
    save: Pick<HTMLButtonElement, "disabled">;
    clear: Pick<HTMLButtonElement, "disabled">;
    status: Pick<Element, "textContent"> &
      Partial<Pick<Element, "scrollIntoView">>;
  },
) {
  const { input, save, clear, status } = controls;
  let configured = false;
  return {
    async initialize() {
      configured = await settings.hasKey().catch(() => false);
      clear.disabled = !configured;
      controls.showKeyMode?.(configured);
    },
    async openKeyPage() {
      const opened = await settings.openKeyPage().catch(() => false);
      status.textContent = opened
        ? "If no browser opened, visit openrouter.ai/settings/keys."
        : "Could not open your browser. Visit openrouter.ai/settings/keys (Settings → API Keys).";
      status.scrollIntoView?.({ block: "nearest" });
    },
    async apply(key: string | null) {
      if (key === null && !configured) return;
      status.textContent = "Updating model settings…";
      input.disabled = save.disabled = clear.disabled = true;
      const result = await settings
        .setKey(key)
        .catch(() => "unavailable" as const);
      if (result === "saved" || result === "session" || result === "cleared")
        input.value = "";
      if (result === "saved" || result === "session") configured = true;
      else if (result === "cleared") configured = false;
      controls.showKeyMode?.(configured);
      input.disabled = save.disabled = false;
      clear.disabled = !configured;
      status.textContent = messages[result];
      if (result === "invalid") input.focus();
      status.scrollIntoView?.({ block: "nearest" });
    },
  };
}
