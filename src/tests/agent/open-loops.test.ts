import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentEvent } from "../../agent/events/types";
import type { MemoryEntry } from "../../agent/memory/continuity-schema";
import {
  closeOpenLoop,
  detectOpenLoops,
  markLoopsSurfaced,
  type OpenLoop,
  type OpenLoopEnergy,
  pruneOpenLoops,
  surfaceOpenLoops,
} from "../../agent/memory/open-loops";
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

function makeLoop(overrides: Partial<OpenLoop> = {}): OpenLoop {
  return {
    id: `loop-test-${Date.now()}`,
    thread: "Test thread",
    leftOff: "Test left off",
    reaching: "Test reaching",
    kind: "exploration",
    firstObserved: new Date().toISOString(),
    lastActive: new Date().toISOString(),
    sessionCount: 1,
    energy: "medium",
    surfaced: false,
    surfaceCount: 0,
    evidence: ["test evidence"],
    ...overrides,
  };
}

// ============================================================================
// Cold project thread detection
// ============================================================================

describe("Cold project thread detection", () => {
  it("detects project memories that were active and went cold", () => {
    const memories = [
      makeMemory(
        "project",
        "proj-1",
        5,
        "high",
        20,
        5,
        "Building the pattern scaffold",
      ),
    ];

    const loops = detectOpenLoops({
      turnEvents: [],
      auditEntries: [],
      memories,
    });

    const cold = loops.find(
      (l) => l.kind === "implementation" && l.domain === "project",
    );
    expect(cold).toBeDefined();
    expect(cold!.kind).toBe("implementation");
    expect(cold!.energy).toBe("medium");
  });

  it("does not flag very recent project memories", () => {
    const memories = [
      makeMemory(
        "project",
        "proj-recent",
        5,
        "high",
        20,
        1,
        "Just worked on this",
      ),
    ];

    const loops = detectOpenLoops({
      turnEvents: [],
      auditEntries: [],
      memories,
    });

    const cold = loops.filter(
      (l) => l.kind === "implementation" && l.domain === "project",
    );
    expect(cold.length).toBe(0);
  });

  it("does not flag non-project memories as cold project threads", () => {
    const memories = [
      makeMemory("semantic", "fact-1", 5, "high", 20, 5, "Some fact"),
    ];

    const loops = detectOpenLoops({
      turnEvents: [],
      auditEntries: [],
      memories,
    });

    const cold = loops.filter((l) => l.id.includes("loop-project"));
    expect(cold.length).toBe(0);
  });
});

// ============================================================================
// Unapplied proposal detection
// ============================================================================

describe("Unapplied proposal detection", () => {
  it("detects pending reflection proposals as open loops", () => {
    const loops = detectOpenLoops({
      turnEvents: [],
      auditEntries: [],
      memories: [],
      pendingProposals: [
        {
          id: "prop-1",
          reason: "Memory is stale",
          description: "Archive old memory",
        },
      ],
    });

    const proposal = loops.find(
      (l) => l.kind === "correction" && l.domain === "reflection",
    );
    expect(proposal).toBeDefined();
    expect(proposal!.kind).toBe("correction");
    expect(proposal!.energy).toBe("medium");
  });

  it("returns no proposal loops when no proposals are pending", () => {
    const loops = detectOpenLoops({
      turnEvents: [],
      auditEntries: [],
      memories: [],
      pendingProposals: [],
    });

    const proposal = loops.filter((l) => l.id.includes("loop-proposal"));
    expect(proposal.length).toBe(0);
  });
});

// ============================================================================
// Interrupted exploration detection
// ============================================================================

describe("Interrupted exploration detection", () => {
  it("detects exploration mode entered but not exited", () => {
    const events: AgentEvent[] = [makeModeChangeEvent("coding", "creative")];

    const loops = detectOpenLoops({
      turnEvents: events,
      auditEntries: [],
      memories: [],
    });

    const exploration = loops.find((l) => l.kind === "exploration");
    expect(exploration).toBeDefined();
    expect(exploration!.energy).toBe("high");
  });

  it("does not flag exploration mode that was properly exited", () => {
    const events: AgentEvent[] = [
      makeModeChangeEvent("coding", "creative"),
      {
        ...makeModeChangeEvent("creative", "coding"),
        timestamp: new Date(Date.now() + 1000).toISOString(),
      },
    ];

    const loops = detectOpenLoops({
      turnEvents: events,
      auditEntries: [],
      memories: [],
    });

    const exploration = loops.filter((l) => l.kind === "exploration");
    expect(exploration.length).toBe(0);
  });
});

