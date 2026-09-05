import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export type StageModelKey =
  | "refine"
  | "research"
  | "grill"
  | "compose"
  | "implement"
  | "critique";

export interface InitConfig {
  /** Shell command to run before implementation, or undefined when disabled/not detected. */
  start?: string;
  /** Shell command to run at final completion, or undefined when disabled/not detected. */
  check?: string;
}

/**
 * The implement-experiment loop (docs/plans/loop-driver-v2.md). Opt-in: `enabled` false keeps
 * implement agent-owned. `validate`/`metric` are executed by the loop and are NEVER aliased
 * from `init.*` (AGENTS.md: init commands are never executed).
 */
export interface LoopConfig {
  enabled: boolean;
  /** Shell command whose exit code 0 means the iteration validated. */
  validate?: string;
  /** Shell command printing `METRIC <name>=<value>`; absent ⇒ validation-only fitness. */
  metric?: string;
  /** Name matched in the `METRIC <name>=<value>` line; defaults to any name. */
  metric_name?: string;
  direction: "higher" | "lower";
  /**
   * `strict-metric` preserves the original optimizer rule. In
   * `agent-with-validation`, the fresh iteration agent chooses keep/revert but
   * a failed validation or an unmeasured configured metric still cannot land.
   */
  decisionPolicy: "strict-metric" | "agent-with-validation";
  /** Metric value at which a `complete` iteration counts as SUCCESS. */
  target?: number;
  /**
   * Already-known baseline metric. When set, the loop trusts it and skips measuring the
   * baseline. This exists for measurements that cost hours of wall-clock or a scheduler
   * allocation: re-deriving a value that is already recorded evidence is pure waste.
   */
  baselineMetric?: number;
  maxIterations: number;
  /** Stop after this many consecutive discards. */
  noImprovementStreak: number;
  measureTimeoutMs: number;
  /** Opt-in `.kanban/hooks/{before,after}-iteration` execution. */
  hooks: boolean;
  /**
   * Write one commit per iteration — kept OR discarded — to the separate `kanban-audit/<base>`
   * ref. Iteration worktrees are disposable, so this is the only way evidence produced by a
   * measurement survives. It never touches the accepted-experiment branch.
   */
  audit: boolean;
  /**
   * Pathspecs force-added into each audit commit. Evidence written under a gitignored path
   * therefore reaches the audit ref while staying out of the accepted commit and the landed
   * patch. Requires `audit`.
   */
  auditPaths?: string[];
  /** Resume an interrupted durable experiment when the session opens. */
  autoResume: boolean;
  /** Named, explicitly configured commands available to the iteration coordinator. */
  jobs?: Record<string, JobAdapterConfig>;
  maxConcurrentChildren?: number;
  /** Campaign-wide limits; omitted limits are left to the configured adapter/site policy. */
  maxSubmissions?: number;
  maxChildRuns?: number;
  maxCoordinatorTurns?: number;
}

export interface JobAdapterConfig {
  kind: "local" | "scheduled";
  /** Local command, or scheduler submit operation. No command comes from a child tool call. */
  command?: string;
  submit?: string;
  status?: string;
  cancel?: string;
  collect?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  operationTimeoutMs?: number;
}

export interface KanbanConfig {
  /** Per-stage model as "provider:model-id"; null → the parent session's current model. */
  models: Record<StageModelKey, string | null>;
  research: { workers: 1 | 2 | 3; depth?: "focused" | "deep" };
  compose?: { detail: "plan" | "concise" | "detailed" };
  pipeline?: { childTimeoutMs: number };
  fastPath: boolean;
  critique: boolean;
  runner: "auto" | "inprocess" | "subprocess";
  /** Subprocess backend binary (PATH lookup). */
  piBin: string;
  /** Resolved init commands ("auto" already resolved against the repository). */
  init: InitConfig;
  loop: LoopConfig;
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
  compose: NonNullable<KanbanConfig["compose"]>;
  pipeline: NonNullable<KanbanConfig["pipeline"]>;
  fastPath: boolean;
  critique: boolean;
  runner: KanbanConfig["runner"];
  piBin: string;
  init: RawInitConfig;
  loop: LoopConfig;
}

interface ConfigLayer {
  models?: Partial<KanbanConfig["models"]>;
  research?: Partial<KanbanConfig["research"]>;
  compose?: Partial<NonNullable<KanbanConfig["compose"]>>;
  pipeline?: Partial<NonNullable<KanbanConfig["pipeline"]>>;
  fastPath?: boolean;
  critique?: boolean;
  runner?: KanbanConfig["runner"];
  piBin?: string;
  init?: Partial<RawInitConfig>;
  loop?: Partial<LoopConfig>;
}

