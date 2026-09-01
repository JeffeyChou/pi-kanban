import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export type StageModelKey = "refine" | "research" | "grill" | "compose" | "critique";

export interface InitConfig {
  /** Shell command to run before implementation, or undefined when disabled/not detected. */
  start?: string;
  /** Shell command to run at final completion, or undefined when disabled/not detected. */
  check?: string;
}

export interface KanbanConfig {
  /** Per-stage model as "provider:model-id"; null → the parent session's current model. */
  models: Record<StageModelKey, string | null>;
  research: { workers: 1 | 2 | 3 };
  fastPath: boolean;
  critique: boolean;
  runner: "auto" | "inprocess" | "subprocess";
  /** Subprocess backend binary (PATH lookup). */
  piBin: string;
  /** Resolved init commands ("auto" already resolved against the repository). */
  init: InitConfig;
}

export interface LoadedConfig {
  config: KanbanConfig;
  /** Human-readable validation warnings (unknown keys, invalid values). */
  warnings: string[];
}

type RawInitConfig = Record<"start" | "check", string | null>;

interface RawConfig {
  models: KanbanConfig["models"];
  research: KanbanConfig["research"];
  fastPath: boolean;
  critique: boolean;
  runner: KanbanConfig["runner"];
  piBin: string;
  init: RawInitConfig;
}

interface ConfigLayer {
  models?: Partial<KanbanConfig["models"]>;
  research?: Partial<KanbanConfig["research"]>;
  fastPath?: boolean;
  critique?: boolean;
  runner?: KanbanConfig["runner"];
  piBin?: string;
  init?: Partial<RawInitConfig>;
}

const StageModelKeys: StageModelKey[] = [
  "refine",
  "research",
  "grill",
  "compose",
  "critique",
];

const ModelValueSchema = Type.Union([Type.String(), Type.Null()]);
const WorkersSchema = Type.Union([
  Type.Literal(1),
  Type.Literal(2),
  Type.Literal(3),
]);
const RunnerSchema = Type.Union([
  Type.Literal("auto"),
  Type.Literal("inprocess"),
  Type.Literal("subprocess"),
]);
const BooleanSchema = Type.Boolean();
const StringSchema = Type.String();
const InitValueSchema = Type.Union([Type.String(), Type.Null()]);
const RawConfigSchema = Type.Object(
  {
    models: Type.Object({
      refine: ModelValueSchema,
      research: ModelValueSchema,
      grill: ModelValueSchema,
      compose: ModelValueSchema,
      critique: ModelValueSchema,
    }),
    research: Type.Object({ workers: WorkersSchema }),
    fastPath: BooleanSchema,
    critique: BooleanSchema,
    runner: RunnerSchema,
    piBin: StringSchema,
    init: Type.Object({ start: InitValueSchema, check: InitValueSchema }),
  },
  { additionalProperties: false },
);

const defaults: RawConfig = {
  models: {
    refine: null,
    research: null,
    grill: null,
    compose: null,
    critique: null,
  },
  research: { workers: 3 },
  fastPath: true,
  critique: true,
  runner: "auto",
  piBin: "pi",
  init: { start: "auto", check: "auto" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(warnings: string[], source: string, key: string): void {
  warnings.push(`Invalid config value for ${source}.${key}; ignored.`);
}

function unknown(warnings: string[], source: string, key: string): void {
  warnings.push(`Unknown config key ${source}.${key}; ignored.`);
}

function configLayer(
  value: unknown,
  source: string,
  warnings: string[],
): ConfigLayer {
  if (!isRecord(value)) {
    warnings.push(`Invalid config file ${source}; expected a JSON object and ignored it.`);
    return {};
  }

  const layer: ConfigLayer = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      !["models", "research", "fastPath", "critique", "runner", "piBin", "init"].includes(
        key,
      )
    ) {
      unknown(warnings, source, key);
      continue;
    }

    if (key === "models") {
      if (!isRecord(entry)) {
        invalid(warnings, source, key);
        continue;
      }
      const models: Partial<KanbanConfig["models"]> = {};
      for (const [modelKey, modelValue] of Object.entries(entry)) {
        if (!StageModelKeys.includes(modelKey as StageModelKey)) {
          unknown(warnings, `${source}.models`, modelKey);
          continue;
        }
        if (!Value.Check(ModelValueSchema, modelValue)) {
          invalid(warnings, `${source}.models`, modelKey);
          continue;
        }
        models[modelKey as StageModelKey] = modelValue;
      }
      layer.models = models;
      continue;
    }

    if (key === "research") {
      if (!isRecord(entry)) {
        invalid(warnings, source, key);
        continue;
      }
      const research: Partial<KanbanConfig["research"]> = {};
      for (const [researchKey, researchValue] of Object.entries(entry)) {
        if (researchKey !== "workers") {
          unknown(warnings, `${source}.research`, researchKey);
          continue;
        }
        if (!Value.Check(WorkersSchema, researchValue)) {
          invalid(warnings, `${source}.research`, researchKey);
          continue;
        }
        research.workers = researchValue;
      }
      layer.research = research;
      continue;
    }

    if (key === "init") {
      if (!isRecord(entry)) {
        invalid(warnings, source, key);
        continue;
      }
      const init: Partial<RawInitConfig> = {};
      for (const [initKey, initValue] of Object.entries(entry)) {
        if (initKey !== "start" && initKey !== "check") {
          unknown(warnings, `${source}.init`, initKey);
          continue;
        }
        if (!Value.Check(InitValueSchema, initValue)) {
          invalid(warnings, `${source}.init`, initKey);
          continue;
        }
        init[initKey] = initValue;
      }
      layer.init = init;
      continue;
    }

    if (key === "fastPath" || key === "critique") {
      if (!Value.Check(BooleanSchema, entry)) {
        invalid(warnings, source, key);
        continue;
      }
      layer[key] = entry;
      continue;
    }

    if (key === "runner") {
      if (!Value.Check(RunnerSchema, entry)) {
        invalid(warnings, source, key);
        continue;
      }
      layer.runner = entry;
      continue;
    }

    if (!Value.Check(StringSchema, entry)) {
      invalid(warnings, source, key);
      continue;
    }
    layer.piBin = entry;
  }
  return layer;
}

