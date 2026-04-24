/**
 * Model Capabilities — capability detection and routing for multi-model orchestration.
 *
 * This module provides:
 * - Model capability definitions (context window, tools, vision, etc.)
 * - Task requirement matching
 * - Model routing logic
 * - Fallback chain configuration
 */

// ============================================================================
// Capability Types
// ============================================================================

/**
 * Model capability flags.
 */
export interface ModelCapabilities {
  /** Maximum context window in tokens */
  contextWindow: number;
  /** Maximum output tokens */
  maxOutputTokens: number;
  /** Supports parallel tool calls */
  parallelToolCalls: boolean;
  /** Supports vision/image input */
  vision: boolean;
  /** Supports structured outputs */
  structuredOutputs: boolean;
  /** Supports streaming */
  streaming: boolean;
  /** Reasoning capability level */
  reasoning: "none" | "basic" | "extended";
  /** Code generation quality level */
  codeQuality: "basic" | "good" | "excellent";
  /** Speed tier */
  speed: "slow" | "medium" | "fast";
  /** Cost tier */
  cost: "low" | "medium" | "high";
}

/**
 * Task requirements for model selection.
 */
export interface TaskRequirements {
  /** Minimum context window needed */
  minContextWindow?: number;
  /** Minimum output tokens needed */
  minOutputTokens?: number;
  /** Requires vision capability */
  requiresVision?: boolean;
  /** Requires structured outputs */
  requiresStructuredOutputs?: boolean;
  /** Reasoning level needed */
  reasoning?: "none" | "basic" | "extended";
  /** Code quality needed */
  codeQuality?: "basic" | "good" | "excellent";
  /** Speed preference */
  speedPreference?: "fast" | "balanced" | "quality";
  /** Cost preference */
  costPreference?: "low" | "medium" | "any";
}

/**
 * A model entry in the registry.
 */
export interface ModelEntry {
  /** Model identifier */
  id: string;
  /** Full handle (provider/model) */
  handle: string;
  /** Human-readable label */
  label: string;
  /** Description */
  description?: string;
  /** Capabilities */
  capabilities: ModelCapabilities;
  /** Whether this is a default model */
  isDefault?: boolean;
  /** Whether this model is free */
  free?: boolean;
  /** Whether this is a featured model */
  isFeatured?: boolean;
}

/**
 * Model selection result.
 */
export interface ModelSelection {
  /** Selected model */
  model: ModelEntry;
  /** Why this model was selected */
  reason: string;
  /** Score (0-1) for ranking */
  score: number;
  /** Whether this is a fallback */
  isFallback: boolean;
}

// ============================================================================
// Capability Inference
// ============================================================================

/**
 * Infer capabilities from model handle and metadata.
 */
export function inferCapabilities(
  handle: string,
  metadata?: {
    context_window?: number;
    max_output_tokens?: number;
    parallel_tool_calls?: boolean;
  },
): ModelCapabilities {
  const provider = handle.split("/")[0]?.toLowerCase() ?? "";
  const model = handle.split("/")[1]?.toLowerCase() ?? "";

  // Base capabilities from metadata
  const contextWindow = metadata?.context_window ?? 128000;
  const maxOutputTokens = metadata?.max_output_tokens ?? 4096;
  const parallelToolCalls = metadata?.parallel_tool_calls ?? false;

  // Infer vision capability
  const vision = /vision|gemini|gpt-4o|gpt-4-turbo|claude-3|sonnet|opus/i.test(
    handle,
  );

  // Infer reasoning level
  let reasoning: ModelCapabilities["reasoning"] = "basic";
  if (/o1|o3|reasoning|extended/i.test(handle)) {
    reasoning = "extended";
  } else if (/haiku|fast|mini/i.test(handle)) {
    reasoning = "basic";
  }

  // Infer code quality
  let codeQuality: ModelCapabilities["codeQuality"] = "good";
  if (/opus|o1|o3|sonnet|gpt-4|gemini-pro/i.test(handle)) {
    codeQuality = "excellent";
  } else if (/haiku|mini|fast/i.test(handle)) {
    codeQuality = "basic";
  }

  // Infer speed
  let speed: ModelCapabilities["speed"] = "medium";
  if (/haiku|fast|mini|turbo/i.test(handle)) {
    speed = "fast";
  } else if (/opus|o1|o3|reasoning/i.test(handle)) {
    speed = "slow";
  }

  // Infer cost
  let cost: ModelCapabilities["cost"] = "medium";
  if (/haiku|mini|fast|free/i.test(handle)) {
    cost = "low";
  } else if (/opus|o1|o3|gpt-4/i.test(handle)) {
    cost = "high";
  }

  return {
    contextWindow,
    maxOutputTokens,
    parallelToolCalls,
    vision,
    structuredOutputs: provider === "anthropic" || provider === "openai",
    streaming: true,
    reasoning,
    codeQuality,
    speed,
    cost,
  };
}

