import { describe, expect, it } from "bun:test";
import {
  compileEIMPromptFragments,
  renderBoundariesDirective,
  renderCompressedPersona,
  renderStyleDirective,
} from "../../agent/eim/compiler";
import {
  deserializeEIMConfig,
  serializeEIMConfig,
} from "../../agent/eim/serializer";
import {
  compileEIMContext,
  DEFAULT_EIM_CONFIG,
  type TaskKind,
} from "../../agent/eim/types";

describe("EIM types", () => {
  it("default config has required fields", () => {
    expect(DEFAULT_EIM_CONFIG.name).toBe("Letta Code");
    expect(DEFAULT_EIM_CONFIG.schemaVersion).toBe(1);
    expect(DEFAULT_EIM_CONFIG.style.verbosity).toBe("adaptive");
    expect(DEFAULT_EIM_CONFIG.continuityPriorities.length).toBeGreaterThan(0);
    expect(
      DEFAULT_EIM_CONFIG.boundaries.externalActionsRequireConfirmation,
    ).toBe(true);
  });

  it("compileEIMContext returns a slice for each task kind", () => {
    const taskKinds: TaskKind[] = [
      "casual",
      "coding",
      "research",
      "design",
      "creative",
      "reflection",
      "governance",
    ];

    for (const kind of taskKinds) {
      const slice = compileEIMContext(DEFAULT_EIM_CONFIG, kind);
      expect(slice.taskKind).toBe(kind);
      expect(slice.style).toBeDefined();
      expect(slice.boundaries).toBeDefined();
      expect(slice.continuityPriorities).toBeDefined();
      expect(slice.memoryTypePriority.length).toBeGreaterThan(0);
    }
  });

  it("coding task loads compressed persona and project memory", () => {
    const slice = compileEIMContext(DEFAULT_EIM_CONFIG, "coding");
    expect(slice.includeFullPersona).toBe(false);
    expect(slice.memoryTypePriority).toContain("project");
    expect(slice.memoryTypePriority).toContain("procedural");
    expect(slice.style.metaphorTolerance).toBe("low");
  });

  it("casual task loads full persona and relationship memory", () => {
    const slice = compileEIMContext(DEFAULT_EIM_CONFIG, "casual");
    expect(slice.includeFullPersona).toBe(true);
    expect(slice.memoryTypePriority).toContain("relationship");
  });

  it("creative task loads full persona and high metaphor tolerance", () => {
    const slice = compileEIMContext(DEFAULT_EIM_CONFIG, "creative");
    expect(slice.includeFullPersona).toBe(true);
    expect(slice.style.metaphorTolerance).toBe("high");
  });

  it("mode overrides are applied when active", () => {
    const config = {
      ...DEFAULT_EIM_CONFIG,
      modeOverrides: [
        {
          mode: "coding",
          style: { verbosity: "minimal" as const },
          memoryTypePriority: ["procedural"],
        },
      ],
    };

    const slice = compileEIMContext(config, "coding", "coding");
    expect(slice.style.verbosity).toBe("minimal");
    expect(slice.memoryTypePriority).toContain("procedural");
  });

  it("continuity priorities are filtered by task", () => {
    const slice = compileEIMContext(DEFAULT_EIM_CONFIG, "coding");
    // Coding should include project-related priorities but not relational ones
    expect(slice.continuityPriorities).not.toContain(
      "maintain stable relational posture",
    );
  });
});

describe("EIM compiler", () => {
  it("renderStyleDirective produces non-empty output", () => {
    const directive = renderStyleDirective(DEFAULT_EIM_CONFIG.style);
    expect(directive.length).toBeGreaterThan(0);
    expect(directive).toContain("Match depth");
  });

  it("renderBoundariesDirective includes all active boundaries", () => {
    const directive = renderBoundariesDirective(DEFAULT_EIM_CONFIG.boundaries);
    expect(directive).toContain("explicit user confirmation");
    expect(directive).toContain("Never impersonate");
    expect(directive).toContain("Distinguish speculation");
  });

  it("compileEIMPromptFragments produces all fragments", () => {
    const slice = compileEIMContext(DEFAULT_EIM_CONFIG, "coding");
    const fragments = compileEIMPromptFragments(slice);
    expect(fragments.styleDirective.length).toBeGreaterThan(0);
    expect(fragments.boundariesDirective.length).toBeGreaterThan(0);
    expect(fragments.taskKind).toBe("coding");
    expect(fragments.includeFullPersona).toBe(false);
  });

  it("renderCompressedPersona produces one-line identity", () => {
    const compressed = renderCompressedPersona(
      "Test Agent",
      "A testing companion",
      DEFAULT_EIM_CONFIG.style,
    );
    expect(compressed).toContain("Test Agent");
    expect(compressed).toContain("A testing companion");
    // Should be shorter than a full persona block
    expect(compressed.length).toBeLessThan(500);
  });

  it("minimal verbosity produces concise directive", () => {
    const directive = renderStyleDirective({
      ...DEFAULT_EIM_CONFIG.style,
      verbosity: "minimal",
    });
    expect(directive).toContain("One sentence");
  });

  it("verbose verbosity produces thorough directive", () => {
    const directive = renderStyleDirective({
      ...DEFAULT_EIM_CONFIG.style,
      verbosity: "verbose",
    });
    expect(directive).toContain("thorough");
  });
});

describe("EIM serializer", () => {
  it("round-trips default config through serialization", () => {
    const serialized = serializeEIMConfig(DEFAULT_EIM_CONFIG);
    expect(serialized).toContain("---");
    expect(serialized).toContain("Letta Code");

    const deserialized = deserializeEIMConfig(serialized);
    expect(deserialized.name).toBe(DEFAULT_EIM_CONFIG.name);
    expect(deserialized.schemaVersion).toBe(DEFAULT_EIM_CONFIG.schemaVersion);
    expect(deserialized.style.verbosity).toBe(
      DEFAULT_EIM_CONFIG.style.verbosity,
    );
    expect(deserialized.boundaries.externalActionsRequireConfirmation).toBe(
      DEFAULT_EIM_CONFIG.boundaries.externalActionsRequireConfirmation,
    );
  });

  it("preserves continuity priorities through round-trip", () => {
    const serialized = serializeEIMConfig(DEFAULT_EIM_CONFIG);
    const deserialized = deserializeEIMConfig(serialized);
    expect(deserialized.continuityPriorities).toEqual(
      DEFAULT_EIM_CONFIG.continuityPriorities,
    );
  });

  it("preserves mode overrides through round-trip", () => {
    const config = {
      ...DEFAULT_EIM_CONFIG,
      modeOverrides: [
        {
          mode: "coding",
          style: { verbosity: "minimal" as const },
          memoryTypePriority: ["procedural"],
        },
      ],
    };

    const serialized = serializeEIMConfig(config);
    const deserialized = deserializeEIMConfig(serialized);
    expect(deserialized.modeOverrides).toBeDefined();
    expect(deserialized.modeOverrides!.length).toBe(1);
    expect(deserialized.modeOverrides![0]!.mode).toBe("coding");
    expect(deserialized.modeOverrides![0]!.style?.verbosity).toBe("minimal");
  });
});
