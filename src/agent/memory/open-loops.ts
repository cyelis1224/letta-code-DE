/**
 * Open Loops — continuity map of threads that were alive and then stopped.
 *
 * This module tracks threads that were being explored or worked on and
 * then went quiet. It is not a task list — it is a continuity map that
 * helps the agent pick up where it left off across sessions.
 *
 * Open loops are detected from memory access patterns, event history,
 * pending proposals, and plan files. They are pruned over time as they
 * fade, get resolved, or become irrelevant.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "../events/types";
import type { MemoryEntry } from "./continuity-schema";

// ============================================================================
// Types
// ============================================================================

/**
 * Energy levels for open loops, from most to least active.
 */
export type OpenLoopEnergy = "high" | "medium" | "low" | "fading";

/**
 * An open loop — a thread that was alive and then stopped.
 */
export interface OpenLoop {
  id: string;
  /** What was being explored or worked on */
  thread: string;
  /** Where it was left off */
  leftOff: string;
  /** What was being reached for */
  reaching: string;
  kind: "exploration" | "implementation" | "question" | "correction";
  energy: OpenLoopEnergy;
  /** Project or area */
  domain?: string;
  /** ISO timestamp of first observation */
  firstObserved: string;
  /** ISO timestamp of last activity */
  lastActive: string;
  /** Number of sessions this loop has appeared in */
  sessionCount: number;
  /** Whether this loop has been surfaced to the agent */
  surfaced: boolean;
  /** How many times this loop has been surfaced */
  surfaceCount: number;
  /** Evidence supporting this loop */
  evidence: string[];
  /** Why this loop was closed, if it was */
  closureReason?:
    | "resolved"
    | "abandoned_consciously"
    | "replaced_by_new_thread"
    | "no_longer_relevant"
    | "merged_into_project";
  /** ISO timestamp of when this loop was closed */
  closedAt?: string;
}

/**
 * The audit log entry format (mirrors reflection.ts).
 */
interface AuditLogEntry {
  timestamp: string;
  action: string;
  memoryId: string;
  type: string;
  score: number;
  source: string;
  preview: string;
}

/**
 * Input for open loop detection.
 */
export interface OpenLoopDetectionInput {
  /** Recent events from the turn */
  turnEvents: AgentEvent[];
  /** Audit log entries from the memory pipeline */
  auditEntries: AuditLogEntry[];
  /** Current memories from the continuity core */
  memories: MemoryEntry[];
  /** Pending proposals awaiting review */
  pendingProposals?: { id: string; reason: string; description: string }[];
  /** Pending plan file paths */
  pendingPlans?: string[];
}

/**
 * Options for surfacing open loops.
 */
export interface SurfaceOptions {
  /** Maximum number of loops to surface (default 5) */
  maxLoops?: number;
  /** Minimum energy threshold for surfacing (default "low") */
  energyThreshold?: OpenLoopEnergy;
}

// ============================================================================
// Energy Ordering
// ============================================================================

const ENERGY_ORDER: Record<OpenLoopEnergy, number> = {
  high: 3,
  medium: 2,
  low: 1,
  fading: 0,
};

/**
 * Check if a loop's energy meets or exceeds the threshold.
 */
function meetsEnergyThreshold(
  energy: OpenLoopEnergy,
  threshold: OpenLoopEnergy,
): boolean {
  return ENERGY_ORDER[energy] >= ENERGY_ORDER[threshold];
}

// ============================================================================
// Detection Helpers
// ============================================================================

/**
 * Compute days since a given ISO timestamp.
 */
