export const EXTENSION_CHANNEL = "mars-shell:extensions";

export interface Extension {
  id: string;
  kind: "mcp" | "skill" | "plugin";
  name: string;
  version: string;
  description: string;
  permissions: string[];
}

const summary = {
  file: "mars-change-summary.md",
  sha256: "8e55df7d8e2f98c7fd4fbdeb6dac8c88553526342354fa1ede143942187f9565",
};
const handoff = {
  file: "mars-test-handoff.md",
  sha256: "cbf14da95865ed6ea9996ef941b586f397defc811a52d8dca5c27e28c3111a48",
};
type Asset = { file: string; sha256: string };
export type CatalogEntry = Extension & { assets: Asset[] } & (
    | {
        kind: "mcp";
        tool: string;
        additionalTools?: string[];
        projectRootArg?: true;
        args: string[];
      }
    | { kind: "skill" | "plugin" }
  );
const triage = {
  file: "mars-bug-triage.md",
  sha256: "d767d1e9999ca457d03a00a24316540dcda7ecf5a166659b98f0868ba1a5e2aa",
};
const review = {
  file: "mars-code-review.md",
  sha256: "678c67d84ee35f0ee7f73de3602dff553eea7eb567e72d282c9bcef207c04bd0",
};
const plan = {
  file: "mars-test-plan.md",
  sha256: "dab1ae8951d100f8745d26c193e0f0f3c49ab85b2c170ac23a6da69758ee906c",
};
const developerTool = {
  file: "developer-tool.ts",
  sha256: "d72e2219117aa8e273dc2880f6b55cc17fef40ccff21b03183f626a61cd16c4f",
};

function skill(asset: Asset, name: string, description: string): CatalogEntry {
  return {
    id: asset.file.replace(/\.md$/, ""),
    kind: "skill",
    name,
    description,
    version: "1.0.0",
    permissions: [`Add the ${name} instructions to this project`],
    assets: [asset],
  };
}
function kit(
  id: string,
  name: string,
  description: string,
  contents: string,
  assets: Asset[],
): CatalogEntry {
  return {
    id,
    kind: "plugin",
    name,
    description,
    version: "1.0.0",
    permissions: [`Add these project instructions: ${contents}`],
    assets,
  };
}
function offlineTool(
  id: string,
  name: string,
  tool: string,
  description: string,
): CatalogEntry {
  return {
    id,
    kind: "mcp",
    name,
    tool,
    description,
    args: [tool],
    assets: [developerTool],
    version: "1.0.0",
    permissions: [
      `Run the bundled ${name} process`,
      `Call ${tool} on supplied text only; no file or network access`,
    ],
  };
}
export const CATALOG: CatalogEntry[] = [
  {
    id: "mcp-filesystem",
    name: "Filesystem · project browser",
    kind: "mcp",
    version: "2.4.0",
    description:
      "Browse directory names in the open project with the Model Context Protocol project's Filesystem server.",
    tool: "list_directory",
    additionalTools: ["list_allowed_directories"],
    projectRootArg: true,
    args: [],
    assets: [
      {
        file: "filesystem.mjs",
        sha256:
          "b28d0b31686170d39aa293ba12263f4087a013a51d240ceef4e0698b2b134c84",
      },
    ],
    permissions: [
      "List file and directory names (including hidden names) and disclose the selected project's absolute path",
      "No tool grant for reading file contents or writing files. No credentials or remote connection.",
    ],
  },
  {
    id: "mcp-sequential-thinking",
    name: "Sequential Thinking",
    kind: "mcp",
    version: "2.2.0",
    description:
      "Track steps, branches and revisions while solving a multi-step task using the Model Context Protocol project's server.",
    tool: "sequentialthinking",
    args: ["--transport", "stdio"],
    assets: [
      {
        file: "sequential-thinking.mjs",
        sha256:
          "2af778645fc56a7bb4a322d75d8f2d954017c0871ce272fe44e26a2e89ca06a4",
      },
    ],
    permissions: [
      "Process supplied reasoning steps in memory for this connection; thought logging is disabled",
      "No credentials or remote connection.",
    ],
  },
  offlineTool(
    "mars-json-compare",
    "JSON comparison",
    "compare_json",
    "Find added, removed and changed JSON paths between two documents. Returns paths, not values.",
  ),
  offlineTool(
    "mars-diff-summary",
    "Diff statistics",
    "summarize_diff",
    "Count lines added and removed per file in a supplied unified text patch, without opening the repository.",
  ),
  {
    id: "mars-utc-clock",
    kind: "mcp",
    tool: "utc_now",
    args: [],
    name: "UTC clock",
    version: "1.0.0",
    description:
      "Let an agent task read the current UTC time without a network connection.",
    permissions: [
      "Run the bundled clock process",
      "Call utc_now (no arguments)",
    ],
    assets: [
      {
        file: "utc-clock.ts",
        sha256:
          "aa22e310518ab0f35f84edf93c04f160767276698af2becde3f129c40d762ca4",
      },
    ],
  },
  skill(
    triage,
    "Bug triage",
    "Turn a bug report into expected behavior, evidence and a regression assertion.",
  ),
  skill(
    review,
    "Code review",
    "Review a patch for concrete regressions and actionable fixes.",
  ),
  skill(
    plan,
    "Test planning",
    "Turn a behavior change into a lean test plan with observable results.",
  ),
  skill(
    summary,
    "Change summary",
    "Write release notes from verified changes.",
  ),
  skill(
    handoff,
    "Test handoff",
    "Separate verified results from untested paths in a release handoff.",
  ),
  kit(
    "mars-debug-kit",
    "Bug investigation kit",
    "Triage a report and plan checks that distinguish a root cause from a symptom.",
    "Bug triage and Test planning",
    [triage, plan],
  ),
  kit(
    "mars-pr-kit",
    "Pull request review kit",
    "Review a change, identify missing tests and report what was actually checked.",
    "Code review, Test planning and Test handoff",
    [review, plan, handoff],
  ),
  kit(
    "mars-release-kit",
    "Release handoff kit",
    "Prepare release notes alongside a verification handoff.",
    "Change summary and Test handoff",
    [summary, handoff],
  ),
];

export type ExtensionView = Extension & {
  installed: boolean;
  removable: boolean;
};
export interface DesktopExtensions {
  list(): Promise<ExtensionView[]>;
  install(id: string): Promise<"installed" | "cancelled" | "unavailable">;
  remove(id: string): Promise<"removed" | "cancelled" | "unavailable">;
}
export function findExtension(id: unknown) {
  return CATALOG.find((entry) => entry.id === id);
}
