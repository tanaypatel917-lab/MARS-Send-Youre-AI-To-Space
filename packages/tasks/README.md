# @mars/tasks

`@mars/tasks` stores task lifecycle metadata and event envelopes in `tasks.sqlite`, with immutable artifact blobs in `artifacts/<scope-digest>/<sha-prefix>/<sha256>`. Conversation history remains authoritative in Oh My Pi's session journal; this package stores only a binding to that journal and references to observed execution.

SQLite uses WAL mode, `synchronous=FULL`, and immediate write transactions so a lifecycle row and its event commit together. Artifact files are written and fsynced before their database transaction; a crash before commit can leave an unindexed orphan, which reads cannot see. Task and event records carry canonical-JSON hashes, and events also form a per-task sequence/hash chain checked on reads.

Recovery is explicit through `recoverInterrupted`; opening a store never changes task state. This local store does not cover multi-host coordination, PID reuse, or filesystems that falsely report successful fsync operations.

The API exports `createTaskStore({ rootDir, workspaceRoots?, maxArtifactBytes? })`; `DurableTaskStore` provides `create`, `inspect`, `list`, `resume`, `update`, `cancel`, `steer`, `events`, `appendEvent`, `artifacts`, `bindUpstreamSession`, `upstreamSession`, `recoverInterrupted`, and `close`. `ArtifactStore` exposes `put` and `get`. `ExecutionObservedPayloadSchema`, `RequestContextSchema`, `TASK_STORE_FORMAT_VERSION`, and `TaskStoreError` are also exported; error codes are `invalid_input`, `not_found`, `conflict`, `stale_revision`, `invalid_transition`, `corrupt_record`, `unknown_cursor`, `unsafe_path`, and `closed`. Idempotency keys use scope, `request_id`, operation, task ID, and the canonical input digest; retries replay the stored result.