function daysSince(timestamp: string): number {
  return (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Check if a string contains any of the given keywords (case-insensitive).
 */
function containsAnyKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

// ============================================================================
// Detection Functions
// ============================================================================

/**
 * Detect project memories that were active (accessCount >= 3) and went cold
 * (daysSinceAccess between 3 and 14).
 *
 * Energy: medium if <7 days cold, low if 7-14 days cold.
 * Kind: implementation. Domain: project.
 */
function detectColdProjectThreads(memories: MemoryEntry[]): OpenLoop[] {
  const now = new Date().toISOString();
  const loops: OpenLoop[] = [];

  const projectMemories = memories.filter(
    (m) => m.frontmatter.type === "project",
  );

  let idx = 0;
  for (const mem of projectMemories) {
    const daysSinceAccess = daysSince(mem.frontmatter.lastAccessedAt);

    if (
      mem.frontmatter.accessCount >= 3 &&
      daysSinceAccess >= 3 &&
      daysSinceAccess <= 14
    ) {
      const energy: OpenLoopEnergy = daysSinceAccess < 7 ? "medium" : "low";
      const projectNames = mem.frontmatter.projects?.join(", ") || "project";

      loops.push({
        id: `loop-implementation-${Date.now()}-${idx}`,
        thread: mem.content.slice(0, 120),
        leftOff: `Last active ${daysSinceAccess.toFixed(0)} days ago`,
        reaching: `Resume work on ${projectNames}`,
        kind: "implementation",
        energy,
        domain: "project",
        firstObserved: mem.frontmatter.createdAt,
        lastActive: mem.frontmatter.lastAccessedAt,
        sessionCount: 1,
        surfaced: false,
        surfaceCount: 0,
        evidence: [
          `Memory ID: ${mem.frontmatter.id}`,
          `Access count: ${mem.frontmatter.accessCount}`,
          `Days since access: ${daysSinceAccess.toFixed(1)}`,
          `Preview: ${mem.content.slice(0, 80)}`,
        ],
      });
      idx++;
    }
  }

  return loops;
}

/**
 * Detect unapplied proposals — each pending proposal becomes a loop.
 *
 * Kind: correction. Energy: medium. Domain: reflection.
 */
function detectUnappliedProposals(
  pendingProposals: { id: string; reason: string; description: string }[],
): OpenLoop[] {
  const now = new Date().toISOString();
  const loops: OpenLoop[] = [];

  let idx = 0;
  for (const proposal of pendingProposals) {
    loops.push({
      id: `loop-correction-${Date.now()}-${idx}`,
      thread: proposal.description,
      leftOff: `Proposal ${proposal.id} awaiting review`,
      reaching: proposal.reason,
      kind: "correction",
      energy: "medium",
      domain: "reflection",
      firstObserved: now,
      lastActive: now,
      sessionCount: 1,
      surfaced: false,
      surfaceCount: 0,
      evidence: [
        `Proposal ID: ${proposal.id}`,
        `Reason: ${proposal.reason}`,
        `Description: ${proposal.description}`,
      ],
    });
    idx++;
  }

  return loops;
}

/**
 * Detect interrupted exploration — mode_change events to
 * creative/research/reflection mode with no matching exit.
 *
 * Kind: exploration. Energy: high. Domain: exploration.
 */
function detectInterruptedExploration(turnEvents: AgentEvent[]): OpenLoop[] {
  const now = new Date().toISOString();
  const loops: OpenLoop[] = [];

  const explorationModes = new Set(["creative", "research", "reflection"]);

  // Collect mode changes into exploration modes
  const entries: { to: string; from: string; timestamp: string }[] = [];
  const exits: { from: string; to: string; timestamp: string }[] = [];

  for (const event of turnEvents) {
    if (event.type !== "mode_change") continue;
    const modeEvent = event as { from: string; to: string; timestamp: string };

    if (explorationModes.has(modeEvent.to)) {
      entries.push({
        to: modeEvent.to,
        from: modeEvent.from,
        timestamp: modeEvent.timestamp,
      });
    } else if (explorationModes.has(modeEvent.from)) {
      exits.push({
        from: modeEvent.from,
        to: modeEvent.to,
        timestamp: modeEvent.timestamp,
      });
    }
  }

  // Find entries without a matching exit (same mode, exit after entry)
  let loopIndex = 0;
  for (const entry of entries) {
    const hasMatchingExit = exits.some(
      (exit) =>
        exit.from === entry.to &&
        new Date(exit.timestamp).getTime() >
          new Date(entry.timestamp).getTime(),
    );

    if (!hasMatchingExit) {
      loops.push({
        id: `loop-exploration-${Date.now()}-${loopIndex++}`,
        thread: `Exploration in ${entry.to} mode`,
        leftOff: `Entered ${entry.to} mode from ${entry.from}`,
        reaching: `Complete the ${entry.to} exploration`,
        kind: "exploration",
        energy: "high",
        domain: "exploration",
        firstObserved: entry.timestamp,
        lastActive: entry.timestamp,
        sessionCount: 1,
        surfaced: false,
        surfaceCount: 0,
        evidence: [
          `Mode change: ${entry.from} → ${entry.to}`,
          `Entered at: ${entry.timestamp}`,
          `No matching exit event found`,
        ],
      });
    }
  }

  return loops;
}

/**
 * Detect dropped topics — memories with accessCount <= 1, age 2-30 days,
 * NOT project type, content looks like a question or exploration.
 *
 * Kind: question. Energy: low. Domain: topic.
 */
function detectDroppedTopics(memories: MemoryEntry[]): OpenLoop[] {
  const now = new Date().toISOString();
  const loops: OpenLoop[] = [];

  const explorationKeywords = [
    "explore",
    "investigate",
    "look into",
    "what about",
  ];

  let idx = 0;
  for (const mem of memories) {
    const ageDays = daysSince(mem.frontmatter.createdAt);

    if (
      mem.frontmatter.accessCount <= 1 &&
      ageDays >= 2 &&
      ageDays <= 30 &&
      mem.frontmatter.type !== "project"
    ) {
      const content = mem.content;
      const hasQuestion = content.includes("?");
      const hasExplorationKeyword = containsAnyKeyword(
        content,
        explorationKeywords,
      );

      if (hasQuestion || hasExplorationKeyword) {
        loops.push({
          id: `loop-question-${Date.now()}-${idx}`,
          thread: content.slice(0, 120),
          leftOff: `Topic raised ${ageDays.toFixed(0)} days ago, not revisited`,
          reaching: hasQuestion
            ? "Answer the question"
            : "Investigate the topic",
          kind: "question",
          energy: "low",
          domain: "topic",
          firstObserved: mem.frontmatter.createdAt,
          lastActive: mem.frontmatter.lastAccessedAt,
          sessionCount: 1,
          surfaced: false,
          surfaceCount: 0,
          evidence: [
            `Memory ID: ${mem.frontmatter.id}`,
            `Type: ${mem.frontmatter.type}`,
            `Access count: ${mem.frontmatter.accessCount}`,
            `Age: ${ageDays.toFixed(1)} days`,
            `Preview: ${content.slice(0, 80)}`,
          ],
        });
        idx++;
      }
    }
  }

  return loops;
}

/**
 * Detect unaddressed corrections — reflective memories with accessCount <= 3,
 * daysSinceAccess > 3, content contains correction language.
 *
 * Kind: correction. Energy: medium. Domain: behavior.
 */
function detectUnaddressedCorrections(memories: MemoryEntry[]): OpenLoop[] {
  const now = new Date().toISOString();
  const loops: OpenLoop[] = [];

  const correctionKeywords = [
    "I should",
    "avoid",
    "don't tend",
    "correction",
    "I tend toward",
  ];

  const reflectiveMemories = memories.filter(
    (m) => m.frontmatter.type === "reflective",
  );

  let idx = 0;
  for (const mem of reflectiveMemories) {
    const daysSinceAccess = daysSince(mem.frontmatter.lastAccessedAt);

    if (
      mem.frontmatter.accessCount <= 3 &&
      daysSinceAccess > 3 &&
      containsAnyKeyword(mem.content, correctionKeywords)
    ) {
      loops.push({
        id: `loop-correction-${Date.now()}-${idx}`,
        thread: mem.content.slice(0, 120),
        leftOff: `Correction noted ${daysSinceAccess.toFixed(0)} days ago, not applied`,
        reaching: "Apply the self-correction",
        kind: "correction",
        energy: "medium",
        domain: "behavior",
        firstObserved: mem.frontmatter.createdAt,
        lastActive: mem.frontmatter.lastAccessedAt,
        sessionCount: 1,
        surfaced: false,
        surfaceCount: 0,
        evidence: [
          `Memory ID: ${mem.frontmatter.id}`,
          `Access count: ${mem.frontmatter.accessCount}`,
          `Days since access: ${daysSinceAccess.toFixed(1)}`,
          `Preview: ${mem.content.slice(0, 80)}`,
        ],
      });
      idx++;
    }
  }

  return loops;
}

/**
 * Detect pending plans — each plan file path becomes a loop.
 *
 * Kind: implementation. Energy: medium. Domain: planning.
 */
function detectPendingPlans(pendingPlans: string[]): OpenLoop[] {
  const now = new Date().toISOString();
  const loops: OpenLoop[] = [];

  let idx = 0;
  for (const planPath of pendingPlans) {
    loops.push({
      id: `loop-implementation-${Date.now()}-${idx}`,
      thread: `Plan: ${planPath}`,
      leftOff: `Plan file exists, not yet executed`,
      reaching: `Execute the plan at ${planPath}`,
      kind: "implementation",
      energy: "medium",
      domain: "planning",
      firstObserved: now,
      lastActive: now,
      sessionCount: 1,
      surfaced: false,
      surfaceCount: 0,
      evidence: [`Plan path: ${planPath}`],
    });
    idx++;
  }

  return loops;
}

// ============================================================================
// Main Detection
// ============================================================================

/**
 * Detect open loops from the current session state.
 *
 * Runs all six detection functions and returns the combined results.
 */
export function detectOpenLoops(input: OpenLoopDetectionInput): OpenLoop[] {
  const allLoops: OpenLoop[] = [];

  allLoops.push(...detectColdProjectThreads(input.memories));
  allLoops.push(...detectUnappliedProposals(input.pendingProposals || []));
  allLoops.push(...detectInterruptedExploration(input.turnEvents));
  allLoops.push(...detectDroppedTopics(input.memories));
  allLoops.push(...detectUnaddressedCorrections(input.memories));
  allLoops.push(...detectPendingPlans(input.pendingPlans || []));

  return allLoops;
}

// ============================================================================
// Persistence
// ============================================================================

const LOOPS_DIR = "reference/open-loops";
const LOOPS_FILE = "loops.json";

/**
 * Write open loops to disk, merging with existing entries.
 *
 * Matches by id: existing entries get lastActive and sessionCount
 * updated, new entries are added.
 */
export function writeOpenLoops(loops: OpenLoop[], memoryRoot: string): void {
  const dirPath = join(memoryRoot, LOOPS_DIR);
  const filePath = join(dirPath, LOOPS_FILE);

  // Ensure directory exists
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }

  // Load existing loops
  let existing: OpenLoop[] = [];
  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, "utf-8");
      existing = JSON.parse(content) as OpenLoop[];
    } catch {
      existing = [];
    }
  }

  // Build a map of existing loops by id
  const existingMap = new Map<string, OpenLoop>();
  for (const loop of existing) {
    existingMap.set(loop.id, loop);
  }

  // Merge: update existing, add new
  const now = new Date().toISOString();
  for (const loop of loops) {
    const existingLoop = existingMap.get(loop.id);
    if (existingLoop) {
      // Update existing entry
      existingLoop.lastActive = now;
      existingLoop.sessionCount += 1;
      // Preserve surfaced/surfaceCount from existing
      // Update evidence if new evidence is richer
      if (loop.evidence.length > existingLoop.evidence.length) {
        existingLoop.evidence = loop.evidence;
      }
    } else {
      // New entry
      existingMap.set(loop.id, loop);
    }
  }

  const merged = Array.from(existingMap.values());

  writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf-8");
}

