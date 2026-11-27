import { z } from "zod";
import type { ModelHealth, SetupSummary } from "./setup";

export const ASSISTANT_CHANNEL = "mars-shell:assistant";
export const ASSISTANT_SETUP_CHANNEL = "mars-shell:assistant-setup";
export const AssistantMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(32_000),
  })
  .strict();
export const AssistantSessionSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().max(100),
    messages: z.array(AssistantMessageSchema).max(100),
  })
  .strict();
export type AssistantSession = z.infer<typeof AssistantSessionSchema>;
export const AssistantRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("load") }).strict(),
  z.object({ action: z.literal("settings") }).strict(),
  z
    .object({
      action: z.literal("send"),
      workspace: z.string().regex(/^[a-f0-9]{64}$/),
      seenMessages: z.number().int().min(0).max(100),
      id: z.string().uuid(),
      text: z.string().trim().min(1).max(8000),
      consent: z.literal(true),
    })
    .strict(),
]);
export type AssistantRequest = z.infer<typeof AssistantRequestSchema>;
export type AssistantResult =
  | {
      ok: true;
      workspace: string;
      sessions: AssistantSession[];
      configured: boolean;
      canConfigure: boolean;
      health?: ModelHealth;
      setup?: SetupSummary;
    }
  | {
      ok: false;
      error: string;
      reloadHistory?: boolean;
      health?: ModelHealth;
      setup?: SetupSummary;
    };
export type AssistantApi = {
  onWorkbenchChanged?(refresh: () => void): void;
  request(payload: AssistantRequest): Promise<AssistantResult>;
  /** The local setup journal summary, read without Chat history. */
  setup?(): Promise<SetupSummary | undefined>;
};
