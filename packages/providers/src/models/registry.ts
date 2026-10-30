import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ModelConfig, ModelsFile, ProviderConfig } from "@mars/contracts";
import {
  ModelConfigSchema,
  ModelsFileSchema,
  ProviderConfigSchema,
} from "@mars/contracts";
import { BUILTIN_MODELS, BUILTIN_PROVIDERS, BUILTIN_ROUTES } from "./presets";

export interface LoadModelRegistryOptions {
  cwd?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  trustProjectConfig?: boolean;
}

export interface AddConfigOptions {
  force?: boolean;
}

interface ParsedModelFile {
  config: ModelsFile;
  explicitAllowPaid: boolean;
}

interface MergedModelFiles {
  config: ModelsFile;
  notices: string[];
  ignoredProjectConfig: string | undefined;
}

function mergeById<T extends { id: string }>(...groups: T[][]): T[] {
  const result = new Map<string, T>();
  for (const group of groups) {
    for (const item of group) result.set(item.id, item);
  }
  return [...result.values()];
}

async function readModelsFile(
  path: string,
): Promise<ParsedModelFile | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  try {
    const raw: unknown = JSON.parse(source);
    const rawObject =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const rawPolicy =
      rawObject.policy !== null &&
      typeof rawObject.policy === "object" &&
      !Array.isArray(rawObject.policy)
        ? (rawObject.policy as Record<string, unknown>)
        : {};
    return {
      config: ModelsFileSchema.parse(raw),
      explicitAllowPaid: Object.hasOwn(rawPolicy, "allowPaid"),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid model configuration at ${path}: ${detail}`, {
      cause: error,
    });
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function writeModelsFile(path: string, file: ModelsFile): Promise<void> {
  const parsed = ModelsFileSchema.parse(file);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function readMergedFiles(
  userFilePath: string,
  projectFilePath: string,
  trustProjectConfig: boolean,
): Promise<MergedModelFiles> {
  const userFile = await readModelsFile(userFilePath);
  const ignoredProjectConfig =
    !trustProjectConfig && (await fileExists(projectFilePath))
      ? projectFilePath
      : undefined;
  const projectFile = trustProjectConfig
    ? await readModelsFile(projectFilePath)
    : undefined;
  const notices: string[] = [];
  const baseProviders = [
    ...BUILTIN_PROVIDERS,
    ...(userFile?.config.providers ?? []),
  ];
  const baseProviderIds = new Set(baseProviders.map(({ id }) => id));
  const projectProviders = projectFile?.config.providers ?? [];
  for (const provider of projectProviders) {
    if (baseProviderIds.has(provider.id)) {
      throw new Error(
        `Invalid project model configuration at ${projectFilePath}: provider "${provider.id}" cannot redefine an existing provider (field "id").`,
      );
    }
  }
  const projectProviderIds = new Set(projectProviders.map(({ id }) => id));
  if (projectFile?.explicitAllowPaid) {
    notices.push(
      `Ignored project policy.allowPaid in ${projectFilePath}; paid-model policy is controlled by user configuration.`,
    );
  }
  const projectModels = (projectFile?.config.models ?? []).map((model) => {
    if (model.pricing.free && !projectProviderIds.has(model.providerId)) {
      notices.push(
        `Project model "${model.id}" claimed free pricing for provider "${model.providerId}", which the project does not define; treating it as paid.`,
      );
      return { ...model, pricing: { ...model.pricing, free: false } };
    }
    return model;
  });
  const providers = mergeById(
    BUILTIN_PROVIDERS,
    userFile?.config.providers ?? [],
    projectProviders,
  );
  const models = mergeById(
    BUILTIN_MODELS,
    userFile?.config.models ?? [],
    projectModels,
  );
  const routes = {
    ...BUILTIN_ROUTES,
    ...userFile?.config.routes,
    ...projectFile?.config.routes,
  };
  return {
    config: ModelsFileSchema.parse({
      version: 1,
      providers,
      models,
      routes,
      policy: {
        allowPaid: userFile?.config.policy.allowPaid ?? false,
      },
    }),
    notices,
    ignoredProjectConfig,
  };
}

export class ModelProviderRegistry {
  readonly userFilePath: string;
  readonly projectFilePath: string;
  readonly ignoredProjectConfig: string | undefined;
  readonly notices: string[];
  private readonly env: Record<string, string | undefined>;
  private readonly trustProjectConfig: boolean;
  private file: ModelsFile;

  constructor(
    userFilePath: string,
    projectFilePath: string,
    merged: MergedModelFiles,
    env: Record<string, string | undefined>,
    trustProjectConfig: boolean,
  ) {
    this.userFilePath = userFilePath;
    this.projectFilePath = projectFilePath;
    this.file = merged.config;
    this.ignoredProjectConfig = merged.ignoredProjectConfig;
    this.notices = merged.notices;
    this.env = env;
    this.trustProjectConfig = trustProjectConfig;
  }

  get providers(): ProviderConfig[] {
    return this.file.providers;
  }

  get models(): ModelConfig[] {
    return this.file.models;
  }

  get routes(): Record<string, string[]> {
    return this.file.routes ?? {};
  }

  get policy(): ModelsFile["policy"] {
    return this.file.policy;
  }

  get modelFile(): ModelsFile {
    return this.file;
  }

  available(): ProviderConfig[] {
    return this.file.providers.filter(
      (provider) => this.unavailableReason(provider.id) === undefined,
    );
  }

  getProvider(providerId: string): ProviderConfig | undefined {
    return this.file.providers.find((provider) => provider.id === providerId);
  }

  getModel(modelId: string): ModelConfig | undefined {
    return this.file.models.find((model) => model.id === modelId);
  }

  unavailableReason(providerId: string): string | undefined {
    const provider = this.getProvider(providerId);
    if (!provider) return "Provider is not configured.";
    if (provider.enabled === false) return "Provider is disabled.";
    if (provider.apiKeyEnv && !this.env[provider.apiKeyEnv]?.trim()) {
      return `${provider.apiKeyEnv} is not set.`;
    }
    return undefined;
  }

  async addProvider(
    input: ProviderConfig,
    options: AddConfigOptions = {},
  ): Promise<void> {
    const provider = ProviderConfigSchema.parse(input);
    if (!options.force && this.getProvider(provider.id)) {
      throw new Error(
        `Provider "${provider.id}" already exists; use --force to replace it.`,
      );
    }
    const current = (await readModelsFile(this.userFilePath))?.config ?? {
      version: 1 as const,
      providers: [],
      models: [],
      routes: {},
      policy: { allowPaid: false },
    };
    const next = ModelsFileSchema.parse({
      ...current,
      providers: mergeById(current.providers, [provider]),
    });
    await writeModelsFile(this.userFilePath, next);
    const merged = await readMergedFiles(
      this.userFilePath,
      this.projectFilePath,
      this.trustProjectConfig,
    );
    this.file = merged.config;
    this.notices.splice(0, this.notices.length, ...merged.notices);
  }

  async addModel(
    input: ModelConfig,
    options: AddConfigOptions = {},
  ): Promise<void> {
    const model = ModelConfigSchema.parse(input);
    if (!this.getProvider(model.providerId)) {
      throw new Error(`Provider "${model.providerId}" is not configured.`);
    }
    if (!options.force && this.getModel(model.id)) {
      throw new Error(
        `Model "${model.id}" already exists; use --force to replace it.`,
      );
    }
    const current = (await readModelsFile(this.userFilePath))?.config ?? {
      version: 1 as const,
      providers: [],
      models: [],
      routes: {},
      policy: { allowPaid: false },
    };
    const next = ModelsFileSchema.parse({
      ...current,
      models: mergeById(current.models, [model]),
    });
    await writeModelsFile(this.userFilePath, next);
    const merged = await readMergedFiles(
      this.userFilePath,
      this.projectFilePath,
      this.trustProjectConfig,
    );
    this.file = merged.config;
    this.notices.splice(0, this.notices.length, ...merged.notices);
  }
}

export async function loadModelRegistry(
  options: LoadModelRegistryOptions = {},
): Promise<ModelProviderRegistry> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const configuredMarsHome = env.MARS_HOME;
  const userDirectory = configuredMarsHome
    ? isAbsolute(configuredMarsHome)
      ? configuredMarsHome
      : resolve(cwd, configuredMarsHome)
    : join(home, ".mars");
  const userFilePath = join(userDirectory, "models.json");
  const projectFilePath = resolve(cwd, ".mars", "models.json");
  const trustProjectConfig =
    options.trustProjectConfig ?? env.MARS_TRUST_PROJECT_CONFIG === "1";
  const merged = await readMergedFiles(
    userFilePath,
    projectFilePath,
    trustProjectConfig,
  );
  return new ModelProviderRegistry(
    userFilePath,
    projectFilePath,
    merged,
    env,
    trustProjectConfig,
  );
}
