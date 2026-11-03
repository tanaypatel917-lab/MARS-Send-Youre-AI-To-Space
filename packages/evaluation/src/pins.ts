/**
 * Exact upstream pins this package was written and verified against. The
 * runner refuses to launch when the configured Python environment reports
 * different versions; see `sources/manifest.json` for the audited revisions.
 */
export const HARBOR_VERSION = "0.25.0";
export const MINI_SWE_AGENT_VERSION = "2.4.6";
export const MIN_PYTHON = [3, 12] as const;
export const HARBOR_REGISTRY_URL =
  "https://raw.githubusercontent.com/laude-institute/harbor/main/registry.json";
/** laude-institute/harbor `main` at the time the bundled registry copy was fetched. */
export const HARBOR_REGISTRY_REVISION =
  "a81b92d5f3cd06afaa1d3ad7bcaa926c6100fb5a";
export const HARBOR_REGISTRY_SHA256 =
  "da1446bce05eabbd72a25eb9eef5a2f5db94645ce88c28e2497581433b3d2e60";

export const DATASET_PINS = {
  "terminal-bench@2.0": {
    name: "terminal-bench",
    version: "2.0",
    task_count: 89,
    git_url: "https://github.com/laude-institute/terminal-bench-2.git",
    git_commit_id: "69671fbaac6d67a7ef0dfec016cc38a64ef7a77c",
  },
  "terminal-bench-sample@2.0": {
    name: "terminal-bench-sample",
    version: "2.0",
    task_count: 10,
    git_url: "https://github.com/laude-institute/terminal-bench-2-0-sample.git",
    git_commit_id: "7e917f35c281188532772312d4ad91ca9274febc",
  },
} as const;

export const MARS_AGENT_NAME = "mars-oh-my-pi";
export const MARS_AGENT_IMPORT_PATH = "mars_harbor_agent.agent:MarsAgent";
export const BASELINE_AGENT_NAME = "mini-swe-agent";
