import { describe, expect, it } from "bun:test";
import {
  assembleContextSections,
  calculateBudget,
  classifyTask,
  compileContext,
} from "../../agent/context/compiler";
import { DEFAULT_EIM_CONFIG } from "../../agent/eim/types";

describe("Context budget", () => {
  it("allocates budget from total tokens", () => {
    const budget = calculateBudget(128000);
    expect(budget.totalTokens).toBe(128000);
    expect(budget.identityBudget).toBeGreaterThan(0);
    expect(budget.memoryBudget).toBeGreaterThan(0);
    expect(budget.conversationBudget).toBeGreaterThan(0);
    expect(budget.toolBudget).toBeGreaterThan(0);

    // Check that the sum doesn't exceed total
    const used =
      budget.identityBudget +
      budget.memoryBudget +
      budget.conversationBudget +
      budget.toolBudget +
      budget.systemOverhead;
    expect(used).toBeLessThanOrEqual(budget.totalTokens);
  });

  it("allocates roughly correct ratios", () => {
    const budget = calculateBudget(100000);
    // Identity: 15%, Memory: 20%, Conversation: 35%, Tool: 15%, Overhead: 5%
    expect(budget.identityBudget).toBe(15000);
    expect(budget.memoryBudget).toBe(20000);
    expect(budget.conversationBudget).toBe(35000);
    expect(budget.toolBudget).toBe(15000);
    expect(budget.systemOverhead).toBe(5000);
  });
});

describe("Task classification", () => {
  it("classifies coding tasks", () => {
    expect(classifyTask("Fix the bug in the login function")).toBe("coding");
    expect(classifyTask("Implement the new API endpoint")).toBe("coding");
    expect(classifyTask("Run the tests and check for failures")).toBe("coding");
  });

  it("classifies research tasks", () => {
    expect(classifyTask("What is the architecture of this system?")).toBe(
      "research",
    );
    expect(classifyTask("Investigate the performance issue")).toBe("research");
  });

  it("classifies design tasks", () => {
    expect(classifyTask("Design the UI for the settings page")).toBe("design");
    expect(classifyTask("Review the UX wireframes")).toBe("design");
  });

  it("classifies creative tasks", () => {
    expect(classifyTask("Write a creative story about AI")).toBe("creative");
    expect(classifyTask("Brainstorm ideas for the project name")).toBe(
      "creative",
    );
  });

  it("classifies reflection tasks", () => {
    expect(classifyTask("Review and consolidate my memories")).toBe(
      "reflection",
    );
    expect(classifyTask("What have we worked on?")).toBe("reflection");
  });

  it("classifies governance tasks", () => {
    expect(classifyTask("Check the permissions settings")).toBe("governance");
    expect(classifyTask("Review the audit log")).toBe("governance");
  });

  it("defaults to casual for greetings", () => {
    expect(classifyTask("hello")).toBe("casual");
    expect(classifyTask("hey there")).toBe("casual");
    expect(classifyTask("hi")).toBe("casual");
  });
});

describe("Context compilation", () => {
  it("compiles context for a coding task", () => {
    const context = compileContext({
      eimConfig: DEFAULT_EIM_CONFIG,
      userMessage: "Fix the bug in the authentication module",
    });

    expect(context.taskKind).toBe("coding");
    expect(context.includeFullPersona).toBe(false);
    expect(context.compressedPersona).toBeDefined();
    expect(context.eimFragments.styleDirective).toBeDefined();
    expect(context.eimFragments.boundariesDirective).toBeDefined();
    expect(context.memoryRetrieval.typePriority).toContain("project");
    expect(context.memoryRetrieval.maxTokens).toBeGreaterThan(0);
    expect(context.budget.totalTokens).toBe(128000);
  });

  it("compiles context for a casual task with full persona", () => {
    const context = compileContext({
      eimConfig: DEFAULT_EIM_CONFIG,
      userMessage: "hey, how's it going?",
    });

    expect(context.taskKind).toBe("casual");
    expect(context.includeFullPersona).toBe(true);
    expect(context.compressedPersona).toBeUndefined();
  });

  it("allows task kind override", () => {
    const context = compileContext({
      eimConfig: DEFAULT_EIM_CONFIG,
      userMessage: "hello",
      taskKindOverride: "coding",
    });

    expect(context.taskKind).toBe("coding");
  });

  it("applies mode overrides", () => {
    const config = {
      ...DEFAULT_EIM_CONFIG,
      modeOverrides: [
        {
          mode: "deep-work",
          style: { verbosity: "minimal" as const },
          memoryTypePriority: ["project"],
        },
      ],
    };

    const context = compileContext({
      eimConfig: config,
      userMessage: "Fix the bug",
      activeMode: "deep-work",
    });

    expect(context.activeMode).toBe("deep-work");
  });

  it("respects custom context window size", () => {
    const context = compileContext({
      eimConfig: DEFAULT_EIM_CONFIG,
      userMessage: "Test",
      contextWindowSize: 200000,
    });

    expect(context.budget.totalTokens).toBe(200000);
    expect(context.budget.memoryBudget).toBeGreaterThan(0);
  });
});

describe("Context assembly", () => {
  it("assembles identity section with style and boundaries", () => {
    const context = compileContext({
      eimConfig: DEFAULT_EIM_CONFIG,
      userMessage: "Fix the bug",
    });

    const sections = assembleContextSections(context);
    expect(sections.identitySection).toBeDefined();
    expect(sections.identitySection.length).toBeGreaterThan(0);
    expect(sections.taskHint).toContain("coding");
  });

  it("includes compressed persona for coding tasks", () => {
    const context = compileContext({
      eimConfig: DEFAULT_EIM_CONFIG,
      userMessage: "Implement the feature",
    });

    const sections = assembleContextSections(context);
    // Coding tasks don't include full persona
    expect(context.includeFullPersona).toBe(false);
    expect(sections.identitySection).toContain("Letta Code");
  });

  it("includes memory hint section", () => {
    const context = compileContext({
      eimConfig: DEFAULT_EIM_CONFIG,
      userMessage: "Fix the bug",
    });

    const sections = assembleContextSections(context);
    expect(sections.memoryHintSection).toBeDefined();
  });
});
