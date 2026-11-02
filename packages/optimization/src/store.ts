import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactRef, RequestContext } from "@mars/contracts";
import { ArtifactRefSchema } from "@mars/contracts";
import type { z } from "zod";
import { scopeKey, sha256 } from "./canonical";
import { OptimizationError } from "./errors";
import {
  type CandidateRecord,
  CandidateRecordSchema,
  type HoldoutRecord,
  HoldoutRecordSchema,
  ID_PATTERN,
  type JobRecord,
  JobRecordSchema,
  type StoredTarget,
  StoredTargetSchema,
} from "./schemas";

/** Content-addressed artifact storage; the host may inject its own. */
export interface ArtifactStore {
  put(
    context: RequestContext,
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<ArtifactRef>;
  get(context: RequestContext, ref: ArtifactRef): Promise<Uint8Array>;
}

function refFor(bytes: Uint8Array, mediaType: string): ArtifactRef {
  const digest = sha256(bytes);
  return {
    artifact_id: `art-${digest.slice(0, 32)}`,
    sha256: digest,
    media_type: mediaType,
    byte_length: bytes.byteLength,
  };
}

function verify(ref: ArtifactRef, bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.sha256) {
    throw new OptimizationError("artifact_digest_mismatch", ref.artifact_id);
  }
  return bytes;
}

export function createMemoryArtifactStore(): ArtifactStore {
  const items = new Map<string, Uint8Array>();
  return {
    async put(context, bytes, mediaType) {
      const ref = refFor(bytes, mediaType);
      items.set(`${scopeKey(context.scope)}/${ref.sha256}`, bytes);
      return ref;
    },
    async get(context, ref) {
      const bytes = items.get(`${scopeKey(context.scope)}/${ref.sha256}`);
      if (!bytes)
        throw new OptimizationError("artifact_missing", ref.artifact_id);
      return verify(ref, bytes);
    },
  };
}

export function createFileArtifactStore(rootDir: string): ArtifactStore {
  const dirFor = (context: RequestContext) =>
    path.join(rootDir, scopeKey(context.scope), "artifacts");
  return {
    async put(context, bytes, mediaType) {
      const ref = refFor(bytes, mediaType);
      const dir = dirFor(context);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeAtomic(path.join(dir, `${ref.sha256}.bin`), bytes);
      return ref;
    },
    async get(context, ref) {
      ArtifactRefSchema.parse(ref);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(
          await readFile(path.join(dirFor(context), `${ref.sha256}.bin`)),
        );
      } catch {
        throw new OptimizationError("artifact_missing", ref.artifact_id);
      }
      return verify(ref, bytes);
    },
  };
}

async function writeAtomic(
  file: string,
  data: Uint8Array | string,
): Promise<void> {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, file);
}

async function readJson<T>(
  file: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  missing: OptimizationError,
): Promise<T> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw missing;
  }
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new OptimizationError("record_malformed", path.basename(file));
  }
  return parsed.data;
}

function assertId(value: string, what: string): string {
  if (!ID_PATTERN.test(value))
    throw new OptimizationError("invalid_input", what);
  return value;
}

/**
 * JSON-file store for targets, holdout records, candidate records and jobs.
 * The final holdout lives in its own file that only `readHoldout` opens.
 */
export class OptimizationStore {
  constructor(private readonly rootDir: string) {
    if (!path.isAbsolute(rootDir))
      throw new OptimizationError("invalid_input", "root_not_absolute");
  }

  private scopeDir(context: RequestContext): string {
    return path.join(this.rootDir, scopeKey(context.scope));
  }

  private targetDir(context: RequestContext, targetId: string): string {
    return path.join(
      this.scopeDir(context),
      "targets",
      assertId(targetId, "target_id"),
    );
  }

  async writeTarget(
    context: RequestContext,
    target: StoredTarget,
    holdout: HoldoutRecord,
  ): Promise<void> {
    const dir = this.targetDir(context, target.target_id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeAtomic(
      path.join(dir, "final_holdout.json"),
      JSON.stringify(HoldoutRecordSchema.parse(holdout), null, 2),
    );
    await writeAtomic(
      path.join(dir, "target.json"),
      JSON.stringify(StoredTargetSchema.parse(target), null, 2),
    );
  }

  async readTarget(
    context: RequestContext,
    targetId: string,
  ): Promise<StoredTarget> {
    return readJson(
      path.join(this.targetDir(context, targetId), "target.json"),
      StoredTargetSchema,
      new OptimizationError("target_not_found", targetId),
    );
  }

  async hasTarget(context: RequestContext, targetId: string): Promise<boolean> {
    try {
      await this.readTarget(context, targetId);
      return true;
    } catch {
      return false;
    }
  }

  /** The only reader of the holdout file. `propose` never calls it. */
  async readHoldout(
    context: RequestContext,
    targetId: string,
  ): Promise<HoldoutRecord> {
    return readJson(
      path.join(this.targetDir(context, targetId), "final_holdout.json"),
      HoldoutRecordSchema,
      new OptimizationError("target_not_found", targetId),
    );
  }

  private candidateFile(
    context: RequestContext,
    targetId: string,
    candidateId: string,
  ): string {
    return path.join(
      this.targetDir(context, targetId),
      "candidates",
      `${assertId(candidateId, "candidate_id")}.json`,
    );
  }

  async writeCandidate(
    context: RequestContext,
    record: CandidateRecord,
  ): Promise<void> {
    const file = this.candidateFile(
      context,
      record.target_id,
      record.candidate.candidate_id,
    );
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeAtomic(
      file,
      JSON.stringify(CandidateRecordSchema.parse(record), null, 2),
    );
  }

  async readCandidate(
    context: RequestContext,
    targetId: string,
    candidateId: string,
  ): Promise<CandidateRecord> {
    return readJson(
      this.candidateFile(context, targetId, candidateId),
      CandidateRecordSchema,
      new OptimizationError("candidate_not_found", candidateId),
    );
  }

  async listCandidates(
    context: RequestContext,
    targetId: string,
  ): Promise<CandidateRecord[]> {
    const dir = path.join(this.targetDir(context, targetId), "candidates");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) =>
          readJson(
            path.join(dir, name),
            CandidateRecordSchema,
            new OptimizationError("candidate_not_found", name),
          ),
        ),
    );
    return records;
  }

  private jobFile(context: RequestContext, jobId: string): string {
    return path.join(
      this.scopeDir(context),
      "jobs",
      `${assertId(jobId, "job_id")}.json`,
    );
  }

  async writeJob(context: RequestContext, job: JobRecord): Promise<void> {
    const file = this.jobFile(context, job.job_id);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeAtomic(
      file,
      JSON.stringify(JobRecordSchema.parse(job), null, 2),
    );
  }

  async readJob(context: RequestContext, jobId: string): Promise<JobRecord> {
    return readJson(
      this.jobFile(context, jobId),
      JobRecordSchema,
      new OptimizationError("job_not_found", jobId),
    );
  }
}
