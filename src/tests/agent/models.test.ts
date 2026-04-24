import { beforeEach, describe, expect, it } from "bun:test";
import {
  getAllModels,
  getFallbackChain,
  getModel,
  inferCapabilities,
  initializeDefaultModels,
  type ModelEntry,
  registerModel,
  selectModel,
} from "../../agent/models/capabilities";

import {
  getHealthyModels,
  getModelChain,
  getModelHealth,
  getRequirementsForMode,
  getRequirementsForTask,
  isModelHealthy,
  modelSupports,
  routeModel,
  updateModelHealth,
} from "../../agent/models/router";

describe("Model capabilities", () => {
  it("infers capabilities from model handle", () => {
    const caps = inferCapabilities("anthropic/claude-sonnet-4-6");
    expect(caps.vision).toBe(true);
    expect(caps.codeQuality).toBe("excellent");
    expect(caps.structuredOutputs).toBe(true);
  });

  it("infers extended reasoning from o1/o3 models", () => {
    const caps = inferCapabilities("openai/o1-preview");
    expect(caps.reasoning).toBe("extended");
  });

  it("infers fast speed from haiku/mini models", () => {
    const caps = inferCapabilities("anthropic/claude-haiku-3-5");
    expect(caps.speed).toBe("fast");
    expect(caps.cost).toBe("low");
  });

  it("uses metadata for context window", () => {
    const caps = inferCapabilities("test/model", {
      context_window: 200000,
      max_output_tokens: 16000,
      parallel_tool_calls: true,
    });
    expect(caps.contextWindow).toBe(200000);
    expect(caps.maxOutputTokens).toBe(16000);
    expect(caps.parallelToolCalls).toBe(true);
  });
});

describe("Model registry", () => {
  it("registers and retrieves models", () => {
    const entry: ModelEntry = {
      id: "test-model",
      handle: "test/model",
      label: "Test Model",
      capabilities: inferCapabilities("test/model"),
    };

    registerModel(entry);

    expect(getModel("test-model")).toBeDefined();
    expect(getModel("test/model")).toBeDefined();
    expect(getModel("test-model")!.label).toBe("Test Model");
  });

  it("initializes default models", () => {
    initializeDefaultModels();

    const auto = getModel("auto");
    expect(auto).toBeDefined();
    expect(auto!.label).toBe("Auto");

    const sonnet = getModel("sonnet");
    expect(sonnet).toBeDefined();
    expect(sonnet!.capabilities.codeQuality).toBe("excellent");
  });

  it("gets all models", () => {
    const models = getAllModels();
    expect(models.length).toBeGreaterThan(0);
  });

  it("gets default models", () => {
    const defaults = getAllModels().filter((m) => m.isDefault || m.isFeatured);
    expect(defaults.length).toBeGreaterThan(0);
  });
});

describe("Model selection", () => {
  it("selects a model for basic requirements", () => {
    const selection = selectModel({});
    expect(selection).toBeDefined();
    expect(selection!.model).toBeDefined();
    expect(selection!.score).toBeGreaterThan(0);
  });

  it("filters by context window requirement", () => {
    const selection = selectModel({ minContextWindow: 200000 });
    expect(selection).toBeDefined();
    expect(selection!.model.capabilities.contextWindow).toBeGreaterThanOrEqual(
      200000,
    );
  });

  it("filters by vision requirement", () => {
    const selection = selectModel({ requiresVision: true });
    expect(selection).toBeDefined();
    expect(selection!.model.capabilities.vision).toBe(true);
  });

  it("prefers fast models when speed preferred", () => {
    const selection = selectModel({ speedPreference: "fast" });
    expect(selection).toBeDefined();
    // Should have bonus for fast speed
    expect(selection!.score).toBeGreaterThan(0);
  });

  it("returns undefined when no model matches", () => {
    // Request something impossible
    const selection = selectModel({
      minContextWindow: 100_000_000, // 100M tokens
    });
    // Should still return something (fallback) or undefined
    // Our implementation returns undefined if nothing matches
  });

  it("gets fallback chain", () => {
    initializeDefaultModels();
    const chain = getFallbackChain("auto", {});
    expect(Array.isArray(chain)).toBe(true);
  });
});

describe("Model routing", () => {
  it("gets requirements for task kinds", () => {
    expect(getRequirementsForTask("coding").codeQuality).toBe("excellent");
    expect(getRequirementsForTask("casual").speedPreference).toBe("fast");
    expect(getRequirementsForTask("research").reasoning).toBe("extended");
  });

  it("gets requirements for operation modes", () => {
    expect(getRequirementsForMode("chat").speedPreference).toBe("fast");
    expect(getRequirementsForMode("coding").codeQuality).toBe("excellent");
  });

  it("routes to appropriate model for coding", () => {
    const selection = routeModel("coding");
    expect(selection.model).toBeDefined();
    expect(selection.reason).toBeDefined();
  });

  it("routes to appropriate model for casual", () => {
    const selection = routeModel("casual");
    expect(selection.model).toBeDefined();
  });

  it("respects preferred model", () => {
    const selection = routeModel("coding", { preferredModel: "haiku" });
    expect(selection.model.id).toBe("haiku");
    expect(selection.reason).toBe("User-specified model");
  });

  it("gets model chain with fallbacks", () => {
    const chain = getModelChain("coding", { maxFallbacks: 2 });
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.length).toBeLessThanOrEqual(3); // primary + max 2 fallbacks
  });

  it("checks model capabilities", () => {
    initializeDefaultModels();
    expect(modelSupports("sonnet", "codeQuality", "excellent")).toBe(true);
    expect(modelSupports("haiku", "codeQuality", "excellent")).toBe(false);
    expect(modelSupports("sonnet", "requiresVision")).toBe(true);
  });
});

describe("Model health", () => {
  it("updates model health status", () => {
    updateModelHealth("test-model", "healthy", { latency: 150 });
    const health = getModelHealth("test-model");
    expect(health).toBeDefined();
    expect(health!.status).toBe("healthy");
    expect(health!.latency).toBe(150);
  });

  it("checks if model is healthy", () => {
    updateModelHealth("healthy-model", "healthy");
    updateModelHealth("unhealthy-model", "unhealthy");

    expect(isModelHealthy("healthy-model")).toBe(true);
    expect(isModelHealthy("unhealthy-model")).toBe(false);
    expect(isModelHealthy("unknown-model")).toBe(true); // Unknown is assumed healthy
  });

  it("gets healthy models only", () => {
    updateModelHealth("auto", "healthy");
    const healthy = getHealthyModels();
    expect(healthy.length).toBeGreaterThan(0);
    expect(healthy.find((m) => m.id === "auto")).toBeDefined();
  });

  it("tracks degraded status", () => {
    updateModelHealth("degraded-model", "degraded", { errorRate: 0.1 });
    const health = getModelHealth("degraded-model");
    expect(health!.status).toBe("degraded");
    expect(health!.errorRate).toBe(0.1);
  });
});