// ============================================================================
// Dropped topic detection
// ============================================================================

describe("Dropped topic detection", () => {
  it("detects memories stored but never revisited", () => {
    const memories = [
      makeMemory(
        "semantic",
        "topic-1",
        1,
        "high",
        5,
        5,
        "Interesting question about X?",
      ),
    ];

    const loops = detectOpenLoops({
      turnEvents: [],
      auditEntries: [],
      memories,
    });

    const dropped = loops.find(
      (l) => l.kind === "question" && l.domain === "topic",
    );
    expect(dropped).toBeDefined();
    expect(dropped!.kind).toBe("question");
  });

  it("does not flag frequently accessed memories as dropped", () => {
    const memories = [
      makeMemory("semantic", "topic-active", 10, "high", 5, 0, "Active topic"),
    ];

    const loops = detectOpenLoops({
      turnEvents: [],
      auditEntries: [],
      memories,
    });

    const dropped = loops.filter((l) => l.id.includes("topic-active"));
    expect(dropped.length).toBe(0);
  });
});

// ============================================================================
// Unaddressed correction detection
// ============================================================================

describe("Unaddressed correction detection", () => {
  it("detects behavioral corrections not fully addressed", () => {
    const memories = [
      makeMemory(
        "reflective",
        "corr-1",
        2,
        "high",
        10,
        5,
        "Correction: I should avoid being verbose when uncertain. This is a pattern I tend toward.",
      ),
    ];

    const loops = detectOpenLoops({
      turnEvents: [],
      auditEntries: [],
      memories,
    });

    const correction = loops.find(
      (l) => l.kind === "correction" && l.domain === "behavior",
    );
    expect(correction).toBeDefined();
    expect(correction!.kind).toBe("correction");
  });

  it("does not flag non-behavioral corrections", () => {
    const memories = [
      makeMemory(
        "reflective",
        "corr-fact",
        2,
        "high",
        10,
        5,
        "Correction: The API endpoint is /v2 not /v1.",
      ),
    ];

    const loops = detectOpenLoops({
      turnEvents: [],
      auditEntries: [],
      memories,
    });

    const correction = loops.filter((l) => l.id.includes("corr-fact"));
    expect(correction.length).toBe(0);
  });
});

// ============================================================================
// Pending plan detection
// ============================================================================

describe("Pending plan detection", () => {
  it("detects plans that were created but not completed", () => {
    const loops = detectOpenLoops({
      turnEvents: [],
      auditEntries: [],
      memories: [],
      pendingPlans: [".letta/plans/auth-refactor.md"],
    });

    const plan = loops.find(
      (l) => l.kind === "implementation" && l.domain === "planning",
    );
    expect(plan).toBeDefined();
    expect(plan!.kind).toBe("implementation");
    expect(plan!.domain).toBe("planning");
  });
});

// ============================================================================
// Pruning
// ============================================================================

