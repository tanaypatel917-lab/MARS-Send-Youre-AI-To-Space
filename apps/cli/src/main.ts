import { parseArgs } from "node:util";
import type { ModelConfig, ProviderConfig } from "@mars/contracts";
import { probeExecution } from "@mars/execution";
import {
  discoverModels,
  loadModelRegistry,
  ModelRouter,
} from "@mars/providers";
import { omnirouteDoctorReport } from "./omniroute";
import { runRender } from "./render";
import { RESEARCH_SEARCH_PROVIDERS, runServer, ServeUsageError } from "./serve";
import { runVault, VaultUsageError } from "./vault";

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required option --${name}.`);
  }
  return value;
}

async function runModels(args: string[]): Promise<void> {
  const trustProjectConfig =
    args.includes("--trust-project") ||
    process.env.MARS_TRUST_PROJECT_CONFIG === "1";
  const commandArgs = args.filter((arg) => arg !== "--trust-project");
  const subcommand = commandArgs[0];
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    console.log(
      [
        "Usage: mars models [--trust-project] <list|providers|add-provider|add|discover|test> [options]",
        "  add --provider ID --model ID [--id ID] [--tools] [--vision] [--context N] [--free]",
        "  Project configuration is ignored unless --trust-project is set (or MARS_TRUST_PROJECT_CONFIG=1).",
      ].join("\n"),
    );
    return;
  }
  const registry = await loadModelRegistry({ trustProjectConfig });
  if (registry.ignoredProjectConfig) {
    console.error(
      `Ignoring untrusted project model config at ${registry.ignoredProjectConfig}; pass --trust-project or set MARS_TRUST_PROJECT_CONFIG=1 to load it.`,
    );
  }
  for (const notice of registry.notices) {
    console.error(`Notice: ${notice}`);
  }
  if (subcommand === "list") {
    const { values } = parseArgs({
      args: commandArgs.slice(1),
      options: {
        free: { type: "boolean" },
        available: { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    });
    const availableProviders = new Set(
      registry.available().map(({ id }) => id),
    );
    const models = registry.models.filter(
      (model) =>
        (!values.free || model.pricing.free) &&
        (!values.available || availableProviders.has(model.providerId)),
    );
    console.log(JSON.stringify(models, null, 2));
    return;
  }
  if (subcommand === "providers") {
    const providers = registry.providers.map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
      available: registry.unavailableReason(provider.id) === undefined,
      ...(provider.enabled === false ? { enabled: false } : {}),
      ...(provider.freeTier ? { freeTier: provider.freeTier } : {}),
      ...(provider.docsUrl ? { docsUrl: provider.docsUrl } : {}),
    }));
    console.log(JSON.stringify(providers, null, 2));
    return;
  }
  if (subcommand === "add-provider") {
    const { values } = parseArgs({
      args: commandArgs.slice(1),
      options: {
        id: { type: "string" },
        "base-url": { type: "string" },
        kind: { type: "string" },
        "api-key-env": { type: "string" },
        force: { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    });
    const provider: ProviderConfig = {
      id: requiredString(values.id, "id"),
      kind: values.kind === "anthropic" ? "anthropic" : "openai-compatible",
      baseUrl: requiredString(values["base-url"], "base-url"),
      ...(typeof values["api-key-env"] === "string"
        ? { apiKeyEnv: values["api-key-env"] }
        : {}),
    };
    if (
      values.kind !== undefined &&
      values.kind !== "anthropic" &&
      values.kind !== "openai-compatible"
    ) {
      throw new Error("--kind must be openai-compatible or anthropic.");
    }
    await registry.addProvider(provider, { force: values.force === true });
    console.log(
      JSON.stringify(
        { added: provider.id, file: registry.userFilePath },
        null,
        2,
      ),
    );
    return;
  }
  if (subcommand === "add") {
    const { values } = parseArgs({
      args: commandArgs.slice(1),
      options: {
        provider: { type: "string" },
        model: { type: "string" },
        id: { type: "string" },
        tools: { type: "boolean" },
        vision: { type: "boolean" },
        context: { type: "string" },
        free: { type: "boolean" },
        force: { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    });
    const providerId = requiredString(values.provider, "provider");
    const upstreamModel = requiredString(values.model, "model");
    const contextWindow =
      values.context === undefined ? 8192 : Number(values.context);
    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
      throw new Error("--context must be a positive integer.");
    }
    const model: ModelConfig = {
      id:
        typeof values.id === "string"
          ? values.id
          : `${providerId}/${upstreamModel}`,
      providerId,
      model: upstreamModel,
      capabilities: {
        tools: values.tools === true,
        vision: values.vision === true,
        contextWindow,
      },
      pricing: { free: values.free === true },
    };
    await registry.addModel(model, { force: values.force === true });
    console.log(
      JSON.stringify({ added: model.id, file: registry.userFilePath }, null, 2),
    );
    return;
  }
  if (subcommand === "discover") {
    const { values, positionals } = parseArgs({
      args: commandArgs.slice(1),
      options: { save: { type: "boolean" } },
      strict: true,
      allowPositionals: true,
    });
    const providerId = positionals[0];
    if (!providerId)
      throw new Error("Usage: mars models discover <providerId> [--save].");
    const provider = registry.getProvider(providerId);
    if (!provider)
      throw new Error(`Provider "${providerId}" is not configured.`);
    const unavailable = registry.unavailableReason(providerId);
    if (unavailable)
      throw new Error(
        `Provider "${providerId}" is unavailable: ${unavailable}`,
      );
    const models = await discoverModels(provider);
    if (values.save) {
      const knownModels = new Set(registry.models.map(({ id }) => id));
      for (const model of models) {
        if (knownModels.has(model.id)) continue;
        await registry.addModel(model);
        knownModels.add(model.id);
      }
    }
    console.log(JSON.stringify(models, null, 2));
    return;
  }
  if (subcommand === "test") {
    const { values, positionals } = parseArgs({
      args: commandArgs.slice(1),
      options: { prompt: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const modelId = positionals[0];
    if (!modelId)
      throw new Error("Usage: mars models test <modelId> [--prompt].");
    const response = await new ModelRouter(registry).complete(
      {
        messages: [
          {
            role: "user",
            content:
              typeof values.prompt === "string"
                ? values.prompt
                : "Reply with: MARS model test OK",
          },
        ],
      },
      { model: modelId },
    );
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  throw new Error(`Unknown models command "${subcommand}".`);
}

const command = process.argv[2];
try {
  if (command === "doctor") {
    const report = {
      product: "MARS - Send You're AI To Space",
      milestone: "0: source and integration baseline",
      runtime: {
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
      },
      execution: await probeExecution(),
      research: {
        control_plane:
          "@mars/research (durable store under the serve state root)",
        worker: "@mars/research-worker",
        enabled_by: "mars serve --research-search <brave|searxng|tavily>",
        search_providers: Object.entries(RESEARCH_SEARCH_PROVIDERS).map(
          ([id, provider]) => ({
            id,
            api_key_env: provider.api_key_env,
            credential_present:
              provider.api_key_env === null
                ? null
                : process.env[provider.api_key_env] !== undefined,
            docs_url: provider.docs_url,
          }),
        ),
        verified: "offline only (fixtures and injected model responses)",
        live_verified: false,
      },
      omniroute: await omnirouteDoctorReport(),
      limitations: [
        "Initialization probe only; no agent task or model request was run.",
        "Live-provider and real IDE workbench acceptance remain unverified; memory and learning (skills plus proposal-only background review) are implemented with offline evidence only; training is not implemented.",
        "Background research runs only when mars serve is started with --research-search; no live search provider or model run has been verified.",
        "OmniRoute is an optional provider target enabled by mars serve --omniroute; the doctor probe is one GET /v1/models and no model request. No live OmniRoute or upstream provider call has been verified; catalog quotas are upstream approximations.",
        "Python services must use separate versioned environments.",
      ],
    };
    console.log(JSON.stringify(report, null, 2));
  } else if (command === "smoke") {
    console.log(JSON.stringify(await probeExecution(), null, 2));
  } else if (command === "models") {
    await runModels(process.argv.slice(3));
  } else if (command === "render") {
    await runRender(process.argv.slice(3));
  } else if (command === "serve") {
    try {
      await runServer(process.argv.slice(3));
    } catch (error) {
      console.error(
        error instanceof ServeUsageError
          ? error.message
          : "MARS workbench could not start or stop safely. Check the source, private state directory, port, optional pinned local image, and research model/search configuration.",
      );
      process.exitCode = 1;
    }
  } else if (command === "vault") {
    await runVault(process.argv.slice(3));
  } else {
    console.error(
      "Usage: bun apps/cli/src/main.ts <doctor|smoke|models|serve|render|vault>",
    );
    process.exitCode = 2;
  }
} catch (error) {
  console.error(
    error instanceof VaultUsageError || error instanceof Error
      ? error.message
      : "MARS command failed",
  );
  process.exitCode = 1;
}
