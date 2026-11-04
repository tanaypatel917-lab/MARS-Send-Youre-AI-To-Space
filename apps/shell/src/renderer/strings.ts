import type { TaskStatus, VerificationState } from "@mars/contracts";

export const VERIFICATION_LABEL: Record<VerificationState, string> = {
  verified: "Verified",
  failed: "Verification failed",
  inconclusive: "Verification inconclusive",
  unverified: "Unverified",
  stale: "Verification stale",
};

export const STATUS_LABEL: Record<TaskStatus, { glyph: string; word: string }> =
  {
    running: { glyph: "●", word: "running" },
    completed: { glyph: "✔", word: "completed" },
    pending: { glyph: "○", word: "pending" },
    paused: { glyph: "‖", word: "paused" },
    cancelled: { glyph: "■", word: "cancelled" },
    failed: { glyph: "✗", word: "failed" },
  };