// ============================================================================
// Model Registry
// ============================================================================

/**
 * In-memory model registry.
 */
const modelRegistry: Map<string, ModelEntry> = new Map();

/**
 * Register a model in the registry.
 */
export function registerModel(entry: ModelEntry): void {
  modelRegistry.set(entry.id, entry);
  modelRegistry.set(entry.handle, entry); // Also by handle
}

/**
 * Get a model by ID or handle.
 */
export function getModel(identifier: string): ModelEntry | undefined {
  return modelRegistry.get(identifier);
}

/**
 * Get all registered models.
 */
export function getAllModels(): ModelEntry[] {
  const seen = new Set<string>();
  const result: ModelEntry[] = [];
  for (const entry of modelRegistry.values()) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      result.push(entry);
    }
  }
  return result;
}

/**
 * Get default models.
 */
export function getDefaultModels(): ModelEntry[] {
  return getAllModels().filter((m) => m.isDefault || m.isFeatured);
}

// ============================================================================
// Model Selection
// ============================================================================

/**
 * Score a model against task requirements.
 */
function scoreModel(
  model: ModelEntry,
  requirements: TaskRequirements,
): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];

  const caps = model.capabilities;

  // Context window check
  if (requirements.minContextWindow) {
    if (caps.contextWindow >= requirements.minContextWindow) {
      score += 0.2;
    } else {
      return { score: 0, reason: "Insufficient context window" };
    }
  }

  // Output tokens check
  if (requirements.minOutputTokens) {
    if (caps.maxOutputTokens >= requirements.minOutputTokens) {
      score += 0.1;
    } else {
      return { score: 0, reason: "Insufficient output tokens" };
    }
  }

  // Vision check
  if (requirements.requiresVision && !caps.vision) {
    return { score: 0, reason: "Vision required but not supported" };
  }
  if (requirements.requiresVision && caps.vision) {
    score += 0.1;
  }

  // Structured outputs check
  if (requirements.requiresStructuredOutputs && !caps.structuredOutputs) {
    return {
      score: 0,
      reason: "Structured outputs required but not supported",
    };
  }

  // Reasoning level
  if (requirements.reasoning) {
    const reasoningScores = { none: 0, basic: 1, extended: 2 };
    const reqLevel = reasoningScores[requirements.reasoning];
    const modelLevel = reasoningScores[caps.reasoning];
    if (modelLevel < reqLevel) {
      return { score: 0, reason: "Insufficient reasoning capability" };
    }
    score += 0.15;
  }

  // Code quality
  if (requirements.codeQuality) {
    const qualityScores = { basic: 1, good: 2, excellent: 3 };
    const reqLevel = qualityScores[requirements.codeQuality];
    const modelLevel = qualityScores[caps.codeQuality];
    if (modelLevel < reqLevel) {
      score -= 0.1;
      reasons.push("Lower code quality than preferred");
    } else {
      score += 0.1;
    }
  }

  // Speed preference
  if (requirements.speedPreference === "fast" && caps.speed === "fast") {
    score += 0.15;
  } else if (
    requirements.speedPreference === "quality" &&
    caps.speed === "slow"
  ) {
    score += 0.15;
  } else if (
    requirements.speedPreference === "balanced" &&
    caps.speed === "medium"
  ) {
    score += 0.1;
  }

  // Cost preference
  if (requirements.costPreference === "low" && caps.cost === "low") {
    score += 0.1;
  } else if (requirements.costPreference === "low" && caps.cost !== "low") {
    score -= 0.05;
  }

  // Bonus for featured/default models
  if (model.isDefault) score += 0.05;
  if (model.isFeatured) score += 0.03;
  if (model.free) score += 0.02;

  // Bonus for larger context (up to +0.1)
  score += Math.min(0.1, caps.contextWindow / 2_000_000);

  return {
    score: Math.min(1, score),
    reason: reasons.join("; ") || "Matches requirements",
  };
}

