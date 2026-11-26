import type { ParamsFor } from "./methods";

export const PATCH_HANDOFF_CHANNEL = "mars-shell:patch-handoff";

export type PatchHandoffResult =
  | { status: "saved"; folder: string }
  | { status: "cancelled" }
  | { status: "blocked"; reason: string };

export type PatchHandoffApi = {
  save: (params: ParamsFor<"tasks.export">) => Promise<PatchHandoffResult>;
};
