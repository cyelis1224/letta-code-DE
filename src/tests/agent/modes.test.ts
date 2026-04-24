import { describe, expect, it } from "bun:test";
import {
  BUILTIN_MODES,
  createInitialModeState,
  enterMode,
  exitMode,
  getModeDefinition,
  getModeDefinitionFromState,
  isOperationMode,
  isToolAllowed,
  type ModeDefinition,
  OPERATION_MODES,
  registerCustomMode,
  taskKindToMode,
} from "../../agent/modes/types";

describe("Operation modes", () => {
  it("has seven built-in modes", () => {
    expect(OPERATION_MODES.length).toBe(7);
    expect(OPERATION_MODES).toContain("chat");
    expect(OPERATION_MODES).toContain("coding");
    expect(OPERATION_MODES).toContain("research");
    expect(OPERATION_MODES).toContain("design");
    expect(OPERATION_MODES).toContain("creative");
    expect(OPERATION_MODES).toContain("reflection");
    expect(OPERATION_MODES).toContain("free-play");
  });

  it("validates operation mode strings", () => {
    expect(isOperationMode("coding")).toBe(true);
    expect(isOperationMode("invalid")).toBe(false);
  });

  it("each built-in mode has a definition", () => {
    for (const mode of OPERATION_MODES) {
      const def = getModeDefinition(mode);
      expect(def).toBeDefined();
      expect(def!.mode).toBe(mode);
      expect(def!.label.length).toBeGreaterThan(0);
      expect(def!.description.length).toBeGreaterThan(0);
      expect(def!.defaultTaskKind).toBeDefined();
      expect(def!.context).toBeDefined();
      expect(def!.tools).toBeDefined();
    }
  });
});

describe("Mode state management", () => {
  it("creates initial state with chat mode", () => {
    const state = createInitialModeState();
    expect(state.activeMode).toBe("chat");
    expect(state.previousMode).toBeNull();
    expect(state.enterReason).toBe("system");
  });

  it("enters a new mode", () => {
    const state = createInitialModeState();
    const newState = enterMode(state, "coding", "manual");

    expect(newState.activeMode).toBe("coding");
    expect(newState.previousMode).toBe("chat");
    expect(newState.enterReason).toBe("manual");
  });

  it("exits mode back to previous", () => {
    const state = createInitialModeState();
    const codingState = enterMode(state, "coding");
    const exitedState = exitMode(codingState);

    expect(exitedState.activeMode).toBe("chat");
    expect(exitedState.previousMode).toBe("coding");
  });

  it("exits to chat when no previous mode", () => {
    const state = createInitialModeState();
    // Even initial state can exit — falls back to chat
    const exitedState = exitMode(state);
    expect(exitedState.activeMode).toBe("chat");
  });

  it("throws on unknown mode", () => {
    const state = createInitialModeState();
    expect(() => enterMode(state, "nonexistent" as any)).toThrow(
      "Unknown mode",
    );
  });

  it("tracks mode entry time", () => {
    const state = createInitialModeState();
    const newState = enterMode(state, "coding");
    expect(newState.enteredAt).toBeDefined();
    expect(new Date(newState.enteredAt).getTime()).toBeGreaterThan(0);
  });
});

describe("Mode context configuration", () => {
  it("coding mode uses compressed persona", () => {
    const def = BUILTIN_MODES.coding;
    expect(def.context.includeFullPersona).toBe(false);
  });

  it("chat mode uses full persona", () => {
    const def = BUILTIN_MODES.chat;
    expect(def.context.includeFullPersona).toBe(true);
  });

  it("coding mode prioritizes project memory", () => {
    const def = BUILTIN_MODES.coding;
    expect(def.context.memoryTypePriority[0]).toBe("project");
  });

  it("creative mode prioritizes relationship memory", () => {
    const def = BUILTIN_MODES.creative;
    expect(def.context.memoryTypePriority[0]).toBe("relationship");
  });

  it("reflection mode has more memory slots", () => {
    const def = BUILTIN_MODES.reflection;
    expect(def.context.maxMemories).toBe(20);
  });

  it("free-play mode has most memory slots", () => {
    const def = BUILTIN_MODES["free-play"];
    expect(def.context.maxMemories).toBe(25);
  });
});