/**
 * Select the best model for task requirements.
 */
export function selectModel(
  requirements: TaskRequirements = {},
): ModelSelection | undefined {
  const models = getAllModels();
  if (models.length === 0) return undefined;

  const scored: Array<{ model: ModelEntry; score: number; reason: string }> =
    [];

  for (const model of models) {
    const result = scoreModel(model, requirements);
    if (result.score > 0) {
      scored.push({ model, ...result });
    }
  }

  if (scored.length === 0) return undefined;

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  return {
    model: best.model,
    reason: best.reason,
    score: best.score,
    isFallback: false,
  };
}

/**
 * Get fallback chain for a model.
 */
export function getFallbackChain(
  primaryModel: string,
  requirements: TaskRequirements = {},
): ModelEntry[] {
  const primary = getModel(primaryModel);
  if (!primary) return [];

  const models = getAllModels()
    .filter((m) => m.id !== primary.id && m.handle !== primary.handle)
    .map((model) => ({ model, ...scoreModel(model, requirements) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.model);

  return models;
}

// ============================================================================
// Default Models
// ============================================================================

/**
 * Initialize default models in the registry.
 */
export function initializeDefaultModels(): void {
  const defaults: Array<
    Omit<ModelEntry, "capabilities"> & {
      capabilities: Partial<ModelCapabilities>;
    }
  > = [
    {
      id: "auto",
      handle: "letta/auto",
      label: "Auto",
      description: "Automatically select the best model",
      isDefault: true,
      isFeatured: true,
      free: true,
      capabilities: {
        contextWindow: 140000,
        maxOutputTokens: 28000,
        speed: "medium",
      },
    },
    {
      id: "auto-fast",
      handle: "letta/auto-fast",
      label: "Auto Fast",
      description: "Automatically select the best fast model",
      isFeatured: true,
      free: true,
      capabilities: {
        contextWindow: 140000,
        maxOutputTokens: 28000,
        speed: "fast",
      },
    },
    {
      id: "sonnet",
      handle: "anthropic/claude-sonnet-4-6",
      label: "Sonnet 4.6",
      description: "Anthropic's Sonnet model (high reasoning)",
      isFeatured: true,
      capabilities: {
        contextWindow: 200000,
        maxOutputTokens: 16000,
        codeQuality: "excellent",
      },
    },
    {
      id: "opus",
      handle: "anthropic/claude-opus-4-5",
      label: "Opus 4.5",
      description: "Anthropic's most capable model",
      capabilities: {
        contextWindow: 200000,
        maxOutputTokens: 32000,
        codeQuality: "excellent",
        reasoning: "extended",
      },
    },
    {
      id: "haiku",
      handle: "anthropic/claude-haiku-3-5",
      label: "Haiku 3.5",
      description: "Fast and efficient model",
      capabilities: {
        contextWindow: 200000,
        maxOutputTokens: 8192,
        speed: "fast",
        cost: "low",
      },
    },
  ];

  for (const entry of defaults) {
    const capabilities = {
      ...inferCapabilities(entry.handle),
      ...entry.capabilities,
    } as ModelCapabilities;

    registerModel({
      ...entry,
      capabilities,
    });
  }
}

// Auto-initialize
initializeDefaultModels();
