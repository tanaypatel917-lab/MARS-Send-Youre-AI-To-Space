export const DESKTOP_MODEL_CHANNEL = "mars-shell:desktop-model";
export const MODEL_CHANGED = "mars-shell:model-changed";

export type ModelSettingsResult =
  | "refused"
  | "invalid"
  | "unavailable"
  | "cleared"
  | "saved"
  | "session";

export type DesktopModelSettings = {
  hasKey(): Promise<boolean>;
  setKey(key: string | null): Promise<ModelSettingsResult>;
  openKeyPage(): Promise<boolean>;
};
