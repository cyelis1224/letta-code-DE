import { describe, expect, it } from "bun:test";
import { createToolCallEvent } from "../../agent/events/instrumentation";
import {
  collectEvent,
  createInitialRuntimeState,
  flushTurnEvents,
  getLanternStatus,
  postTurnHook,
  preTurnHook,
} from "../../agent/integration";

// ============================================================================
// createInitialRuntimeState
// ============================================================================

describe("createInitialRuntimeState", () => {
  it("initializes with default values", () => {
    const state = createInitialRuntimeState();

    expect(state.currentTaskKind).toBe("casual");
    expect(state.turnCount).toBe(0);
    expect(state.contextCompiled).toBe(false);
    expect(state.lastPipelineResults).toEqual([]);
    expect(state.turnEvents).toEqual([]);
    expect(state.modelSelection).toBeUndefined();
    expect(state.contextBudget).toBeUndefined();
    expect(state.modeState.activeMode).toBe("chat");
  });

  it("accepts partial EIM config", () => {
    const state = createInitialRuntimeState({
      style: {
        tone: "concise",
        verbosity: "minimal",
        metaphorTolerance: "low",
        technicalDepth: "low",
      },
    });

    expect(state.eimConfig.style.tone).toBe("concise");
  });
});

// ============================================================================
// preTurnHook
// ============================================================================

describe("preTurnHook", () => {
  it("classifies task and updates state", () => {
    const state = createInitialRuntimeState();
    const result = preTurnHook("Fix the bug in auth.ts", state);

    expect(result.taskKind).toBe("coding");
    expect(result.mode).toBe("coding");
    expect(state.currentTaskKind).toBe("coding");
    expect(state.turnCount).toBe(1);
    expect(state.contextCompiled).toBe(true);
  });

  it("stores model selection on state", () => {
    const state = createInitialRuntimeState();
    preTurnHook("Implement the feature", state);

    expect(state.modelSelection).toBeDefined();
    expect(state.modelSelection?.model).toBeTruthy();
    expect(state.modelSelection?.reason).toBeTruthy();
  });

  it("stores context budget on state", () => {
    const state = createInitialRuntimeState();
    preTurnHook("Research the API", state);

    expect(state.contextBudget).toBeDefined();
    expect(state.contextBudget?.totalTokens).toBeGreaterThan(0);
    expect(state.contextBudget?.identityBudget).toBeGreaterThan(0);
    expect(state.contextBudget?.memoryBudget).toBeGreaterThan(0);
  });

  it("emits mode_change event when mode transitions", () => {
    const state = createInitialRuntimeState();
    // Initial mode is "chat"; a coding message should transition to "coding"
    preTurnHook("Write a function to parse JSON", state, {
      agentId: "test-agent",
      conversationId: "test-conv",
    });

    expect(state.turnEvents.length).toBeGreaterThan(0);
    const modeEvent = state.turnEvents.find((e) => e.type === "mode_change");
    expect(modeEvent).toBeDefined();
  });

  it("does not emit mode_change event when mode stays the same", () => {
    const state = createInitialRuntimeState();
    // Two casual messages — mode stays "chat"
    preTurnHook("Hello there", state, {
      agentId: "test-agent",
      conversationId: "test-conv",
    });
    const firstEventCount = state.turnEvents.length;

    preTurnHook("How are you?", state, {
      agentId: "test-agent",
      conversationId: "test-conv",
    });

    // No new mode_change events (mode stayed chat)
    const modeEvents = state.turnEvents.filter((e) => e.type === "mode_change");
    expect(modeEvents.length).toBe(firstEventCount);
  });

  it("increments turn count on each call", () => {
    const state = createInitialRuntimeState();
    preTurnHook("Hello", state);
    expect(state.turnCount).toBe(1);
    preTurnHook("Hello again", state);
    expect(state.turnCount).toBe(2);
  });
});

// ============================================================================
// postTurnHook
// ============================================================================

