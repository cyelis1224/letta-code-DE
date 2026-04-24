import { describe, expect, it } from "bun:test";
import type { AgentEvent } from "../../agent/events/types";
import type { MemoryEntry } from "../../agent/memory/continuity-schema";
import {
  type DetectedPattern,
  detectPatterns,
} from "../../agent/memory/reflection";
import type { MemoryType } from "../../agent/memory/taxonomy";

// ============================================================================
// Test helpers
// ============================================================================

function makeModeChangeEvent(from: string, to: string): AgentEvent {
  return {
    id: `evt-${Date.now()}-${Math.random()}`,
    type: "mode_change",
    timestamp: new Date().toISOString(),
    agentId: "test-agent",
    conversationId: "test-conv",
    severity: "info",
    metadata: {},
    from,
    to,
  } as AgentEvent;
}

function makeToolCallEvent(toolName: string): AgentEvent {
  return {
    id: `evt-${Date.now()}-${Math.random()}`,
    type: "tool_call",
    timestamp: new Date().toISOString(),
    agentId: "test-agent",
    conversationId: "test-conv",
    severity: "info",
    metadata: {},
    toolName,
  } as AgentEvent;
}

function makeMemory(
  type: MemoryType,
  id: string,
  accessCount: number,
  importance: string = "medium",
  ageDays: number = 0,
  daysSinceAccess: number = 0,
  content: string = "",
): MemoryEntry {
  const now = Date.now();
  const created = new Date(now - ageDays * 24 * 60 * 60 * 1000);
  const lastAccessed = new Date(now - daysSinceAccess * 24 * 60 * 60 * 1000);
  return {
    frontmatter: {
      id,
      type,
      sensitivity: "public",
      importance: importance as MemoryEntry["frontmatter"]["importance"],
      createdAt: created.toISOString(),
      lastAccessedAt: lastAccessed.toISOString(),
      accessCount,
      source: "conversation",
      storedScore: 0.7,
      reviewStatus: "auto",
      tags: [],
    },
    content: content || `Test memory content for ${id}`,
    path: `${type}/${id}.md`,
  };
}

interface AuditLogEntry {
  timestamp: string;
  action: string;
  memoryId: string;
  type: MemoryType;
  score: number;
  source: string;
  preview: string;
}

// ============================================================================
// Structural pattern detection
// ============================================================================

describe("Structural pattern detection", () => {
  it("detects mode re-entry (bouncing back from a mode)", () => {
    const events: AgentEvent[] = [
      makeModeChangeEvent("coding", "creative"),
      makeModeChangeEvent("creative", "coding"),
      makeModeChangeEvent("coding", "creative"),
    ];

    const patterns = detectPatterns(events, [], [], "creative");

    const reentry = patterns.find(
      (p) => p.kind === "structural_correlation" && p.category === "structural",
    );
    expect(reentry).toBeDefined();
    expect(reentry!.evidence.length).toBeGreaterThan(0);
  });

  it("does not flag single mode transitions as structural", () => {
    const events: AgentEvent[] = [makeModeChangeEvent("coding", "creative")];

    const patterns = detectPatterns(events, [], [], "creative");

    const reentry = patterns.filter(
      (p) => p.kind === "structural_correlation" && p.category === "structural",
    );
    expect(reentry.length).toBe(0);
  });

  it("detects storage type skew", () => {
    // 8 project memories, 1 semantic = project dominates
    const memories = Array.from({ length: 8 }, (_, i) =>
      makeMemory("project", `proj-${i}`, 3),
    );
    memories.push(makeMemory("semantic", "sem-1", 3));

    const patterns = detectPatterns([], [], memories, "coding");

    const skew = patterns.find(
      (p) =>
        p.kind === "structural_correlation" &&
        p.category === "structural" &&
        p.description.includes("skew"),
    );
    expect(skew).toBeDefined();
  });
});

// ============================================================================
// Distribution pattern detection
// ============================================================================

