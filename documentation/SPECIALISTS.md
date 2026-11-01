# Specialist profiles and deterministic routing

`@mars/specialists` is an isolated, provider-independent registry for
specialist and baseline profiles, signed evaluation evidence, serving
compatibility, lifecycle state, and routing decisions. It does not train or
evaluate models, execute models, schedule work, or reproduce private routing
logic from other products. The registry returns auditable selections; MARS'
existing execution and provider layers remain responsible for using them.

## Conceptual references

This package uses documented product concepts only:

- Factory's [custom Droid configuration](https://docs.factory.ai/cli/configuration/custom-droids)
  documents per-subagent model pinning or inheritance and optional
  light/medium/heavy complexity mapped to configured models. Its documented
  behavior for a disallowed pinned model falls back to the parent model. MARS
  instead records a stable reason and tries an explicit eligible baseline.
- Devin's [Fusion](https://docs.devin.ai/desktop/fusion) describes a lead
  planning and reviewing work, delegating execution to cheaper sidekicks,
  while retaining one user-facing owner. MARS' `routeTeam` maps lead, worker,
  and independent-reviewer roles to deterministic selections; it does not
  recreate Devin's private routing or orchestration logic.

These are conceptual mappings, not claims of compatibility or identical
behavior.

## Integration seams

1. The host constructs a registry synchronously with `createSpecialistRegistry`
   and `catalog = await
   loadModelRegistry(...)` (structurally compatible with `ModelCatalog`),
   `artifacts = taskStore.artifacts`, and an HMAC verifier whose keys remain
   host-side. Pass environment variable names through host configuration;
   never put key values in source, reports, or documentation. A host may add a
   future serving attestor or an evaluation-service importer.
   Contract `register` can receive a plain `SpecialistManifest` when the host
   configures `contractProfiles`; the resolver provides roles, serving
   bindings, and acceptance policy, which are required by the evidence gate
   but absent from the contract manifest type.
2. At a task/session boundary, call `route` or `routeTeam` and persist the
   returned `decision_id`. For a specialist outcome, write
   `Task.specialist_revision` via `taskStore.update(...)`.
   The local workbench does this when configured with
   `specialists: { router, domain, complexity?, paid_consent? }`: `start`
   routes once as role `worker` before any workspace or runtime exists,
   freezes `{decision_id, outcome, ref, specialist_revision, model_id}` into
   private launch metadata, sets `Task.specialist_revision` in the same
   revision step that marks the task running, and pins the selected model for
   that session and every resume. An explicit `model_id` on `start` skips
   routing. Baseline, unavailable and rejected outcomes use the ordinary
   free-only registry default; a registry error leaves the task pending with
   `unavailable`.
3. Execution passes `{ model: selected.model_id }` to the existing
   `ModelRouter` through the execution/model-bridge, keeping the selected
   model pinned for that attempt. The specialist package does not perform
   provider calls or route hops.
4. For independent routing, requests use `independence.from_decision_ids`.
   The registry loads hash-verified, caller-scope decisions and checks their
   task IDs before comparing selected targets.
5. After a provider failure, a host may explicitly call
   `fallbackAfterFailure` only if no output or tool side effect occurred. The
   call drops any override and re-routes automatically; otherwise surface the
   failure because the registry refuses a live retry.
6. A memory deletion affecting training manifests can call
   `invalidateDependency` with the affected artifact digest or component
   revision. It applies only to records in the exact caller scope.
7. Workbench, CLI, and VS Code panels can read `inspect`, `list`, `audit`, and
   `decision`. Do not expose registry roots or session-private paths over RPC.
8. A future coordinator can consume `routeTeam` output. `routeTeam` returns
   selections only and never starts a team.

## Boundaries and limitations

Evaluation and training are not performed here; this package only submits an
immutable comparison request when an `EvaluationService` is injected. The
included evaluation fixtures are synthetic and make no quality claim. HMAC
attestation proves origin and byte integrity, not result truth. Hosted base
models may drift without a serving attestor. Persistence is local, single-host
SQLite; there is no distributed coordination. Cost and runtime decisions are
only as good as the signed report. The registry does not alter existing apps,
contracts, the provider router, or task execution.
