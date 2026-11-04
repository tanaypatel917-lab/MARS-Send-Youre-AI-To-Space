import { describe, expect, test } from "bun:test";
import {
  RequiredCheckSchema,
  type VerificationEvidenceRecord,
  VerificationEvidenceRecordSchema,
  verificationStateFor,
} from "./verification";

const digest = "a".repeat(64);
function record(
  revision: string,
  verdict: VerificationEvidenceRecord["verdict"],
  recordedAt: string,
  reasons: string[] = [],
): VerificationEvidenceRecord {
  return VerificationEvidenceRecordSchema.parse({
    schema_version: 1,
    operation: "verification.verdict",
    run_id: "run",
    task_id: "task",
    task_revision: 1,
    candidate: { workspace_id: "ws", provider: "local", revision },
    verdict,
    verified: verdict === "passed",
    checks: [
      {
        kind: "file_content",
        path: "repair.txt",
        expected_sha256: digest,
        observed_sha256: verdict === "passed" ? digest : null,
        status: verdict,
        reason: reasons[0] ?? null,
        duration_ms: 1,
      },
    ],
    reasons,
    diagnostics: [],
    duration_ms: 1,
    recorded_at: recordedAt,
  });
}

describe("verificationStateFor", () => {
  test("no evidence is unverified", () => {
    expect(verificationStateFor("r1", [])).toEqual({
      state: "unverified",
      record: null,
      reasons: [],
    });
  });
  test("a pass is verified only for the exact candidate revision", () => {
    const pass = record("r1", "passed", "2026-11-03T00:00:00Z");
    expect(verificationStateFor("r1", [pass]).state).toBe("verified");
    const stale = verificationStateFor("r2", [pass]);
    expect(stale.state).toBe("stale");
    expect(stale.record).toEqual(pass);
    expect(stale.reasons[0]).toContain("r1");
    expect(verificationStateFor(null, [pass]).state).toBe("stale");
  });
  test("failed and inconclusive verdicts carry their reasons", () => {
    const failed = record("r1", "failed", "2026-11-03T00:00:00Z", [
      "Required file missing",
    ]);
    expect(verificationStateFor("r1", [failed])).toMatchObject({
      state: "failed",
      reasons: ["Required file missing"],
    });
    const inconclusive = record("r1", "inconclusive", "2026-11-03T00:00:01Z", [
      "Required check timed out",
    ]);
    expect(verificationStateFor("r1", [inconclusive]).state).toBe(
      "inconclusive",
    );
  });
  test("the latest verdict for the candidate wins", () => {
    const failed = record("r1", "failed", "2026-11-03T00:00:00Z", ["old"]);
    const pass = record("r1", "passed", "2026-11-03T00:00:05Z");
    expect(verificationStateFor("r1", [pass, failed]).state).toBe("verified");
    expect(verificationStateFor("r1", [failed, pass]).state).toBe("verified");
  });
  test("a verdict without a candidate is inconclusive for any presented candidate", () => {
    const unbound = VerificationEvidenceRecordSchema.parse({
      ...record("r1", "inconclusive", "2026-11-03T00:00:02Z", [
        "Candidate revision could not be acquired",
      ]),
      candidate: null,
      checks: [],
    });
    expect(verificationStateFor("r9", [unbound])).toMatchObject({
      state: "inconclusive",
      reasons: ["Candidate revision could not be acquired"],
    });
    expect(verificationStateFor(null, [unbound]).state).toBe("inconclusive");
    const pass = record("r9", "passed", "2026-11-03T00:00:05Z");
    expect(verificationStateFor("r9", [unbound, pass]).state).toBe("verified");
    expect(
      VerificationEvidenceRecordSchema.safeParse({
        ...unbound,
        verdict: "passed",
        verified: true,
      }).success,
    ).toBe(false);
    expect(
      VerificationEvidenceRecordSchema.safeParse({
        ...record("r1", "failed", "2026-11-03T00:00:02Z", ["x"]),
        candidate: null,
      }).success,
    ).toBe(false);
  });
  test("verified must agree with the verdict and checks", () => {
    const pass = record("r1", "passed", "2026-11-03T00:00:00Z");
    expect(
      VerificationEvidenceRecordSchema.safeParse({ ...pass, verified: false })
        .success,
    ).toBe(false);
    const failed = record("r1", "failed", "2026-11-03T00:00:00Z", ["x"]);
    expect(
      VerificationEvidenceRecordSchema.safeParse({ ...failed, verified: true })
        .success,
    ).toBe(false);
  });
  test("required checks are relative normalised paths with an expectation", () => {
    expect(
      RequiredCheckSchema.safeParse({
        kind: "file_content",
        path: "repair.txt",
      }).success,
    ).toBe(false);
    for (const path of ["/etc/passwd", "../x", "a/./b", "C:\\x", ""])
      expect(
        RequiredCheckSchema.safeParse({
          kind: "file_content",
          path,
          content: "x",
        }).success,
      ).toBe(false);
    expect(
      RequiredCheckSchema.safeParse({
        kind: "file_content",
        path: "dir/repair.txt",
        content: "repaired\n",
      }).success,
    ).toBe(true);
  });
});