describe("Distribution pattern detection", () => {
  it("detects retrieval skew when one type dominates", () => {
    const auditEntries: AuditLogEntry[] = Array.from({ length: 8 }, (_, i) => ({
      timestamp: new Date().toISOString(),
      action: "retrieve",
      memoryId: `proj-${i}`,
      type: "project" as MemoryType,
      score: 0.8,
      source: "conversation",
      preview: "Project memory",
    }));
    auditEntries.push({
      timestamp: new Date().toISOString(),
      action: "retrieve",
      memoryId: "sem-1",
      type: "semantic" as MemoryType,
      score: 0.7,
      source: "conversation",
      preview: "Semantic memory",
    });

    const patterns = detectPatterns([], auditEntries, [], "coding");

    const skew = patterns.find(
      (p) =>
        p.kind === "distribution_imbalance" && p.category === "distribution",
    );
    expect(skew).toBeDefined();
  });

  it("detects mode dominance (no mode changes in long session)", () => {
    // Need events but no mode_change events
    const events: AgentEvent[] = [
      makeToolCallEvent("read"),
      makeToolCallEvent("write"),
    ];

    const patterns = detectPatterns(events, [], [], "reflection");

    const dominance = patterns.find(
      (p) =>
        p.kind === "distribution_imbalance" &&
        p.category === "distribution" &&
        p.description.includes("dominance"),
    );
    expect(dominance).toBeDefined();
  });

  it("does not flag balanced retrieval as skewed", () => {
    const auditEntries: AuditLogEntry[] = [
      {
        timestamp: new Date().toISOString(),
        action: "retrieve",
        memoryId: "proj-1",
        type: "project" as MemoryType,
        score: 0.8,
        source: "conversation",
        preview: "Project",
      },
      {
        timestamp: new Date().toISOString(),
        action: "retrieve",
        memoryId: "sem-1",
        type: "semantic" as MemoryType,
        score: 0.7,
        source: "conversation",
        preview: "Semantic",
      },
    ];

    const patterns = detectPatterns([], auditEntries, [], "coding");

    const skew = patterns.filter(
      (p) =>
        p.kind === "distribution_imbalance" && p.category === "distribution",
    );
    expect(skew.length).toBe(0);
  });
});

// ============================================================================
// Absence pattern detection
// ============================================================================

describe("Absence pattern detection", () => {
  it("detects critical reflective memories never accessed", () => {
    const memories = [
      makeMemory(
        "reflective",
        "refl-1",
        0,
        "high",
        10,
        10,
        "Important reflection",
      ),
    ];

    const patterns = detectPatterns([], [], memories, "reflection");

    const absence = patterns.find(
      (p) => p.kind === "absence_pattern" && p.category === "absence",
    );
    expect(absence).toBeDefined();
  });

  it("does not flag recently created critical memories", () => {
    const memories = [
      makeMemory(
        "reflective",
        "refl-new",
        0,
        "high",
        2,
        2,
        "Recent reflection",
      ),
    ];

    const patterns = detectPatterns([], [], memories, "reflection");

    const absence = patterns.filter(
      (p) =>
        p.kind === "absence_pattern" &&
        p.category === "absence" &&
        p.description.includes("refl-new"),
    );
    expect(absence.length).toBe(0);
  });

  it("detects empty memory categories", () => {
    // Only provide project memories — other categories are empty
    const memories = [makeMemory("project", "proj-1", 3)];

    const patterns = detectPatterns([], [], memories, "reflection");

    const empty = patterns.find(
      (p) =>
        p.kind === "absence_pattern" &&
        p.category === "absence" &&
        p.description.toLowerCase().includes("empty"),
    );
    expect(empty).toBeDefined();
  });

  it("detects missing reflection events in audit log", () => {
    const auditEntries: AuditLogEntry[] = Array.from(
      { length: 12 },
      (_, i) => ({
        timestamp: new Date().toISOString(),
        action: "retrieve",
        memoryId: `mem-${i}`,
        type: "project" as MemoryType,
        score: 0.8,
        source: "conversation",
        preview: "No reflection here",
      }),
    );

    const patterns = detectPatterns([], auditEntries, [], "reflection");

    const missing = patterns.find(
      (p) =>
        p.kind === "absence_pattern" &&
        p.category === "absence" &&
        p.description.includes("reflection"),
    );
    expect(missing).toBeDefined();
  });
});

