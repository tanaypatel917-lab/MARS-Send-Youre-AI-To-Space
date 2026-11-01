import { z } from "zod";
import { frozenClone } from "./canonical";
import type { ScanRecord, SourceEvidence } from "./schemas";
import { ScanRecordSchema } from "./schemas";
export interface ReputationScanner {
  id: string;
  scan(
    evidence: SourceEvidence,
  ): Promise<{ score?: number; findings: string[] }>;
}
export async function runAdvisoryScan(
  scanner: ReputationScanner,
  review: { binding_sha256: string; evidence: SourceEvidence },
  timeoutMs: number,
): Promise<ScanRecord> {
  const snapshot = frozenClone(review);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const base = {
    scanner_id: scanner.id,
    observed_at: new Date().toISOString(),
    binding_sha256: snapshot.binding_sha256,
  };
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => scanner.scan(snapshot.evidence)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timeout")),
          Math.max(0, timeoutMs),
        );
      }),
    ]);
    const advisory = z
      .object({
        score: z.number().finite().optional(),
        findings: z.array(z.string()),
      })
      .strict()
      .parse(result);
    return ScanRecordSchema.parse({ ...base, ...advisory, status: "ok" });
  } catch {
    return ScanRecordSchema.parse({
      ...base,
      status: "unavailable",
      findings: [],
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
