import { describe, expect, it } from "bun:test";
import {
  buildClassificationPrompt,
  heuristicClassifyMemory,
  parseLLMClassificationOutput,
} from "../../agent/memory/classifier";

import {
  createMemoryFile,
  parseMemoryFrontmatter,
  parseMemoryMetadata,
  serializeMemoryFrontmatter,
  validateMemoryFrontmatter,
} from "../../agent/memory/schema";
import {
  DEFAULT_IMPORTANCE_BY_TYPE,
  DEFAULT_SENSITIVITY_BY_TYPE,
  DIRECTORY_TO_MEMORY_TYPE,
  getMemoryTypeDirectory,
  inferMemoryTypeFromPath,
  isMemoryImportance,
  isMemorySensitivity,
  isMemoryType,
  MEMORY_IMPORTANCES,
  MEMORY_SENSITIVITIES,
  MEMORY_TYPE_DIRECTORIES,
  MEMORY_TYPES,
} from "../../agent/memory/taxonomy";

describe("Memory taxonomy", () => {
  it("has six memory types", () => {
    expect(MEMORY_TYPES.length).toBe(6);
    expect(MEMORY_TYPES).toContain("episodic");
    expect(MEMORY_TYPES).toContain("semantic");
    expect(MEMORY_TYPES).toContain("procedural");
    expect(MEMORY_TYPES).toContain("relationship");
    expect(MEMORY_TYPES).toContain("project");
    expect(MEMORY_TYPES).toContain("reflective");
  });

  it("validates memory type strings", () => {
    expect(isMemoryType("semantic")).toBe(true);
    expect(isMemoryType("invalid")).toBe(false);
    expect(isMemoryType("EPISODIC")).toBe(false);
  });

  it("maps memory types to directories", () => {
    expect(getMemoryTypeDirectory("episodic")).toBe("episodes");
    expect(getMemoryTypeDirectory("semantic")).toBe("knowledge");
    expect(getMemoryTypeDirectory("procedural")).toBe("procedures");
    expect(getMemoryTypeDirectory("relationship")).toBe("relationship");
    expect(getMemoryTypeDirectory("project")).toBe("projects");
    expect(getMemoryTypeDirectory("reflective")).toBe("reflection");
  });

  it("reverse maps directories to types", () => {
    expect(DIRECTORY_TO_MEMORY_TYPE["episodes"]).toBe("episodic");
    expect(DIRECTORY_TO_MEMORY_TYPE["knowledge"]).toBe("semantic");
  });

  it("infers memory type from path", () => {
    expect(inferMemoryTypeFromPath("knowledge/typescript.md")).toBe("semantic");
    expect(inferMemoryTypeFromPath("projects/letta-code/architecture.md")).toBe(
      "project",
    );
    expect(inferMemoryTypeFromPath("relationship/user-prefs.md")).toBe(
      "relationship",
    );
    expect(inferMemoryTypeFromPath("unknown/file.md")).toBeUndefined();
  });

  it("has default sensitivity by type", () => {
    expect(DEFAULT_SENSITIVITY_BY_TYPE["relationship"]).toBe("sensitive");
    expect(DEFAULT_SENSITIVITY_BY_TYPE["reflective"]).toBe("sensitive");
    expect(DEFAULT_SENSITIVITY_BY_TYPE["semantic"]).toBe("public");
  });

  it("has default importance by type", () => {
    expect(DEFAULT_IMPORTANCE_BY_TYPE["reflective"]).toBe("critical");
    expect(DEFAULT_IMPORTANCE_BY_TYPE["episodic"]).toBe("medium");
    expect(DEFAULT_IMPORTANCE_BY_TYPE["semantic"]).toBe("high");
  });
});

