import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ArtifactRef, RequestContext } from "@mars/contracts";
import {
  type ComparisonManifestInput,
  parseComparisonManifest,
  sha256Hex,
} from "./manifest";
import {
  DATASET_PINS,
  HARBOR_REGISTRY_REVISION,
  HARBOR_REGISTRY_SHA256,
} from "./pins";

export const FIXTURES = resolve(import.meta.dir, "..", "fixtures");
export const REGISTRY_FIXTURE = join(FIXTURES, "registry.tb2.json");
export const FAKE_HARBOR = join(FIXTURES, "fake-harbor.py");

export const context: RequestContext = {
  schema_version: 1,
  scope: { owner_id: "eval-owner", project_id: "eval-project" },
  request_id: "req-1",
};

export class MemoryArtifacts {
  readonly items = new Map<string, { data: Uint8Array; mediaType: string }>();
  async put(
    _context: RequestContext,
    data: Uint8Array,
    mediaType: string,
  ): Promise<ArtifactRef> {
    const sha256 = sha256Hex(data);
    this.items.set(sha256, { data, mediaType });
    return {
      artifact_id: `art-${sha256.slice(0, 12)}`,
      sha256,
      media_type: mediaType,
      byte_length: data.byteLength,
    };
  }
  async get(_context: RequestContext, ref: ArtifactRef): Promise<Uint8Array> {
    const item = this.items.get(ref.sha256);
    if (!item) throw new Error(`missing artifact ${ref.artifact_id}`);
    return item.data;
  }
}

export const SAMPLE_IMAGE = `ghcr.io/laude-institute/terminal-bench/regex-log:2.0@sha256:${"5".repeat(64)}`;

export async function sampleManifest(
  overrides: Partial<ComparisonManifestInput> = {},
  bundle: { path: string; sha256: string } = {
    path: "/opt/mars-bundle",
    sha256: "a".repeat(64),
  },
) {
  const pin = DATASET_PINS["terminal-bench-sample@2.0"];
  const registryBytes = new Uint8Array(await readFile(REGISTRY_FIXTURE));
  const input: ComparisonManifestInput = {
    schema: "mars.evaluation-comparison/v1",
    comparison_id: "cmp-sample",
    created_at: "2026-11-02T20:00:00.000Z",
    dataset: {
      name: pin.name,
      version: pin.version,
      registry: {
        url: "https://raw.githubusercontent.com/laude-institute/harbor/main/registry.json",
        revision: HARBOR_REGISTRY_REVISION,
        upstream_sha256: HARBOR_REGISTRY_SHA256,
        path: REGISTRY_FIXTURE,
        sha256: sha256Hex(registryBytes),
      },
      tasks_source: { git_url: pin.git_url, git_commit_id: pin.git_commit_id },
    },
    tasks: ["regex-log", "chess-best-move", "qemu-startup"],
    final_holdout_tasks: ["qemu-startup"],
    repeats: 2,
    arms: {
      baseline: { agent: "mini-swe-agent", version: "2.4.6" },
      candidate: {
        agent: "mars-oh-my-pi",
        candidate: {
          candidate_id: "cand-1",
          components: {
            system_prompt: "You are MARS candidate 1. Verify before claiming.",
          },
          parent_candidate_id: null,
          created_at: "2026-11-02T19:00:00.000Z",
        },
        bundle,
        workdir: "/app",
      },
    },
    model: {
      id: "qwen3-coder:30b",
      base_url: "http://host.docker.internal:11434/v1",
      api_key_env: "MARS_EVAL_API_KEY",
      api_format: "openai_chat_completions",
      context_window: 32000,
      pricing: null,
    },
    environment: {
      type: "docker",
      images: [{ task_id: null, reference: SAMPLE_IMAGE }],
    },
    python: { harbor_version: "0.25.0", mini_swe_agent_version: "2.4.6" },
    timeouts: { trial_timeout_ms: 600_000, timeout_multiplier: 1 },
    budget: {
      max_tokens: 2_000_000,
      max_usd: 5,
      max_duration_ms: 3_600_000,
      max_depth: 0,
      max_concurrency: 2,
    },
    per_trial: { max_tokens: 200_000, max_usd: 1 },
    ...overrides,
  };
  return parseComparisonManifest(input);
}