/**
 * Load open loops from disk.
 */
export function loadOpenLoops(memoryRoot: string): OpenLoop[] {
  const filePath = join(memoryRoot, LOOPS_DIR, LOOPS_FILE);
  if (!existsSync(filePath)) return [];

  try {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as OpenLoop[];
  } catch {
    return [];
  }
}

// ============================================================================
// Pruning
// ============================================================================

/**
 * Prune open loops based on aging and relevance rules.
 *
 * - fading loops with lastActive > 60 days ago → remove
 * - low energy loops with lastActive > 30 days ago → set energy to fading
 * - Loops with surfaceCount >= 3 and no follow-up (still surfaced, not closed) → set energy to fading
 * - Closed loops (closureReason set) with closedAt > 7 days ago → remove
 */
export function pruneOpenLoops(loops: OpenLoop[]): OpenLoop[] {
  const result: OpenLoop[] = [];

  for (const loop of loops) {
    const daysSinceLastActive = daysSince(loop.lastActive);

    // Closed loops with closedAt > 7 days ago → remove
    if (loop.closureReason && loop.closedAt) {
      const daysSinceClosed = daysSince(loop.closedAt);
      if (daysSinceClosed > 7) {
        continue; // prune
      }
    }

    // fading loops with lastActive > 60 days ago → remove
    if (loop.energy === "fading" && daysSinceLastActive > 60) {
      continue; // prune
    }

    // Create a mutable copy for potential modifications
    const updated = { ...loop };

    // low energy loops with lastActive > 30 days ago → set energy to fading
    if (updated.energy === "low" && daysSinceLastActive > 30) {
      updated.energy = "fading";
    }

    // Loops with surfaceCount >= 3 and no follow-up (still surfaced, not closed) → set energy to fading
    if (
      updated.surfaceCount >= 3 &&
      updated.surfaced &&
      !updated.closureReason
    ) {
      updated.energy = "fading";
    }

    result.push(updated);
  }

  return result;
}