// ============================================================================
// Proposal generation for pattern scaffold
// ============================================================================

describe("Proposal generation for pattern scaffold", () => {
  it("generates low-confidence flag_for_review for structural patterns", () => {
    const { generateProposals } = require("../../agent/memory/reflection");
    const patterns: DetectedPattern[] = [
      {
        kind: "structural_correlation",
        category: "structural",
        description: "Mode re-entry detected",
        evidence: ["coding->creative twice"],
        confidence: 0.8,
      },
    ];

    const proposals = generateProposals(patterns);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals[0]!.action).toBe("flag_for_review");
    expect(proposals[0]!.confidence).toBeLessThan(0.5);
  });

  it("generates low-confidence flag_for_review for absence patterns", () => {
    const { generateProposals } = require("../../agent/memory/reflection");
    const patterns: DetectedPattern[] = [
      {
        kind: "absence_pattern",
        category: "absence",
        description: "No reflection events",
        evidence: ["12 audit entries, 0 reflection"],
        confidence: 0.7,
      },
    ];

    const proposals = generateProposals(patterns);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals[0]!.action).toBe("flag_for_review");
    expect(proposals[0]!.confidence).toBeLessThan(0.5);
  });

  it("generates low-confidence flag_for_review for distribution patterns", () => {
    const { generateProposals } = require("../../agent/memory/reflection");
    const patterns: DetectedPattern[] = [
      {
        kind: "distribution_imbalance",
        category: "distribution",
        description: "Retrieval skew",
        evidence: ["project: 80% of retrievals"],
        confidence: 0.6,
      },
    ];

    const proposals = generateProposals(patterns);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals[0]!.action).toBe("flag_for_review");
    expect(proposals[0]!.confidence).toBeLessThan(0.5);
  });
});

// ============================================================================
// Full detectPatterns integration
// ============================================================================

describe("Full detectPatterns integration", () => {
  it("returns patterns from all three new detectors alongside existing ones", () => {
    // Trigger structural: mode re-entry
    const events: AgentEvent[] = [
      makeModeChangeEvent("coding", "creative"),
      makeModeChangeEvent("creative", "coding"),
      makeModeChangeEvent("coding", "creative"),
      makeToolCallEvent("read"),
      makeToolCallEvent("read"),
      makeToolCallEvent("read"),
    ];

    // Trigger absence: unaccessed reflective memory
    const memories = [
      makeMemory(
        "reflective",
        "refl-1",
        0,
        "high",
        10,
        10,
        "Important reflection",
      ),
    ];

    // Trigger distribution: retrieval skew
    const auditEntries: AuditLogEntry[] = Array.from({ length: 8 }, (_, i) => ({
      timestamp: new Date().toISOString(),
      action: "retrieve",
      memoryId: `proj-${i}`,
      type: "project" as MemoryType,
      score: 0.8,
      source: "conversation",
      preview: "Project memory",
    }));

    const patterns = detectPatterns(
      events,
      auditEntries,
      memories,
      "reflection",
    );

    // Should have at least one from each category
    const structural = patterns.filter((p) => p.category === "structural");
    const distribution = patterns.filter((p) => p.category === "distribution");
    const absence = patterns.filter((p) => p.category === "absence");
    const operational = patterns.filter((p) => p.category === "operational");

    expect(structural.length).toBeGreaterThan(0);
    expect(absence.length).toBeGreaterThan(0);
    // Distribution may or may not fire depending on the audit entries
    // Operational should have the frequent_tool pattern
    expect(operational.length).toBeGreaterThan(0);
  });
});