function mergeConfig(...layers: ConfigLayer[]): RawConfig {
  return layers.reduce<RawConfig>(
    (merged, layer) => ({
      ...merged,
      ...("fastPath" in layer ? { fastPath: layer.fastPath! } : {}),
      ...("critique" in layer ? { critique: layer.critique! } : {}),
      ...("runner" in layer ? { runner: layer.runner! } : {}),
      ...("piBin" in layer ? { piBin: layer.piBin! } : {}),
      models: { ...merged.models, ...layer.models },
      research: { ...merged.research, ...layer.research },
      init: { ...merged.init, ...layer.init },
    }),
    defaults,
  );
}

async function readLayer(
  path: string,
  source: string,
  warnings: string[],
): Promise<ConfigLayer> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    warnings.push(
      `Unable to read config file ${source}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
  try {
    return configLayer(JSON.parse(content), source, warnings);
  } catch (error: unknown) {
    warnings.push(
      `Invalid JSON in config file ${source}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}

async function executableInit(cwd: string): Promise<boolean> {
  try {
    await access(join(cwd, "init.sh"), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveInitCommand(
  value: string | null,
  automatic: boolean,
  command: string,
): string | undefined {
  if (value === null) return undefined;
  if (value === "auto") return automatic ? command : undefined;
  return value;
}

/**
 * Merge defaults ← <agentDir>/extensions/kanban.json ← <cwd>/.kanban/config.json,
 * validate, and resolve "auto" init detection (executable ./init.sh).
 */
export async function loadConfig(
  cwd: string,
  agentDir?: string,
): Promise<LoadedConfig> {
  const warnings: string[] = [];
  const resolvedAgentDir = agentDir ?? getAgentDir();
  const userPath = join(resolvedAgentDir, "extensions", "kanban.json");
  const projectPath = join(cwd, ".kanban", "config.json");
  const merged = mergeConfig(
    await readLayer(userPath, userPath, warnings),
    await readLayer(projectPath, projectPath, warnings),
  );

  if (!Value.Check(RawConfigSchema, merged)) {
    // This should be unreachable because defaults and every accepted field are TypeBox-checked.
    warnings.push("Merged Kanban config failed validation; using defaults.");
    return {
      config: {
        ...defaults,
        models: { ...defaults.models },
        research: { ...defaults.research },
        init: {},
      },
      warnings,
    };
  }

  const automaticInit = await executableInit(cwd);
  const start = resolveInitCommand(merged.init.start, automaticInit, "./init.sh");
  const check = resolveInitCommand(
    merged.init.check,
    automaticInit,
    "./init.sh --check",
  );
  return {
    config: {
      models: { ...merged.models },
      research: { ...merged.research },
      fastPath: merged.fastPath,
      critique: merged.critique,
      runner: merged.runner,
      piBin: merged.piBin,
      init: {
        ...(start === undefined ? {} : { start }),
        ...(check === undefined ? {} : { check }),
      },
    },
    warnings,
  };
}

/** Resolve a "provider:model-id" config string against the registry; undefined on failure. */
export function resolveConfigModel(
  ctx: ExtensionContext,
  spec: string | null,
): unknown {
  if (spec === null) return ctx.model;
  const separator = spec.indexOf(":");
  if (separator <= 0 || separator === spec.length - 1) return undefined;
  const provider = spec.slice(0, separator);
  const modelId = spec.slice(separator + 1);
  return ctx.modelRegistry.find(provider, modelId);
}