// ============================================================================
// Closing
// ============================================================================

/**
 * Close an open loop with a reason.
 *
 * Returns a new OpenLoop with closureReason set, closedAt set to now,
 * and energy set to "fading".
 */
export function closeOpenLoop(
  loop: OpenLoop,
  reason: OpenLoop["closureReason"],
): OpenLoop {
  return {
    ...loop,
    closureReason: reason,
    closedAt: new Date().toISOString(),
    energy: "fading",
  };
}

// ============================================================================
// Surfacing
// ============================================================================

/**
 * Select which open loops to surface to the agent.
 *
 * Filters by energy threshold (high > medium > low > fading — only include
 * loops at or above threshold). Sorts by energy (high first), then by
 * lastActive (most recent first). Limits to maxLoops.
 */
export function surfaceOpenLoops(
  loops: OpenLoop[],
  options?: SurfaceOptions,
): OpenLoop[] {
  const maxLoops = options?.maxLoops ?? 5;
  const energyThreshold = options?.energyThreshold ?? "low";

  // Filter out closed loops
  const openLoops = loops.filter((loop) => !loop.closureReason);

  // Filter by energy threshold
  const filtered = openLoops.filter((loop) =>
    meetsEnergyThreshold(loop.energy, energyThreshold),
  );

  // Sort by energy (high first), then by lastActive (most recent first)
  filtered.sort((a, b) => {
    const energyDiff = ENERGY_ORDER[b.energy] - ENERGY_ORDER[a.energy];
    if (energyDiff !== 0) return energyDiff;

    return new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime();
  });

  return filtered.slice(0, maxLoops);
}

/**
 * Mark loops as surfaced — increment surfaceCount and set surfaced=true
 * for loops whose id is in surfacedIds.
 */
export function markLoopsSurfaced(
  loops: OpenLoop[],
  surfacedIds: string[],
): OpenLoop[] {
  const idSet = new Set(surfacedIds);

  return loops.map((loop) => {
    if (idSet.has(loop.id)) {
      return {
        ...loop,
        surfaced: true,
        surfaceCount: loop.surfaceCount + 1,
      };
    }
    return loop;
  });
}
