# `@mars/specialists`

`@mars/specialists` is an isolated registry for specialist and baseline
profiles, signed evaluation evidence, serving compatibility, lifecycle state,
and deterministic routing decisions. It implements the `ModelRegistry`
contract and consumes the structural `ModelCatalog` interface. It does not
execute models, run training or evaluation workers, schedule agents, or call
providers.

## API

Create a registry with a durable absolute directory, an artifact reader, and a
model catalog. `createSpecialistRegistry` is synchronous:

```ts
const registry = createSpecialistRegistry({
  rootDir: "/var/lib/mars/specialists",
  artifacts: taskStore.artifacts,
  catalog: modelProviderRegistry,
  evidenceVerifier: hostEvidenceVerifier,
});
```

The source package does not import `@mars/providers`; a
`ModelProviderRegistry` is accepted structurally through `ModelCatalog`.
Evidence keys and serving attestations remain host-owned. The optional
`EvaluationService` integration only submits an immutable comparison request
and records the returned job reference; it does not run an evaluator.
Contract `register` accepts plain `SpecialistManifest` values when the host
provides `contractProfiles`; the resolver supplies the profile fields needed
by the evidence gate (roles, serving bindings, and acceptance policy), which
the contract manifest does not carry.

The registry exposes the contract adapter (`register`, `evaluate`, `deploy`,
`select`, `retire`, `rollback`, and `verifyCompatibility`) as well as typed
methods for specialist/baseline registration, evaluation delegation,
inspection, routing, audit, dependency invalidation, archive, and close.
`route` and `routeTeam` return selections and durable decisions only. The host
remains responsible for execution and for recording a selected specialist
revision on its task.
For independent routing, provide `independence.from_decision_ids`; the
registry loads and verifies those decisions in the caller's scope and checks
that they belong to the same task.

## Lifecycle and evidence gates

1. Register a strict `SpecialistRegistration` or `BaselineProfile` in the
exact request scope. Specialist revisions are immutable and registration
is idempotent for an identical revision.
2. At registration, load evaluation and optional dataset-lineage artifacts by
   their content-addressed references. Check bytes, media type, schema,
   subject, authorization, HMAC signature, held-out leakage, evaluator
   independence, and acceptance metrics. Evidence without a configured
   verifier remains proposed, not deployable.
3. `reverify` repeats the evidence checks; a host can reopen a proposed
   revision with a verifier configured and reverify it.
4. `promote` rechecks evidence and current-baseline freshness, serving model
   bindings, and the fallback chain, then performs a production-pointer CAS.
   `rollbackTo` uses the immutable production history and also revalidates the
   target. Archive, retire, and dependency invalidation are explicit
lifecycle operations.
`invalidateDependency` only applies to records in the exact caller scope.
5. Every route rechecks evidence and serving compatibility. Eligible
   specialists are ranked by pass rate, measured cost, runtime, specialist
   identifier, and revision. If none is eligible, the best exactly-covering
   candidate's checked fallback chain is tried before visible active
   baselines.

`REASON_CODES` is the authoritative machine-readable list. Evidence and
lineage codes include `evidence_missing`, `evidence_digest_mismatch`,
`evidence_malformed`, `evidence_subject_mismatch`, `evidence_unauthorized`,
`evidence_unverified`, `evidence_synthetic_fixture`,
`evidence_not_independent`, `evidence_stale_current_baseline`,
`lineage_missing`, `lineage_digest_mismatch`, `lineage_malformed`,
`lineage_unverified`, `lineage_subject_mismatch`, `lineage_leakage`, and
`lineage_out_of_scope`. Evaluation and coverage gates include
`cost_unmeasured`, `runtime_unmeasured`, `regressions_exceeded`,
`evaluation_gate_failed`, `status_not_evaluated`, `invalidated`, `archived`,
`domain_not_covered`, `role_not_covered`, and `complexity_not_covered`.
Compatibility and routing codes include model-binding, serving, capability,
availability, pricing, budget, independence, override, exclusion, and
fallback codes; see `REASON_CODES` for the exact names.

## Persistence and safety

The store uses `<rootDir>/specialists.sqlite`, SQLite WAL mode, full
synchronous writes, foreign keys, a 10-second busy timeout, and immediate
transactions. Format version 1 persists immutable records, lifecycle pointers,
evaluation job references, routing decisions, and hash-chained audit events.
Record and decision digests use canonical JSON. Reads verify record hashes and
audit-chain integrity.

The registry requires an absolute non-root directory and rejects a symlink or
non-regular database file. It rejects publishable data containing the registry
root, configured host-private roots, or supported secret-like patterns.
Workspace contexts may read and route project-level profiles, but mutations
require exact scope equality. Invisible records are reported as `not_found`.

`fallbackAfterFailure` drops any override and re-routes automatically only
because the host explicitly requested it after confirming there were no
outputs or tool side effects. It excludes all targets attempted in the retry
lineage and caps attempts at eight. A failure after side effects must be
surfaced by the host rather than retried.

## What is not verified

Test artifacts are explicitly synthetic fixtures; they are not real
evaluations and support no quality claim. HMAC proves origin/integrity of
bytes, not the truth of reported results. No evaluation/training worker, model
execution, live provider call, serving attestor, or paid service is run by
this package. Hosted model drift cannot be ruled out without a host serving
attestor. The SQLite store is single-host persistence. Cost and runtime
decisions are only as reliable as the signed evaluation report.

See [`EVIDENCE.md`](./EVIDENCE.md) for exact local verification commands and
untested items.
