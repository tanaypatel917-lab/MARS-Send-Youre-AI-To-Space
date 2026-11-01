import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  EventEnvelopeSchema,
  SCHEMA_VERSION,
  type Scope,
  TaskSchema,
} from "@mars/contracts";
import { canonicalJson, type UpstreamSessionBinding } from "../index";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function writeLegacyBindEvent(
  rootDir: string,
  scope: Scope,
  taskId: string,
  binding: UpstreamSessionBinding,
  requestId: string,
): void {
  const scopeDigest = sha256(canonicalJson(scope));
  const db = new Database(path.join(rootDir, "tasks.sqlite"), {
    strict: true,
  });
  try {
    const taskRow = db
      .query(
        "SELECT record_json, record_sha256 FROM tasks WHERE scope_key = ? AND task_id = ?",
      )
      .get(scopeDigest, taskId) as {
      record_json: string;
      record_sha256: string;
    } | null;
    if (!taskRow) throw new Error("Legacy fixture task does not exist");
    const task = TaskSchema.parse(JSON.parse(taskRow.record_json));
    if (
      task.task_id !== taskId ||
      canonicalJson(task.scope) !== canonicalJson(scope) ||
      sha256(canonicalJson(task)) !== taskRow.record_sha256
    ) {
      throw new Error("Legacy fixture task is invalid");
    }

    const payloadBytes = new TextEncoder().encode(
      canonicalJson({ change: "upstream_session_bound", binding }),
    );
    const payloadSha = sha256(payloadBytes);
    const mediaType = "application/json";
    const artifactRef = {
      artifact_id: `art_${sha256(`${mediaType}\n${payloadSha}`)}`,
      sha256: payloadSha,
      media_type: mediaType,
      byte_length: payloadBytes.byteLength,
    };
    const artifactPath = path.join(
      rootDir,
      "artifacts",
      scopeDigest,
      payloadSha.slice(0, 2),
      payloadSha,
    );
    mkdirSync(path.dirname(artifactPath), { recursive: true, mode: 0o700 });
    writeFileSync(artifactPath, payloadBytes, { mode: 0o600 });
    chmodSync(artifactPath, 0o600);

    const tail = db
      .query(
        "SELECT event_id, task_seq, chain_sha256 FROM events WHERE scope_key = ? AND task_id = ? ORDER BY task_seq DESC LIMIT 1",
      )
      .get(scopeDigest, taskId) as {
      event_id: string;
      task_seq: number;
      chain_sha256: string;
    } | null;
    const event = EventEnvelopeSchema.parse({
      schema_version: SCHEMA_VERSION,
      event_id: `evt_${randomUUID()}`,
      scope: task.scope,
      session_id: task.session_id,
      task_id: task.task_id,
      occurred_at: new Date().toISOString(),
      event_type: "task.updated",
      parent_event_id: tail?.event_id ?? null,
      run_id: requestId,
      producer: "mars.tasks",
      versions: [{ component: "@mars/tasks", revision: "format-1" }],
      payload: artifactRef,
      source_event_ids: [],
      access: "private",
    });
    const eventJson = canonicalJson(event);
    const recordSha = sha256(eventJson);
    const chainSha = sha256(`${tail?.chain_sha256 ?? ""}${recordSha}`);
    const bindingJson = canonicalJson(binding);
    const inputSha = sha256(bindingJson);
    const transaction = db.transaction(() => {
      db.query(
        "INSERT INTO artifacts (scope_key, artifact_id, sha256, media_type, byte_length) VALUES (?, ?, ?, ?, ?)",
      ).run(
        scopeDigest,
        artifactRef.artifact_id,
        payloadSha,
        mediaType,
        payloadBytes.byteLength,
      );
      db.query(
        "INSERT INTO session_bindings (scope_key, task_id, record_json, record_sha256) VALUES (?, ?, ?, ?)",
      ).run(scopeDigest, taskId, bindingJson, inputSha);
      db.query(
        "INSERT INTO events (scope_key, task_id, event_id, task_seq, record_json, record_sha256, chain_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        scopeDigest,
        taskId,
        event.event_id,
        (tail?.task_seq ?? 0) + 1,
        eventJson,
        recordSha,
        chainSha,
      );
      db.query(
        "INSERT INTO idempotency (scope_key, request_id, operation, task_id, input_sha256, result_json) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        scopeDigest,
        requestId,
        "bindUpstreamSession",
        taskId,
        inputSha,
        canonicalJson(null),
      );
    });
    transaction.immediate();
  } finally {
    db.close();
  }
}