describe("Memory schema", () => {
  it("parses frontmatter from memory file", () => {
    const content = `---
description: User prefers TypeScript
type: semantic
sensitivity: public
---
The user has expressed a preference for TypeScript over JavaScript.`;

    const { frontmatter, body } = parseMemoryFrontmatter(content);
    expect(frontmatter.description).toBe("User prefers TypeScript");
    expect(frontmatter.type).toBe("semantic");
    expect(body).toContain("preference for TypeScript");
  });

  it("parses legacy frontmatter without type", () => {
    const content = `---
description: User prefers dark mode
---
The user likes dark themes.`;

    const { frontmatter } = parseMemoryFrontmatter(content);
    expect(frontmatter.description).toBe("User prefers dark mode");
    expect(frontmatter.type).toBeUndefined();
  });

  it("parses memory metadata with defaults", () => {
    const content = `---
description: Test memory
---
Body content`;

    const meta = parseMemoryMetadata(content);
    expect(meta.description).toBe("Test memory");
    expect(meta.type).toBe("semantic"); // default
    expect(meta.sensitivity).toBe("public"); // default for semantic
    expect(meta.importance).toBe("high"); // default for semantic
  });

  it("infers type from path when not in frontmatter", () => {
    const content = `---
description: Project architecture
---
The project uses a modular architecture.`;

    const meta = parseMemoryMetadata(content, "projects/letta-code/arch.md");
    expect(meta.type).toBe("project");
  });

  it("serializes frontmatter correctly", () => {
    const meta = {
      description: "Test memory",
      type: "semantic" as const,
      sensitivity: "public" as const,
      importance: "high" as const,
    };

    const frontmatter = serializeMemoryFrontmatter(meta);
    expect(frontmatter).toContain("description: Test memory");
    expect(frontmatter).toContain("type: semantic");
    expect(frontmatter).toContain("---");
  });

  it("creates complete memory file", () => {
    const content = createMemoryFile(
      { description: "Test description" },
      "This is the body content.",
    );

    expect(content).toContain("---");
    expect(content).toContain("description: Test description");
    expect(content).toContain("type: semantic");
    expect(content).toContain("This is the body content.");
  });

  it("validates frontmatter", () => {
    const valid = { description: "Valid memory", type: "semantic" };
    const result1 = validateMemoryFrontmatter(valid);
    expect(result1.valid).toBe(true);

    const invalid = { description: "", type: "invalid_type" };
    const result2 = validateMemoryFrontmatter(invalid);
    expect(result2.valid).toBe(false);
    expect(result2.errors.length).toBeGreaterThan(0);
  });
});

describe("Memory classifier", () => {
  it("classifies episodic memory by date pattern", () => {
    const result = heuristicClassifyMemory({
      content:
        "On 2024-01-15, the user mentioned they were starting a new job.",
    });
    expect(result.type).toBe("episodic");
  });

  it("classifies procedural memory by how-to pattern", () => {
    const result = heuristicClassifyMemory({
      content: "To deploy: run bun run build, then push to main.",
    });
    expect(result.type).toBe("procedural");
  });

  it("classifies relationship memory by user traits", () => {
    const result = heuristicClassifyMemory({
      content: "The user is detail-oriented and prefers thorough explanations.",
    });
    expect(result.type).toBe("relationship");
    expect(result.sensitivity).toBe("sensitive");
  });

  it("classifies project memory by project context", () => {
    const result = heuristicClassifyMemory({
      content: "The architecture uses a modular plugin system.",
      context: "Working in the letta-code-DE project",
    });
    expect(result.type).toBe("project");
  });

  it("classifies reflective memory by self-reference", () => {
    const result = heuristicClassifyMemory({
      content: "I should ask for clarification before making assumptions.",
    });
    expect(result.type).toBe("reflective");
    expect(result.sensitivity).toBe("sensitive");
    expect(result.importance).toBe("critical");
  });

  it("defaults to semantic for ambiguous content", () => {
    const result = heuristicClassifyMemory({
      content: "The sky is blue.",
    });
    expect(result.type).toBe("semantic");
  });

  it("detects sensitive content by keywords", () => {
    const result = heuristicClassifyMemory({
      content: "The user's password is stored in the environment.",
    });
    expect(result.sensitivity).toBe("sensitive");
  });

  it("detects private content by keywords", () => {
    const result = heuristicClassifyMemory({
      content: "This is confidential, do not share.",
    });
    expect(result.sensitivity).toBe("private");
  });

  it("generates description from content", () => {
    const result = heuristicClassifyMemory({
      content:
        "This is a long piece of content that should be truncated to a reasonable description length for the frontmatter.",
    });
    expect(result.description.length).toBeLessThanOrEqual(100);
  });

  it("builds classification prompt for LLM", () => {
    const prompt = buildClassificationPrompt({
      content: "Test memory content",
      context: "User conversation",
    });
    expect(prompt).toContain("Test memory content");
    expect(prompt).toContain("Memory Types");
    expect(prompt).toContain("episodic");
    expect(prompt).toContain("semantic");
  });

  it("parses LLM classification output", () => {
    const output = JSON.stringify({
      type: "semantic",
      sensitivity: "public",
      importance: "high",
      confidence: 0.9,
      description: "User prefers TypeScript",
      reasoning: "Content indicates a preference",
    });

    const result = parseLLMClassificationOutput(output);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("semantic");
    expect(result!.confidence).toBe(0.9);
  });

  it("returns null for invalid LLM output", () => {
    const result = parseLLMClassificationOutput("not json");
    expect(result).toBeNull();

    const result2 = parseLLMClassificationOutput('{"invalid": "structure"}');
    expect(result2).toBeNull();
  });
});
