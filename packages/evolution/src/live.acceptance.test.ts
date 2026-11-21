import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ArtifactRef, RequestContext } from "@mars/contracts";
import { sha256 } from "@mars/contracts/canonical";
import {
  createEvaluationService,
  createHarborRunner,
  parseComparisonManifest,
} from "@mars/evaluation";
import { createHarborEvaluator } from "./evaluators";
import { type LiveRunObservation, liveEvidenceRecord } from "./live-evidence";
import {
  createModelProposer,
  createOpenRouterProposerClient,
  DEFAULT_FREE_PROPOSER_MODEL,
} from "./proposers";
import {
  createEvolutionDockerSandbox,
  DEFAULT_EVOLUTION_DOCKER_IMAGE,
} from "./sandbox";
import { EvolutionService } from "./service";

/**
 * LIVE acceptance (never run in CI; BLOCKED without a model key, Harbor venv
 * and pinned Docker images). See documentation/EVOLUTION.md for the exact command.
 *
 * Uses a real model-driven proposer (`createModelProposer`, free-tier OpenRouter
 * by default), Docker-isolated candidate builds (`createEvolutionDockerSandbox`,
 * `--network=none`), and real Harbor evaluation; see LIVE_ACCEPTANCE_EVIDENCE.
 * `live-evidence.json` is written only after the run ends, with its status and
 * what it observed.
 */
const live = process.env.MARS_EVOLUTION_LIVE === "1";

class Artifacts {
  readonly items = new Map<string, Uint8Array>();
  async put(
    _context: RequestContext,
    data: Uint8Array,
    media_type: string,
  ): Promise<ArtifactRef> {
    const digest = sha256(data);
    this.items.set(digest, data);
    return {
      artifact_id: `art-${digest.slice(0, 12)}`,
      sha256: digest,
      media_type,
      byte_length: data.byteLength,
    };
  }
  async get(_context: RequestContext, ref: ArtifactRef): Promise<Uint8Array> {
    const data = this.items.get(ref.sha256);
    if (!data) throw new Error(`missing artifact ${ref.artifact_id}`);
    return data;
  }
}

test.skipIf(!live)(
  "live (model-driven proposer, Docker --network=none builds, Harbor evaluation): a harness candidate is compared and promoted or refused; rollback runs only on accept",
  async () => {
    const env = (name: string) => {
      const value = process.env[name];
      if (!value) throw new Error(`${name} is required for live acceptance`);
      return value;
    };
    const root = await mkdtemp(join(tmpdir(), "mars-evolution-live-"));
    let verdict: LiveRunObservation["verdict"];
    let rolledBack = false;
    let verifiedAfterReopen = false;
    let failure: unknown;
    try {
      const template = parseComparisonManifest(
        JSON.parse(
          await readFile(resolve(env("MARS_EVOLUTION_TEMPLATE")), "utf8"),
        ),
      );
      const runner = createHarborRunner({
        pythonPath: env("MARS_HARBOR_PYTHON"),
        harborPath: env("MARS_HARBOR_PATH"),
        agentPythonPath: resolve(
          import.meta.dir,
          "..",
          "..",
          "evaluation",
          "python",
        ),
        jobsDir: join(root, "jobs"),
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          MARS_EVAL_API_KEY: env("MARS_EVAL_API_KEY"),
        },
      });
      const artifacts = new Artifacts();
      const context: RequestContext = {
        schema_version: 1,
        scope: { owner_id: "live", project_id: "evolution" },
        request_id: "live-1",
      };
      const evaluator = createHarborEvaluator({
        service: createEvaluationService({
          stateDir: join(root, "eval"),
          runner,
          artifacts,
        }),
        artifacts,
        context,
        template,
      });
      const proposerApiKey =
        process.env.OPENROUTER_API_KEY ??
        process.env.OPENAI_API_KEY ??
        env("MARS_EVAL_API_KEY");
      const proposerModel =
        process.env.MARS_EVOLUTION_PROPOSER_MODEL ??
        DEFAULT_FREE_PROPOSER_MODEL;
      const dockerImage =
        process.env.MARS_EVOLUTION_DOCKER_IMAGE ??
        DEFAULT_EVOLUTION_DOCKER_IMAGE;
      const open = () =>
        EvolutionService.open({
          storeDir: join(root, "store"),
          workDir: join(root, "work"),
          evaluator,
          proposer: createModelProposer({
            client: createOpenRouterProposerClient({ apiKey: proposerApiKey }),
            model: proposerModel,
            allowPaid: false,
          }),
          sandbox: createEvolutionDockerSandbox({ image: dockerImage }),
        });
      const half = Math.max(1, Math.floor(template.tasks.length / 2));
      const service = await open();
      await service.startRun({
        config: {
          schema: "mars.evolution-run/v1",
          run_id: "live-run",
          seed: "live",
          generations: 1,
          children_per_generation: 1,
          selection: {
            stages: [{ tasks: template.tasks.slice(0, half) }],
            repeats: template.repeats,
          },
          final_test: {
            tasks: template.tasks.slice(half),
            repeats: Math.max(2, template.repeats),
          },
          evaluation_budget: template.budget,
          budget: {
            ...template.budget,
            max_usd: template.budget.max_usd * 10,
            max_tokens: template.budget.max_tokens * 10,
            max_duration_ms: template.budget.max_duration_ms * 10,
            max_depth: 5,
          },
          harness: {
            mutable_paths: ["harness/**"],
            protected_paths: [],
            build: {
              argv: ["/bin/sh", "build.sh"],
              timeout_ms: 600_000,
              bundle_dir: "dist",
            },
          },
        },
        scope_key: "live",
        base_dir: resolve(env("MARS_EVOLUTION_BASE")),
        base_ref: "live-base",
        model: {
          id: template.model.id,
          provider: "openai-compatible",
          revision: "pinned",
        },
        prompts: {
          system_prompt:
            template.arms.candidate.candidate.components.system_prompt ??
            "You are MARS.",
        },
        skills: { store_revision: "live" },
        tools: [],
        retrieval: {
          repo_map_tokens: 0,
          memory_top_k: 0,
          context_window_tokens: template.model.context_window,
          research: false,
        },
      });
      await service.run("live-run");
      const decision = await service.promote({
        run_id: "live-run",
        idempotency_key: "live-promotion",
      });
      expect(["accepted", "no_improvement", "rejected"]).toContain(
        decision.verdict,
      );
      verdict = decision.verdict;
      expect(decision.simulated).toBe(false);
      if (decision.verdict === "accepted") {
        const champion = service.champion("live");
        service.rollback({
          scope_key: "live",
          to_entry_seq: 1,
          expected_pointer_version: champion?.pointer_version ?? 0,
        });
        rolledBack = true;
      }
      service.close();
      const reopened = await open();
      expect((await reopened.verify("live-run")).ok).toBe(true);
      expect(reopened.champion("live")?.candidate_id).toBe("initial");
      verifiedAfterReopen = true;
      reopened.close();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const evidence = liveEvidenceRecord({
        status: failure === undefined ? "passed" : "failed",
        verdict,
        rolled_back: rolledBack,
        verified_after_reopen: verifiedAfterReopen,
        ...(failure === undefined
          ? {}
          : {
              error:
                failure instanceof Error ? failure.message : String(failure),
            }),
      });
      await writeFile(
        join(root, "live-evidence.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
      console.log(
        `live evidence (${evidence.scope}, ${evidence.status}): established ${evidence.establishes.join("; ") || "nothing"}; not established: ${evidence.does_not_establish.join("; ")}`,
      );
    }
  },
  24 * 60 * 60 * 1000,
);