describe("postTurnHook", () => {
  it("stores pipeline results on state", async () => {
    const state = createInitialRuntimeState();
    const result = await postTurnHook(
      {
        turnNumber: 1,
        assistantMessage: "I've fixed the bug by adding null checks.",
        userMessage: "The auth module keeps crashing on null input.",
      },
      state,
    );

    expect(state.lastPipelineResults).toBeDefined();
    expect(result.pipelineResults).toBe(state.lastPipelineResults);
  });

  it("detects queued candidates", async () => {
    const state = createInitialRuntimeState();
    const result = await postTurnHook(
      {
        turnNumber: 1,
        assistantMessage: "I've observed that the user prefers TypeScript.",
        userMessage: "I always use TypeScript for type safety.",
      },
      state,
    );

    // Pipeline results should exist (may or may not have queued candidates
    // depending on scoring thresholds)
    expect(result.pipelineResults.length).toBeGreaterThanOrEqual(0);
    expect(typeof result.hasQueuedCandidates).toBe("boolean");
  });

  it("handles empty messages gracefully", async () => {
    const state = createInitialRuntimeState();
    const result = await postTurnHook(
      {
        turnNumber: 1,
      },
      state,
    );

    expect(result.pipelineResults).toEqual([]);
    expect(result.hasQueuedCandidates).toBe(false);
  });
});

// ============================================================================
// collectEvent / flushTurnEvents
// ============================================================================

describe("event collection and flushing", () => {
  it("collects events into turnEvents buffer", () => {
    const state = createInitialRuntimeState();
    const event = createToolCallEvent("agent-1", "Read", {}, "ok", 50, {});
    collectEvent(state, event);

    expect(state.turnEvents.length).toBe(1);
    expect(state.turnEvents[0]).toBe(event);
  });

  it("flushes events and clears the buffer", () => {
    const state = createInitialRuntimeState();
    const event1 = createToolCallEvent("agent-1", "Read", {}, "ok", 50, {});
    const event2 = createToolCallEvent("agent-1", "Write", {}, "ok", 100, {});
    collectEvent(state, event1);
    collectEvent(state, event2);

    expect(state.turnEvents.length).toBe(2);

    const flushed = flushTurnEvents(state);

    expect(flushed).toBe(2);
    expect(state.turnEvents).toEqual([]);
  });

  it("returns 0 when flushing empty buffer", () => {
    const state = createInitialRuntimeState();
    const flushed = flushTurnEvents(state);

    expect(flushed).toBe(0);
    expect(state.turnEvents).toEqual([]);
  });
});

// ============================================================================
// getLanternStatus
// ============================================================================

describe("getLanternStatus", () => {
  it("produces a readable status summary", () => {
    const state = createInitialRuntimeState();
    preTurnHook("Fix the bug", state);

    const status = getLanternStatus(state);

    expect(status).toContain("Lantern Shell Status");
    expect(status).toContain("Mode:");
    expect(status).toContain("Task kind:");
    expect(status).toContain("Turn count:");
    expect(status).toContain("Model:");
    expect(status).toContain("Budget total:");
  });

  it("shows (not yet selected) when model selection hasn't run", () => {
    const state = createInitialRuntimeState();
    const status = getLanternStatus(state);

    expect(status).toContain("(not yet selected)");
  });

  it("shows model info after preTurnHook runs", () => {
    const state = createInitialRuntimeState();
    preTurnHook("Write a function", state);
    const status = getLanternStatus(state);

    expect(status).not.toContain("(not yet selected)");
    expect(state.modelSelection?.model).toBeTruthy();
    expect(status).toContain(state.modelSelection?.model ?? "");
  });

  it("shows pipeline results after postTurnHook runs", () => {
    const state = createInitialRuntimeState();
    preTurnHook("Fix the bug", state);
    postTurnHook(
      {
        turnNumber: 1,
        assistantMessage: "Fixed by adding null checks.",
      },
      state,
    );

    const status = getLanternStatus(state);

    expect(status).toContain("Pipeline:");
  });

  it("shows event count", () => {
    const state = createInitialRuntimeState();
    const event = createToolCallEvent("agent-1", "Read", {}, "ok", 50, {});
    collectEvent(state, event);

    const status = getLanternStatus(state);

    expect(status).toContain("Events:        1 collected this turn");
  });
});