describe("Mode tool access", () => {
  it("coding mode allows bash without approval", () => {
    const def = BUILTIN_MODES.coding;
    expect(def.tools.bashAllowed).toBe(true);
    expect(def.tools.bashRequiresApproval).toBe(false);
    expect(def.tools.writesRequireApproval).toBe(false);
  });

  it("reflection mode disables bash", () => {
    const def = BUILTIN_MODES.reflection;
    expect(def.tools.bashAllowed).toBe(false);
  });

  it("free-play mode has no restrictions", () => {
    const def = BUILTIN_MODES["free-play"];
    expect(def.tools.bashAllowed).toBe(true);
    expect(def.tools.bashRequiresApproval).toBe(false);
    expect(def.tools.writesRequireApproval).toBe(false);
    expect(def.tools.allowedTools).toContain("*");
  });

  it("isToolAllowed checks mode tool list", () => {
    const state = createInitialModeState();

    // Chat mode allows all tools
    expect(isToolAllowed("Bash", "chat", state)).toBe(true);
    expect(isToolAllowed("Read", "chat", state)).toBe(true);

    // Reflection mode disallows Bash
    expect(isToolAllowed("Bash", "reflection", state)).toBe(false);
    expect(isToolAllowed("Read", "reflection", state)).toBe(true);
    expect(isToolAllowed("memory", "reflection", state)).toBe(true);
  });
});

describe("Task kind to mode mapping", () => {
  it("maps casual to chat", () => {
    expect(taskKindToMode("casual")).toBe("chat");
  });

  it("maps coding to coding", () => {
    expect(taskKindToMode("coding")).toBe("coding");
  });

  it("maps research to research", () => {
    expect(taskKindToMode("research")).toBe("research");
  });

  it("maps design to design", () => {
    expect(taskKindToMode("design")).toBe("design");
  });

  it("maps creative to creative", () => {
    expect(taskKindToMode("creative")).toBe("creative");
  });

  it("maps reflection to reflection", () => {
    expect(taskKindToMode("reflection")).toBe("reflection");
  });

  it("maps governance to coding", () => {
    expect(taskKindToMode("governance")).toBe("coding");
  });
});

describe("Custom modes", () => {
  it("registers a custom mode", () => {
    const state = createInitialModeState();
    const customMode: ModeDefinition = {
      mode: "deep-work" as any,
      label: "Deep Work",
      description: "Focused deep work with minimal distractions",
      defaultTaskKind: "coding",
      context: {
        includeFullPersona: false,
        memoryTypePriority: ["project", "procedural"],
        maxMemories: 5,
        styleOverrides: { verbosity: "minimal" },
      },
      tools: {
        allowedTools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
        disallowedTools: ["memory"],
        bashAllowed: true,
        bashRequiresApproval: false,
        writesRequireApproval: false,
      },
      autoEnter: false,
      exitRequiresConfirmation: true,
    };

    const newState = registerCustomMode(state, customMode);
    const def = getModeDefinitionFromState("deep-work", newState);
    expect(def).toBeDefined();
    expect(def!.label).toBe("Deep Work");
  });

  it("custom mode tool access works", () => {
    const state = createInitialModeState();
    const customMode: ModeDefinition = {
      mode: "restricted" as any,
      label: "Restricted",
      description: "Read-only mode",
      defaultTaskKind: "research",
      context: {
        includeFullPersona: false,
        memoryTypePriority: ["semantic"],
        maxMemories: 5,
      },
      tools: {
        allowedTools: ["Read", "Grep", "Glob"],
        disallowedTools: ["Bash", "Write", "Edit", "memory"],
        bashAllowed: false,
        bashRequiresApproval: true,
        writesRequireApproval: true,
      },
      autoEnter: false,
      exitRequiresConfirmation: false,
    };

    const newState = registerCustomMode(state, customMode);
    expect(isToolAllowed("Read", "restricted" as any, newState)).toBe(true);
    expect(isToolAllowed("Bash", "restricted" as any, newState)).toBe(false);
    expect(isToolAllowed("Write", "restricted" as any, newState)).toBe(false);
  });
});

describe("Mode auto-enter", () => {
  it("coding mode can be auto-entered", () => {
    expect(BUILTIN_MODES.coding.autoEnter).toBe(true);
  });

  it("free-play mode cannot be auto-entered", () => {
    expect(BUILTIN_MODES["free-play"].autoEnter).toBe(false);
  });

  it("free-play mode requires confirmation to exit", () => {
    expect(BUILTIN_MODES["free-play"].exitRequiresConfirmation).toBe(true);
  });
});