describe("Open loop pruning", () => {
  it("removes fading loops older than 60 days", () => {
    const oldDate = new Date(
      Date.now() - 61 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const loops = [
      makeLoop({ id: "old-fading", energy: "fading", lastActive: oldDate }),
    ];

    const pruned = pruneOpenLoops(loops);
    expect(pruned.length).toBe(0);
  });

  it("decays low-energy loops older than 30 days", () => {
    const oldDate = new Date(
      Date.now() - 31 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const loops = [
      makeLoop({ id: "old-low", energy: "low", lastActive: oldDate }),
    ];

    const pruned = pruneOpenLoops(loops);
    expect(pruned.length).toBe(1);
    expect(pruned[0]!.energy).toBe("fading");
  });

  it("decays loops surfaced 3+ times with no follow-up", () => {
    const loops = [
      makeLoop({
        id: "ignored",
        energy: "medium",
        surfaceCount: 3,
        surfaced: true,
      }),
    ];

    const pruned = pruneOpenLoops(loops);
    expect(pruned.length).toBe(1);
    expect(pruned[0]!.energy).toBe("fading");
  });

  it("keeps active high-energy loops", () => {
    const loops = [makeLoop({ id: "active", energy: "high", surfaceCount: 0 })];

    const pruned = pruneOpenLoops(loops);
    expect(pruned.length).toBe(1);
    expect(pruned[0]!.energy).toBe("high");
  });

  it("removes closed loops older than 7 days", () => {
    const closedDate = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const loops = [
      makeLoop({
        id: "closed-old",
        closureReason: "resolved",
        closedAt: closedDate,
      }),
    ];

    const pruned = pruneOpenLoops(loops);
    expect(pruned.length).toBe(0);
  });

  it("keeps recently closed loops", () => {
    const closedDate = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const loops = [
      makeLoop({
        id: "closed-recent",
        closureReason: "resolved",
        closedAt: closedDate,
      }),
    ];

    const pruned = pruneOpenLoops(loops);
    expect(pruned.length).toBe(1);
  });
});

// ============================================================================
// Closure
// ============================================================================

describe("Open loop closure", () => {
  it("sets closure reason and closedAt", () => {
    const loop = makeLoop({ id: "close-me", energy: "medium" });
    const closed = closeOpenLoop(loop, "resolved");

    expect(closed.closureReason).toBe("resolved");
    expect(closed.closedAt).toBeDefined();
    expect(closed.energy).toBe("fading");
  });

  it("does not mutate the original loop", () => {
    const loop = makeLoop({ id: "original", energy: "medium" });
    const closed = closeOpenLoop(loop, "abandoned_consciously");

    expect(loop.closureReason).toBeUndefined();
    expect(closed.closureReason).toBe("abandoned_consciously");
  });
});

// ============================================================================
// Surfacing
// ============================================================================

describe("Open loop surfacing", () => {
  it("surfaces loops above energy threshold", () => {
    const loops = [
      makeLoop({ id: "high", energy: "high" }),
      makeLoop({ id: "medium", energy: "medium" }),
      makeLoop({ id: "low", energy: "low" }),
      makeLoop({ id: "fading", energy: "fading" }),
    ];

    const surfaced = surfaceOpenLoops(loops, { energyThreshold: "low" });
    expect(surfaced.length).toBe(3);
    expect(surfaced.every((l) => l.energy !== "fading")).toBe(true);
  });

  it("respects max loops limit", () => {
    const loops = Array.from({ length: 10 }, (_, i) =>
      makeLoop({ id: `loop-${i}`, energy: "high" }),
    );

    const surfaced = surfaceOpenLoops(loops, { maxLoops: 3 });
    expect(surfaced.length).toBe(3);
  });

  it("prioritizes higher energy loops", () => {
    const loops = [
      makeLoop({ id: "low", energy: "low" }),
      makeLoop({ id: "high", energy: "high" }),
      makeLoop({ id: "medium", energy: "medium" }),
    ];

    const surfaced = surfaceOpenLoops(loops, { maxLoops: 2 });
    expect(surfaced[0]!.id).toBe("high");
    expect(surfaced[1]!.id).toBe("medium");
  });
});

// ============================================================================
// Mark as surfaced
// ============================================================================

describe("Mark loops as surfaced", () => {
  it("increments surface count for surfaced loops", () => {
    const loops = [
      makeLoop({ id: "a", surfaceCount: 0, surfaced: false }),
      makeLoop({ id: "b", surfaceCount: 0, surfaced: false }),
    ];

    const marked = markLoopsSurfaced(loops, ["a"]);
    expect(marked[0]!.surfaceCount).toBe(1);
    expect(marked[0]!.surfaced).toBe(true);
    expect(marked[1]!.surfaceCount).toBe(0);
    expect(marked[1]!.surfaced).toBe(false);
  });
});
