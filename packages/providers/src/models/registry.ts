import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
}

export interface AddConfigOptions {
  force?: boolean;
}

function mergeById<T extends { id: string }>(...groups: T[][]): T[] {
  const result = new Map<string, T>();
  for (const group of groups) {
    for (const item of group) result.set(item.id, item);
  }
  return [...result.values()];
}

async function readModelsFile(path: string): Promise<ModelsFile | undefined> {
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
    return ModelsFileSchema.parse(JSON.parse(source));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid model configuration at ${path}: ${detail}`, {
      cause: error,
    });
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
): Promise<ModelsFile> {
  const userFile = await readModelsFile(userFilePath);
  const projectFile = await readModelsFile(projectFilePath);
  const providers = mergeById(
    BUILTIN_PROVIDERS,
    userFile?.providers ?? [],
    projectFile?.providers ?? [],
  );
  const models = mergeById(
    BUILTIN_MODELS,
    userFile?.models ?? [],
    projectFile?.models ?? [],
  );
  const routes = {
    ...BUILTIN_ROUTES,
    ...userFile?.routes,
    ...projectFile?.routes,
  };
  return ModelsFileSchema.parse({
    version: 1,
    providers,
    models,
    routes,
    policy: {
      allowPaid:
        projectFile?.policy.allowPaid ?? userFile?.policy.allowPaid ?? false,
    },
  });
}

export class ModelProviderRegistry {
  readonly userFilePath: string;
  readonly projectFilePath: string;
  private readonly env: Record<string, string | undefined>;
  private file: ModelsFile;

  constructor(
    userFilePath: string,
    projectFilePath: string,
    file: ModelsFile,
    env: Record<string, string | undefined>,
  ) {
    this.userFilePath = userFilePath;
    this.projectFilePath = projectFilePath;
    this.file = file;
    this.env = env;
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
    const current = (await readModelsFile(this.userFilePath)) ?? {
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
    this.file = await readMergedFiles(this.userFilePath, this.projectFilePath);
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
    const current = (await readModelsFile(this.userFilePath)) ?? {
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
    this.file = await readMergedFiles(this.userFilePath, this.projectFilePath);
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
  const file = await readMergedFiles(userFilePath, projectFilePath);
  return new ModelProviderRegistry(userFilePath, projectFilePath, file, env);
}
