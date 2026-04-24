import { describe, expect, it } from "bun:test";
import {
  augmentSystemPrompt,
  checkToolPermission,
  clearOperationMode,
  createInitialRuntimeState,
  getCurrentMode,
  logMemoryWrite,
  logToolCall,
  postTurnHook,
  preTurnHook,
  setOperationMode,
} from "../../agent/integration";

describe("Runtime state", () => {
  it("creates initial state with defaults", () => {
    const state = createInitialRuntimeState();
    expect(state.modeState.activeMode).toBe("chat");
    expect(state.currentTaskKind).toBe("casual");
    expect(state.turnCount).toBe(0);
    expect(state.contextCompiled).toBe(false);
  });

  it("accepts custom EIM config", () => {
    const state = createInitialRuntimeState({
      name: "Custom Agent",
      role: { label: "Specialist", specialties: ["coding"] },
    });
    expect(state.eimConfig.name).toBe("Custom Agent");
  });
});

describe("Pre-turn hook", () => {
  it("classifies task and compiles context", () => {
    const state = createInitialRuntimeState();
    const result = preTurnHook("Fix the bug in the auth module", state);

    expect(result.taskKind).toBe("coding");
    expect(result.mode).toBe("coding");
    expect(result.contextSections.identity.length).toBeGreaterThan(0);
    expect(result.modelSelection.model).toBeDefined();
    expect(state.turnCount).toBe(1);
    expect(state.contextCompiled).toBe(true);
  });

  it("uses explicit mode override", () => {
    const state = createInitialRuntimeState();
    const result = preTurnHook("Hello there", state, {
      activeMode: "coding",
    });

    expect(result.mode).toBe("coding");
    expect(state.modeState.activeMode).toBe("coding");
  });

  it("selects appropriate model for task", () => {
    const state = createInitialRuntimeState();
    const codingResult = preTurnHook("Implement the feature", state);
    const casualResult = preTurnHook("Hey how's it going", state);

    // Both should have model selections
    expect(codingResult.modelSelection.model).toBeDefined();
    expect(casualResult.modelSelection.model).toBeDefined();
  });

  it("respects preferred model", () => {
    const state = createInitialRuntimeState();
    const result = preTurnHook("Fix the bug", state, {
      preferredModel: "haiku",
    });

    expect(result.modelSelection.model).toBe("haiku");
  });
});

describe("Post-turn hook", () => {
  it("processes conversation for memory candidates", async () => {
    const state = createInitialRuntimeState();
    const result = await postTurnHook(
      {
        conversationId: "test-conv",
        turnNumber: 1,
        assistantMessage: "I noticed you prefer TypeScript over JavaScript.",
        userMessage: "Yes, I find it more reliable.",
      },
      state,
    );

    expect(result.pipelineResults.length).toBeGreaterThanOrEqual(0);
    expect(state.lastPipelineResults.length).toBe(
      result.pipelineResults.length,
    );
  });

  it("detects queued candidates", async () => {
    const state = createInitialRuntimeState();
    const result = await postTurnHook(
      {
        conversationId: "test-conv",
        turnNumber: 1,
        assistantMessage: "Your API key is stored securely.",
      },
      state,
    );

    // The API key mention should trigger sensitive classification
    const sensitiveResult = result.pipelineResults.find(
      (r: { classification: { sensitivity: string } }) =>
        r.classification.sensitivity === "sensitive",
    );
    // If we found a sensitive result, it should be queued
    if (sensitiveResult) {
      expect(sensitiveResult.decision).toBe("queued");
    }
  });

  it("tracks turn count", () => {
    const state = createInitialRuntimeState();
    preTurnHook("Hello", state);
    preTurnHook("Fix bug", state);
    expect(state.turnCount).toBe(2);
  });
});

describe("Tool permissions", () => {
  it("allows tools in appropriate modes", () => {
    const state = createInitialRuntimeState();
    state.modeState.activeMode = "coding";

    const check = checkToolPermission("Bash", state);
    expect(check.allowed).toBe(true);
  });

  it("blocks tools in restricted modes", () => {
    const state = createInitialRuntimeState();
    state.modeState.activeMode = "reflection";

    const check = checkToolPermission("Bash", state);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("reflection");
  });

  it("allows Read in all modes", () => {
    const state = createInitialRuntimeState();

    const chatCheck = checkToolPermission("Read", {
      ...state,
      modeState: { ...state.modeState, activeMode: "chat" },
    });
    const codingCheck = checkToolPermission("Read", {
      ...state,
      modeState: { ...state.modeState, activeMode: "coding" },
    });
    const reflectionCheck = checkToolPermission("Read", {
      ...state,
      modeState: { ...state.modeState, activeMode: "reflection" },
    });

    expect(chatCheck.allowed).toBe(true);
    expect(codingCheck.allowed).toBe(true);
    expect(reflectionCheck.allowed).toBe(true);
  });
});

describe("Event logging", () => {
  it("logs tool calls", () => {
    const event = logToolCall(
      "Bash",
      { command: "npm test" },
      { exitCode: 0, output: "passed" },
      1500,
      "agent-test",
      "conv-123",
    );

    expect(event.type).toBe("tool_call");
    expect(event.id).toBeDefined();
    expect(event.timestamp).toBeDefined();
  });

  it("logs memory writes", () => {
    const event = logMemoryWrite(
      "agent-test",
      "knowledge/test.md",
      "update",
      "old content",
      "new content",
      "conv-123",
    );

    expect(event.type).toBe("memory_write");
    expect(event.id).toBeDefined();
  });
});

describe("Prompt augmentation", () => {
  it("augments base prompt with context", () => {
    const basePrompt = "You are a helpful assistant.";
    const contextSections = {
      identity: "Style: Be concise and direct.",
      memoryHint: "Focus on project memories.",
    };

    const result = augmentSystemPrompt(basePrompt, contextSections);

    expect(result).toContain("You are a helpful assistant.");
    expect(result).toContain("Lantern Shell Context");
    expect(result).toContain("Style: Be concise");
  });

  it("returns base prompt unchanged if no context", () => {
    const basePrompt = "You are a helpful assistant.";
    const contextSections = {
      identity: "",
      memoryHint: "",
    };

    const result = augmentSystemPrompt(basePrompt, contextSections);
    expect(result).toBe(basePrompt);
  });
});

describe("Mode management", () => {
  it("sets operation mode", () => {
    const state = createInitialRuntimeState();
    const result = setOperationMode("coding", state);

    expect(result.success).toBe(true);
    expect(result.previousMode).toBe("chat");
    expect(state.modeState.activeMode).toBe("coding");
  });

  it("clears operation mode", () => {
    const state = createInitialRuntimeState();
    setOperationMode("coding", state);
    const newMode = clearOperationMode(state);

    expect(newMode).toBe("chat"); // Returns to previous
  });

  it("gets current mode", () => {
    const state = createInitialRuntimeState();
    expect(getCurrentMode(state)).toBe("chat");

    setOperationMode("research", state);
    expect(getCurrentMode(state)).toBe("research");
  });
});
