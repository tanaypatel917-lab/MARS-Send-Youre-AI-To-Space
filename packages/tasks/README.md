# @mars/tasks

`@mars/tasks` stores task lifecycle metadata and event envelopes in `tasks.sqlite`, with immutable artifact blobs in `artifacts/<scope-digest>/<sha-prefix>/<sha256>`. Conversation history remains authoritative in Oh My Pi's session journal; this package stores only a binding to that journal and references to observed execution.

SQLite uses WAL mode, `synchronous=FULL`, and immediate write transactions so a lifecycle row and its event commit together. Artifact files are written and fsynced before their database transaction; a crash before commit can leave an unindexed orphan, which reads cannot see. Task and event records carry canonical-JSON hashes, and events also form a per-task sequence/hash chain checked on reads.

Recovery is explicit through `recoverInterrupted`; opening a store never changes task state. This local store does not cover multi-host coordination, PID reuse, or filesystems that falsely report successful fsync operations.