const StageModelKeys: StageModelKey[] = [
  "refine",
  "research",
  "grill",
  "compose",
  "implement",
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
const DirectionSchema = Type.Union([
  Type.Literal("higher"),
  Type.Literal("lower"),
]);
const DecisionPolicySchema = Type.Union([
  Type.Literal("strict-metric"),
  Type.Literal("agent-with-validation"),
]);
const PositiveIntegerSchema = Type.Integer({ minimum: 1 });
const BudgetSchema = Type.Integer({ minimum: 0 });
const DepthSchema = Type.Union([Type.Literal("focused"), Type.Literal("deep")]);
const DetailSchema = Type.Union([Type.Literal("plan"), Type.Literal("concise"), Type.Literal("detailed")]);
const ChildTimeoutSchema = Type.Integer({ minimum: 1000, maximum: 3_600_000 });
const FiniteNumberSchema = Type.Number();
const PathListSchema = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 });
export const JobAdapterSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("local"), command: Type.String({ minLength: 1 }),
    timeoutMs: Type.Optional(PositiveIntegerSchema),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("scheduled"),
    submit: Type.String({ minLength: 1 }), status: Type.String({ minLength: 1 }),
    cancel: Type.String({ minLength: 1 }), collect: Type.String({ minLength: 1 }),
    pollIntervalMs: Type.Optional(PositiveIntegerSchema),
    timeoutMs: Type.Optional(PositiveIntegerSchema),
    operationTimeoutMs: Type.Optional(PositiveIntegerSchema),
  }, { additionalProperties: false }),
]);
const JobsSchema = Type.Record(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$" }), JobAdapterSchema, { additionalProperties: false });
const LoopValueSchemas = {
  enabled: BooleanSchema,
  validate: StringSchema,
  metric: StringSchema,
  metric_name: StringSchema,
  direction: DirectionSchema,
  decisionPolicy: DecisionPolicySchema,
  target: FiniteNumberSchema,
  baselineMetric: FiniteNumberSchema,
  maxIterations: PositiveIntegerSchema,
  noImprovementStreak: PositiveIntegerSchema,
  measureTimeoutMs: PositiveIntegerSchema,
  hooks: BooleanSchema,
  audit: BooleanSchema,
  auditPaths: PathListSchema,
  autoResume: BooleanSchema,
  jobs: JobsSchema,
  maxConcurrentChildren: PositiveIntegerSchema,
  maxSubmissions: BudgetSchema,
  maxChildRuns: BudgetSchema,
  maxCoordinatorTurns: BudgetSchema,
} as const;
const LoopKeys = Object.keys(LoopValueSchemas) as Array<keyof LoopConfig>;
const LoopSchema = Type.Object(
  {
    enabled: BooleanSchema,
    validate: Type.Optional(StringSchema),
    metric: Type.Optional(StringSchema),
    metric_name: Type.Optional(StringSchema),
    direction: DirectionSchema,
    decisionPolicy: DecisionPolicySchema,
    target: Type.Optional(FiniteNumberSchema),
    baselineMetric: Type.Optional(FiniteNumberSchema),
    maxIterations: PositiveIntegerSchema,
    noImprovementStreak: PositiveIntegerSchema,
    measureTimeoutMs: PositiveIntegerSchema,
    hooks: BooleanSchema,
    audit: BooleanSchema,
    auditPaths: Type.Optional(PathListSchema),
    autoResume: BooleanSchema,
    jobs: Type.Optional(JobsSchema),
    maxConcurrentChildren: Type.Optional(PositiveIntegerSchema),
    maxSubmissions: Type.Optional(BudgetSchema),
    maxChildRuns: Type.Optional(BudgetSchema),
    maxCoordinatorTurns: Type.Optional(BudgetSchema),
  },
  { additionalProperties: false },
);

/** A main-conversation goal revision may explicitly change these run settings. */
export const LoopRevisionSchema = { ...Type.Partial(Type.Object(LoopValueSchemas)), additionalProperties: false };

export function validateLoopRevision(value: unknown): asserts value is Partial<LoopConfig> {
  if (!Value.Check(LoopRevisionSchema, value)) throw new Error("Invalid loop settings in goal revision");
  const patch = value as Partial<LoopConfig>;
  for (const number of [patch.target, patch.baselineMetric])
    if (number !== undefined && !Number.isFinite(number)) throw new Error("Loop metrics must be finite");
  if (patch.enabled === false) throw new Error("Stop the loop before disabling it");
}

const RawConfigSchema = Type.Object(
  {
    models: Type.Object({
      refine: ModelValueSchema,
      research: ModelValueSchema,
      grill: ModelValueSchema,
      compose: ModelValueSchema,
      implement: ModelValueSchema,
      critique: ModelValueSchema,
    }),
    research: Type.Object({ workers: WorkersSchema, depth: DepthSchema }),
    compose: Type.Object({ detail: DetailSchema }),
    pipeline: Type.Object({ childTimeoutMs: ChildTimeoutSchema }),
    fastPath: BooleanSchema,
    critique: BooleanSchema,
    runner: RunnerSchema,
    piBin: StringSchema,
    init: Type.Object({ start: InitValueSchema, check: InitValueSchema }),
    loop: LoopSchema,
  },
  { additionalProperties: false },
);

const defaults: RawConfig = {
  models: {
    refine: null,
    research: null,
    grill: null,
    compose: null,
    implement: null,
    critique: null,
  },
  research: { workers: 2, depth: "focused" },
  compose: { detail: "plan" },
  pipeline: { childTimeoutMs: 300_000 },
  fastPath: true,
  critique: true,
  runner: "auto",
  piBin: "pi",
  init: { start: "auto", check: "auto" },
  loop: {
    enabled: false,
    direction: "higher",
    decisionPolicy: "agent-with-validation",
    maxIterations: 50,
    noImprovementStreak: 8,
    measureTimeoutMs: 300_000,
    hooks: false,
    audit: false,
    autoResume: false,
  },
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
      ![
        "models",
        "research",
        "compose",
        "pipeline",
        "fastPath",
        "critique",
        "runner",
        "piBin",
        "init",
        "loop",
      ].includes(key)
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
        if (researchKey !== "workers" && researchKey !== "depth") {
          unknown(warnings, `${source}.research`, researchKey);
          continue;
        }
        if (!Value.Check(researchKey === "workers" ? WorkersSchema : DepthSchema, researchValue)) {
          invalid(warnings, `${source}.research`, researchKey);
          continue;
        }
        research[researchKey] = researchValue as never;
      }
      layer.research = research;
      continue;
    }

    if (key === "compose" || key === "pipeline") {
      if (!isRecord(entry)) {
        invalid(warnings, source, key);
        continue;
      }
      for (const [field, fieldValue] of Object.entries(entry)) {
        const expected = key === "compose" ? "detail" : "childTimeoutMs";
        if (field !== expected) {
          unknown(warnings, `${source}.${key}`, field);
          continue;
        }
        if (!Value.Check(key === "compose" ? DetailSchema : ChildTimeoutSchema, fieldValue)) {
          invalid(warnings, `${source}.${key}`, field);
          continue;
        }
        if (key === "compose") layer.compose = { detail: fieldValue as "plan" | "concise" | "detailed" };
        else layer.pipeline = { childTimeoutMs: fieldValue as number };
      }
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

    if (key === "loop") {
      if (!isRecord(entry)) {
        invalid(warnings, source, key);
        continue;
      }
      const loop: Partial<LoopConfig> = {};
      for (const [loopKey, loopValue] of Object.entries(entry)) {
        if (!LoopKeys.includes(loopKey as keyof LoopConfig)) {
          unknown(warnings, `${source}.loop`, loopKey);
          continue;
        }

        const typedKey = loopKey as keyof LoopConfig;
        // Null is deliberately invalid for optional loop commands. Unlike init's resolved
        // values, loop layers have no null "unset" sentinel: accepting one would make a
        // higher-precedence layer silently erase a command. Users remove the key instead.
        if (
          !Value.Check(LoopValueSchemas[typedKey], loopValue) ||
          ((typedKey === "target" || typedKey === "baselineMetric") &&
            !Number.isFinite(loopValue))
        ) {
          invalid(warnings, `${source}.loop`, loopKey);
          continue;
        }
        loop[typedKey] = loopValue as never;
      }
      layer.loop = loop;
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
      compose: { ...merged.compose, ...layer.compose },
      pipeline: { ...merged.pipeline, ...layer.pipeline },
      init: { ...merged.init, ...layer.init },
      loop: { ...merged.loop, ...layer.loop },
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
        loop: { ...defaults.loop },
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
      compose: { ...merged.compose },
      pipeline: { ...merged.pipeline },
      fastPath: merged.fastPath,
      critique: merged.critique,
      runner: merged.runner,
      piBin: merged.piBin,
      init: {
        ...(start === undefined ? {} : { start }),
        ...(check === undefined ? {} : { check }),
      },
      loop: { ...merged.loop },
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
