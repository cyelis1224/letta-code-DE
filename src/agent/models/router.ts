/**
 * Model Router — routing logic for selecting models based on task context.
 *
 * The router integrates with:
 * - Context compiler (task kind)
 * - Operation modes (mode-specific model preferences)
 * - Memory pipeline (context budget)
 */

import type { TaskKind } from "../eim/types";
import type { OperationMode } from "../modes/types";
import {
  getAllModels,
  getFallbackChain,
  getModel,
  type ModelEntry,
  type ModelSelection,
  selectModel,
  type TaskRequirements,
} from "./capabilities";

// ============================================================================
// Routing Configuration
// ============================================================================

/**
 * Model routing preferences for a task.
 */
export interface RoutingPreferences {
  /** Preferred model ID or handle */
  preferredModel?: string;
  /** Model constraints */
  requirements: TaskRequirements;
  /** Maximum fallback chain length */
  maxFallbacks: number;
  /** Whether to allow slow models */
  allowSlow: boolean;
  /** Whether to allow expensive models */
  allowExpensive: boolean;
}

/**
 * Task kind to requirements mapping.
 */
const TASK_REQUIREMENTS_BY_KIND: Record<TaskKind, TaskRequirements> = {
  casual: {
    speedPreference: "fast",
    costPreference: "low",
  },
  coding: {
    codeQuality: "excellent",
    speedPreference: "balanced",
  },
  research: {
    minContextWindow: 100000,
    reasoning: "extended",
    speedPreference: "quality",
  },
  design: {
    codeQuality: "good",
    speedPreference: "balanced",
  },
  creative: {
    speedPreference: "quality",
    costPreference: "any",
  },
  reflection: {
    speedPreference: "fast",
    costPreference: "low",
    minContextWindow: 50000,
  },
  governance: {
    codeQuality: "good",
    reasoning: "basic",
    speedPreference: "balanced",
  },
};

/**
 * Operation mode to requirements mapping.
 */
const MODE_REQUIREMENTS: Partial<Record<OperationMode, TaskRequirements>> = {
  chat: {
    speedPreference: "fast",
    costPreference: "low",
  },
  coding: {
    codeQuality: "excellent",
    speedPreference: "balanced",
  },
  research: {
    minContextWindow: 100000,
    reasoning: "extended",
  },
  reflection: {
    speedPreference: "fast",
    costPreference: "low",
  },
};

// ============================================================================
// Routing Functions
// ============================================================================

/**
 * Get requirements for a task kind.
 */
export function getRequirementsForTask(taskKind: TaskKind): TaskRequirements {
  return TASK_REQUIREMENTS_BY_KIND[taskKind] ?? {};
}

/**
 * Get requirements for an operation mode.
 */
export function getRequirementsForMode(mode: OperationMode): TaskRequirements {
  return MODE_REQUIREMENTS[mode] ?? {};
}

/**
 * Route to the best model for a task.
 */
export function routeModel(
  taskKind: TaskKind,
  options?: {
    mode?: OperationMode;
    preferredModel?: string;
    minContextWindow?: number;
    requiresVision?: boolean;
    maxFallbacks?: number;
  },
): ModelSelection {
  // Start with task requirements
  const taskReqs = getRequirementsForTask(taskKind);

  // Merge with mode requirements (mode overrides task)
  const modeReqs = options?.mode ? getRequirementsForMode(options.mode) : {};

  // Build final requirements
  const requirements: TaskRequirements = {
    ...taskReqs,
    ...modeReqs,
    minContextWindow: options?.minContextWindow ?? taskReqs.minContextWindow,
    requiresVision: options?.requiresVision ?? taskReqs.requiresVision,
  };

  // Check for preferred model first
  if (options?.preferredModel) {
    const preferred = getModel(options.preferredModel);
    if (preferred) {
      return {
        model: preferred,
        reason: "User-specified model",
        score: 1,
        isFallback: false,
      };
    }
  }

  // Select best model
  const selection = selectModel(requirements);
  if (selection) {
    return selection;
  }

  // Fallback to first available
  const models = getAllModels();
  if (models.length > 0) {
    return {
      model: models[0]!,
      reason: "Fallback to first available model",
      score: 0,
      isFallback: true,
    };
  }

  // No models available (shouldn't happen in practice)
  throw new Error("No models available in registry");
}

/**
 * Get the full model chain (primary + fallbacks) for a task.
 */
export function getModelChain(
  taskKind: TaskKind,
  options?: {
    mode?: OperationMode;
    preferredModel?: string;
    minContextWindow?: number;
    requiresVision?: boolean;
    maxFallbacks?: number;
  },
): ModelEntry[] {
  const maxFallbacks = options?.maxFallbacks ?? 3;
  const selection = routeModel(taskKind, options);

  const chain: ModelEntry[] = [selection.model];

  if (maxFallbacks > 0) {
    const requirements = getRequirementsForTask(taskKind);
    const fallbacks = getFallbackChain(selection.model.id, requirements);
    chain.push(...fallbacks.slice(0, maxFallbacks));
  }

  return chain;
}

/**
 * Check if a model supports a specific capability.
 */
export function modelSupports(
  modelId: string,
  capability: keyof TaskRequirements,
  value?: unknown,
): boolean {
  const model = getModel(modelId);
  if (!model) return false;

  const caps = model.capabilities;

  switch (capability) {
    case "minContextWindow":
      return typeof value === "number" ? caps.contextWindow >= value : true;
    case "minOutputTokens":
      return typeof value === "number" ? caps.maxOutputTokens >= value : true;
    case "requiresVision":
      return caps.vision;
    case "requiresStructuredOutputs":
      return caps.structuredOutputs;
    case "reasoning":
      if (typeof value === "string") {
        const levels = { none: 0, basic: 1, extended: 2 };
        return levels[caps.reasoning] >= levels[value as keyof typeof levels];
      }
      return true;
    case "codeQuality":
      if (typeof value === "string") {
        const levels = { basic: 0, good: 1, excellent: 2 };
        return levels[caps.codeQuality] >= levels[value as keyof typeof levels];
      }
      return true;
    default:
      return true;
  }
}

// ============================================================================
// Model Health
// ============================================================================

/**
 * Model health status.
 */
export interface ModelHealth {
  modelId: string;
  status: "healthy" | "degraded" | "unhealthy";
  lastCheck: string;
  latency?: number;
  errorRate?: number;
  errorMessage?: string;
}

/**
 * In-memory health tracking.
 */
const modelHealth: Map<string, ModelHealth> = new Map();

/**
 * Update model health status.
 */
export function updateModelHealth(
  modelId: string,
  status: ModelHealth["status"],
  options?: {
    latency?: number;
    errorRate?: number;
    errorMessage?: string;
  },
): void {
  modelHealth.set(modelId, {
    modelId,
    status,
    lastCheck: new Date().toISOString(),
    latency: options?.latency,
    errorRate: options?.errorRate,
    errorMessage: options?.errorMessage,
  });
}

/**
 * Get model health status.
 */
export function getModelHealth(modelId: string): ModelHealth | undefined {
  return modelHealth.get(modelId);
}

/**
 * Check if a model is healthy enough to use.
 */
export function isModelHealthy(modelId: string): boolean {
  const health = modelHealth.get(modelId);
  if (!health) return true; // Unknown models are assumed healthy
  return health.status !== "unhealthy";
}

/**
 * Get healthy models only.
 */
export function getHealthyModels(): ModelEntry[] {
  return getAllModels().filter((m) => isModelHealthy(m.id));
}
