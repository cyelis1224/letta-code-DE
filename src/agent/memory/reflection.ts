/**
 * Reflection Loop — consume event history, detect patterns, propose updates.
 *
 * The reflection loop is the self-improvement layer of the continuity core.
 * It reads the audit log and event history, detects patterns in agent
 * behaviour, and generates proposals for memory updates, EIM adjustments,
 * and archival decisions.
 *
 * Proposals are queued for review — they are never auto-applied.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, AgentEventType } from "../events/types";
import { getMemoryFilesystemRoot } from "../memoryFilesystem";
import type { MemoryEntry } from "./continuity-schema";
import { parseMemoryEntry } from "./continuity-schema";
import {
  detectOpenLoops,
  type OpenLoop,
  type OpenLoopDetectionInput,
  writeOpenLoops,
} from "./open-loops";
import { loadMemoryIndex, queryMemories } from "./retrieval";
import type { MemoryType } from "./taxonomy";
import { MEMORY_TYPES } from "./taxonomy";

// ============================================================================
// Reflection Input
// ============================================================================

/**
 * Data the reflection loop consumes.
 */
export interface ReflectionInput {
  /** Recent events from the turn */
  turnEvents: AgentEvent[];
  /** Agent ID for scoped access */
  agentId: string;
  /** Conversation ID */
  conversationId?: string;
  /** How many turns since last reflection (for throttling) */
  turnsSinceLastReflection: number;
  /** Current task kind (for mode-dominance detection) */
  currentTaskKind?: string;
}

/**
 * The audit log entry format.
 */
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
// Pattern Detection
// ============================================================================

/**
 * A detected pattern in agent behaviour.
 */
export interface DetectedPattern {
  /** Pattern type */
  kind:
    | "frequent_tool" // Same tool used many times
    | "mode_oscillation" // Switching back and forth between modes
    | "memory_hot" // Memory retrieved frequently
    | "memory_cold" // Memory never retrieved
    | "memory_stale" // Memory not accessed in a long time
    | "preference_repeated" // User stated same preference multiple times
    | "correction" // User corrected the agent
    | "workflow" // Detectable workflow pattern
    | "structural_correlation" // Behavior correlated with context that wasn't chosen
    | "distribution_imbalance" // The shape of sessions over time
    | "absence_pattern"; // What the agent is NOT doing
  /** Description of the pattern */
  description: string;
  /** Evidence supporting this pattern */
  evidence: string[];
  /** Confidence in the detection (0-1) */
  confidence: number;
  /** Pattern category */
  category: "operational" | "structural" | "distribution" | "absence";
}

/**
 * Detect patterns from recent events.
 */
export function detectPatterns(
  events: AgentEvent[],
  auditEntries: AuditLogEntry[],
  memories: MemoryEntry[],
  currentTaskKind?: string,
): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];

  // 1. Frequent tool usage
  const toolCounts: Record<string, number> = {};
  for (const event of events) {
    if (event.type === "tool_call") {
      const name = (event as { toolName: string }).toolName;
      toolCounts[name] = (toolCounts[name] || 0) + 1;
    }
  }
  for (const [tool, count] of Object.entries(toolCounts)) {
    if (count >= 3) {
      patterns.push({
        kind: "frequent_tool",
        description: `Tool "${tool}" used ${count} times in recent turns`,
        evidence: [`${tool}: ${count} invocations`],
        confidence: 0.8,
        category: "operational",
      });
    }
  }

  // 2. Mode oscillation
  const modeChanges = events
    .filter((e) => e.type === "mode_change")
    .map((e) => e as { from: string; to: string });
  const modeTransitions: Record<string, number> = {};
  for (const change of modeChanges) {
    const key = `${change.from}->${change.to}`;
    modeTransitions[key] = (modeTransitions[key] || 0) + 1;
  }
  for (const [transition, count] of Object.entries(modeTransitions)) {
    if (count >= 2) {
      patterns.push({
        kind: "mode_oscillation",
        description: `Mode transition "${transition}" occurred ${count} times`,
        evidence: [`Transition: ${transition}, count: ${count}`],
        confidence: 0.7,
        category: "operational",
      });
    }
  }

  // 3. Hot memories (frequently accessed)
  for (const memory of memories) {
    if (memory.frontmatter.accessCount >= 5) {
      patterns.push({
        kind: "memory_hot",
        description: `Memory "${memory.frontmatter.id}" accessed ${memory.frontmatter.accessCount} times`,
        evidence: [
          `ID: ${memory.frontmatter.id}`,
          `Type: ${memory.frontmatter.type}`,
          `Access count: ${memory.frontmatter.accessCount}`,
          `Preview: ${memory.content.slice(0, 80)}`,
        ],
        confidence: 0.9,
        category: "operational",
      });
    }
  }

  // 4. Cold memories (never accessed, old)
  const now = Date.now();
  for (const memory of memories) {
    const ageDays =
      (now - new Date(memory.frontmatter.lastAccessedAt).getTime()) /
      (1000 * 60 * 60 * 24);
    if (memory.frontmatter.accessCount === 0 && ageDays > 7) {
      patterns.push({
        kind: "memory_cold",
        description: `Memory "${memory.frontmatter.id}" never accessed, ${ageDays.toFixed(0)} days old`,
        evidence: [
          `ID: ${memory.frontmatter.id}`,
          `Type: ${memory.frontmatter.type}`,
          `Created: ${memory.frontmatter.createdAt}`,
          `Preview: ${memory.content.slice(0, 80)}`,
        ],
        confidence: 0.6,
        category: "operational",
      });
    }
  }

  // 5. Stale memories (not accessed recently despite being important)
  for (const memory of memories) {
    const daysSinceAccess =
      (now - new Date(memory.frontmatter.lastAccessedAt).getTime()) /
      (1000 * 60 * 60 * 24);
    if (
      memory.frontmatter.accessCount > 0 &&
      daysSinceAccess > 30 &&
      memory.frontmatter.importance === "low"
    ) {
      patterns.push({
        kind: "memory_stale",
        description: `Low-importance memory "${memory.frontmatter.id}" not accessed in ${daysSinceAccess.toFixed(0)} days`,
        evidence: [
          `ID: ${memory.frontmatter.id}`,
          `Importance: ${memory.frontmatter.importance}`,
          `Last accessed: ${memory.frontmatter.lastAccessedAt}`,
        ],
        confidence: 0.7,
        category: "operational",
      });
    }
  }

  // 6. Recent audit entries with low scores (pipeline rejections)
  const lowScoreEntries = auditEntries.filter((e) => e.score < 0.5);
  if (lowScoreEntries.length >= 3) {
    patterns.push({
      kind: "preference_repeated",
      description: `${lowScoreEntries.length} memory candidates scored below 0.5 — classifier may need tuning`,
      evidence: lowScoreEntries.map(
        (e) => `Score: ${e.score}, preview: ${e.preview.slice(0, 60)}`,
      ),
      confidence: 0.5,
      category: "operational",
    });
  }

  // Structural, distribution, and absence patterns
  patterns.push(
    ...detectStructuralPatterns(events, memories),
    ...detectDistributionPatterns(auditEntries, events, currentTaskKind),
    ...detectAbsencePatterns(memories, auditEntries),
  );

  return patterns;
}

// ============================================================================
// Structural Pattern Detection
// ============================================================================

/**
 * Detect structural patterns — behavior correlated with context that wasn't
 * chosen, or structural anomalies in how the agent operates.
 */
function detectStructuralPatterns(
  events: AgentEvent[],
  memories: MemoryEntry[],
): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];

  // Mode re-entry: entering a mode and quickly bouncing back
  // (same mode entered twice within 5 events)
  const modeEvents = events.filter((e) => e.type === "mode_change");
  for (let i = 0; i < modeEvents.length; i++) {
    const current = modeEvents[i] as { from: string; to: string; id: string };
    for (let j = i + 1; j < Math.min(i + 5, modeEvents.length); j++) {
      const later = modeEvents[j] as { from: string; to: string; id: string };
      if (current.to === later.to) {
        patterns.push({
          kind: "structural_correlation",
          description: `Mode re-entry detected: mode "${current.to}" entered twice within 5 mode-change events`,
          evidence: [
            `First entry: ${current.from}->${current.to} (event ${current.id})`,
            `Re-entry: ${later.from}->${later.to} (event ${later.id})`,
          ],
          confidence: 0.6,
          category: "structural",
        });
        break; // Only report once per re-entry cluster
      }
    }
  }

  // Storage type skew: one memory type accounts for >60% of all stored memories
  if (memories.length > 0) {
    const typeCounts: Record<string, number> = {};
    for (const memory of memories) {
      typeCounts[memory.frontmatter.type] =
        (typeCounts[memory.frontmatter.type] || 0) + 1;
    }
    const total = memories.length;
    for (const [type, count] of Object.entries(typeCounts)) {
      const ratio = count / total;
      if (ratio > 0.6) {
        patterns.push({
          kind: "structural_correlation",
          description: `Storage type skew: "${type}" accounts for ${(ratio * 100).toFixed(0)}% of all memories (${count}/${total})`,
          evidence: [
            `Type: ${type}`,
            `Count: ${count}`,
            `Total: ${total}`,
            `Ratio: ${ratio.toFixed(2)}`,
          ],
          confidence: 0.7,
          category: "structural",
        });
      }
    }
  }

  return patterns;
}

// ============================================================================
// Distribution Pattern Detection
// ============================================================================

/**
 * Detect distribution patterns — the shape of sessions over time,
 * imbalances in how the agent's activity is distributed.
 */
function detectDistributionPatterns(
  auditEntries: AuditLogEntry[],
  events: AgentEvent[],
  currentTaskKind?: string,
): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];

  // Retrieval skew: one memory type accounts for >70% of all audit entries
  if (auditEntries.length > 0) {
    const typeCounts: Record<string, number> = {};
    for (const entry of auditEntries) {
      typeCounts[entry.type] = (typeCounts[entry.type] || 0) + 1;
    }
    const total = auditEntries.length;
    for (const [type, count] of Object.entries(typeCounts)) {
      const ratio = count / total;
      if (ratio > 0.7) {
        patterns.push({
          kind: "distribution_imbalance",
          description: `Retrieval skew: "${type}" accounts for ${(ratio * 100).toFixed(0)}% of all audit entries (${count}/${total})`,
          evidence: [
            `Type: ${type}`,
            `Count: ${count}`,
            `Total: ${total}`,
            `Ratio: ${ratio.toFixed(2)}`,
          ],
          confidence: 0.65,
          category: "distribution",
        });
      }
    }
  }

  // Mode dominance: no mode changes in events when currentTaskKind is
  // "reflection" (stuck in one mode)
  if (currentTaskKind === "reflection") {
    const hasModeChange = events.some((e) => e.type === "mode_change");
    if (!hasModeChange && events.length > 0) {
      patterns.push({
        kind: "distribution_imbalance",
        description: `Mode dominance: no mode changes during reflection task — agent may be stuck in one mode`,
        evidence: [
          `Current task: ${currentTaskKind}`,
          `Events: ${events.length}`,
          `Mode changes: 0`,
        ],
        confidence: 0.55,
        category: "distribution",
      });
    }
  }

  return patterns;
}

// ============================================================================
// Absence Pattern Detection
// ============================================================================

/**
 * Detect absence patterns — what the agent is NOT doing.
 * These are the most subtle patterns: things that should be present
 * but aren't.
 */
function detectAbsencePatterns(
  memories: MemoryEntry[],
  auditEntries: AuditLogEntry[],
): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];
  const now = Date.now();

  // Critical reflective memories never accessed
  // (importance=high, type=reflective, accessCount=0, age>7 days)
  for (const memory of memories) {
    if (
      memory.frontmatter.importance === "high" &&
      memory.frontmatter.type === "reflective" &&
      memory.frontmatter.accessCount === 0
    ) {
      const ageDays =
        (now - new Date(memory.frontmatter.createdAt).getTime()) /
        (1000 * 60 * 60 * 24);
      if (ageDays > 7) {
        patterns.push({
          kind: "absence_pattern",
          description: `Critical reflective memory "${memory.frontmatter.id}" never accessed (${ageDays.toFixed(0)} days old)`,
          evidence: [
            `ID: ${memory.frontmatter.id}`,
            `Type: ${memory.frontmatter.type}`,
            `Importance: ${memory.frontmatter.importance}`,
            `Access count: ${memory.frontmatter.accessCount}`,
            `Created: ${memory.frontmatter.createdAt}`,
          ],
          confidence: 0.7,
          category: "absence",
        });
      }
    }
  }

  // Empty memory categories (any MemoryType with zero entries in memories array)
  const presentTypes = new Set(memories.map((m) => m.frontmatter.type));
  for (const type of MEMORY_TYPES) {
    if (!presentTypes.has(type)) {
      patterns.push({
        kind: "absence_pattern",
        description: `Empty memory category: no "${type}" memories stored`,
        evidence: [
          `Type: ${type}`,
          `Present types: ${[...presentTypes].join(", ") || "(none)"}`,
        ],
        confidence: 0.5,
        category: "absence",
      });
    }
  }

  // Missing reflection events in audit log
  // (no entries with action containing "reflection" when there are >10 audit entries)
  if (auditEntries.length > 10) {
    const hasReflectionEntry = auditEntries.some((e) =>
      e.action.toLowerCase().includes("reflection"),
    );
    if (!hasReflectionEntry) {
      patterns.push({
        kind: "absence_pattern",
        description: `No reflection events in audit log despite ${auditEntries.length} total entries`,
        evidence: [
          `Total audit entries: ${auditEntries.length}`,
          `Reflection entries: 0`,
        ],
        confidence: 0.6,
        category: "absence",
      });
    }
  }

  return patterns;
}

// ============================================================================
// Pattern Trace
// ============================================================================

const PATTERN_TRACE_PATH = "reference/patterns/trace.md";

/**
 * A single entry in the pattern trace — a persistent record of
 * structural, distribution, and absence patterns observed over time.
 */
interface PatternTraceEntry {
  /** The pattern that was detected */
  pattern: DetectedPattern;
  /** Trace type: structural, distribution, or absence */
  type: "structural" | "distribution" | "absence";
  /** Evidence at time of detection */
  evidence: string[];
  /** When this pattern was first observed */
  firstObserved: string;
  /** When this pattern was most recently observed */
  lastObserved: string;
  /** How many times this pattern has been observed */
  frequency: number;
}

/**
 * Write pattern trace entries to the persistent trace file.
 *
 * Merges new patterns with existing trace, updates frequency and
 * lastObserved for recurring patterns, and prunes entries not
 * observed in 30 days.
 */
function writePatternTrace(
  newPatterns: DetectedPattern[],
  memoryRoot: string,
): void {
  const tracePath = join(memoryRoot, PATTERN_TRACE_PATH);
  const traceDir = join(memoryRoot, "reference", "patterns");

  // Ensure directory exists
  if (!existsSync(traceDir)) {
    mkdirSync(traceDir, { recursive: true });
  }

  // Load existing trace
  const existing = loadPatternTrace(memoryRoot);

  // Build a map keyed by pattern kind + description for deduplication
  const traceMap = new Map<string, PatternTraceEntry>();
  for (const entry of existing) {
    traceMap.set(`${entry.pattern.kind}|${entry.pattern.description}`, entry);
  }

  const now = new Date().toISOString();

  // Merge new patterns
  for (const pattern of newPatterns) {
    const key = `${pattern.kind}|${pattern.description}`;
    const existingEntry = traceMap.get(key);
    if (existingEntry) {
      // Update existing entry
      existingEntry.lastObserved = now;
      existingEntry.frequency += 1;
      existingEntry.evidence = pattern.evidence;
    } else {
      // New entry
      traceMap.set(key, {
        pattern,
        type: pattern.category as PatternTraceEntry["type"],
        evidence: pattern.evidence,
        firstObserved: now,
        lastObserved: now,
        frequency: 1,
      });
    }
  }

  // Prune entries not observed in 30 days
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const pruned = Array.from(traceMap.values()).filter((entry) => {
    return new Date(entry.lastObserved).getTime() >= thirtyDaysAgo;
  });

  // Write as markdown
  const lines: string[] = [
    "# Pattern Trace",
    "",
    `Last updated: ${now}`,
    "",
    "Persistent record of structural, distribution, and absence patterns.",
    "",
  ];

  for (const entry of pruned) {
    lines.push(`## ${entry.pattern.kind}`);
    lines.push(`- **Description**: ${entry.pattern.description}`);
    lines.push(`- **Type**: ${entry.type}`);
    lines.push(`- **First observed**: ${entry.firstObserved}`);
    lines.push(`- **Last observed**: ${entry.lastObserved}`);
    lines.push(`- **Frequency**: ${entry.frequency}`);
    lines.push(`- **Confidence**: ${entry.pattern.confidence}`);
    lines.push(`- **Evidence**: ${entry.evidence.join("; ")}`);
    lines.push("");
  }

  writeFileSync(tracePath, lines.join("\n"), "utf-8");
}

/**
 * Load pattern trace entries from the persistent trace file.
 */
function loadPatternTrace(memoryRoot: string): PatternTraceEntry[] {
  const tracePath = join(memoryRoot, PATTERN_TRACE_PATH);
  if (!existsSync(tracePath)) return [];

  try {
    const content = readFileSync(tracePath, "utf-8");
    // Parse the markdown trace file back into structured entries
    const entries: PatternTraceEntry[] = [];
    const sections = content.split(/^## /m).slice(1); // Skip the header

    for (const section of sections) {
      const lines = section.split("\n");
      const kind = lines[0]?.trim() || "";
      const description =
        section.match(/\*\*Description\*\*:\s*(.+)/)?.[1]?.trim() || "";
      const type = section.match(/\*\*Type\*\*:\s*(.+)/)?.[1]?.trim() as
        | PatternTraceEntry["type"]
        | undefined;
      const firstObserved =
        section.match(/\*\*First observed\*\*:\s*(.+)/)?.[1]?.trim() || "";
      const lastObserved =
        section.match(/\*\*Last observed\*\*:\s*(.+)/)?.[1]?.trim() || "";
      const frequency = parseInt(
        section.match(/\*\*Frequency\*\*:\s*(\d+)/)?.[1] || "1",
        10,
      );
      const confidence = parseFloat(
        section.match(/\*\*Confidence\*\*:\s*([\d.]+)/)?.[1] || "0.5",
      );
      const evidenceStr =
        section.match(/\*\*Evidence\*\*:\s*(.+)/)?.[1]?.trim() || "";
      const evidence = evidenceStr
        ? evidenceStr.split("; ").filter(Boolean)
        : [];

      if (kind && description && type) {
        entries.push({
          pattern: {
            kind: kind as DetectedPattern["kind"],
            description,
            evidence,
            confidence,
            category: type,
          },
          type,
          evidence,
          firstObserved,
          lastObserved,
          frequency,
        });
      }
    }

    return entries;
  } catch {
    return [];
  }
}

// ============================================================================
// Proposal Generation
// ============================================================================

/**
 * A proposal from the reflection loop.
 */
export interface ReflectionProposal {
  /** Unique ID */
  id: string;
  /** When this proposal was generated */
  createdAt: string;
  /** The pattern that triggered this proposal */
  pattern: DetectedPattern;
  /** What kind of action is proposed */
  action:
    | "promote_memory" // Increase importance of a memory
    | "archive_memory" // Move a cold/stale memory to archive
    | "consolidate_memories" // Merge similar memories
    | "add_memory" // Create a new memory from observed pattern
    | "update_eim" // Suggest EIM configuration change
    | "adjust_classifier" // Suggest classifier threshold change
    | "flag_for_review"; // Flag something for human attention
  /** Human-readable description of the proposal */
  description: string;
  /** Specific changes proposed (action-dependent) */
  changes: Record<string, unknown>;
  /** Confidence in the proposal (0-1) */
  confidence: number;
  /** Review status */
  reviewStatus: "pending" | "approved" | "rejected" | "expired";
  /** Reason for the proposal */
  reason: string;
}

let proposalCounter = 0;

/**
 * Generate proposals from detected patterns.
 */
export function generateProposals(
  patterns: DetectedPattern[],
): ReflectionProposal[] {
  const proposals: ReflectionProposal[] = [];

  for (const pattern of patterns) {
    switch (pattern.kind) {
      case "memory_hot": {
        // Hot memories should be promoted to higher importance
        const memoryId = pattern.evidence[0]?.replace("ID: ", "");
        proposals.push({
          id: `proposal-${++proposalCounter}-${Date.now()}`,
          createdAt: new Date().toISOString(),
          pattern,
          action: "promote_memory",
          description: `Promote frequently-accessed memory to higher importance`,
          changes: {
            memoryId,
            newImportance: "high",
          },
          confidence: pattern.confidence,
          reviewStatus: "pending",
          reason: `Memory accessed ${pattern.evidence[2]?.replace("Access count: ", "") || "many"} times — likely important for continuity`,
        });
        break;
      }

      case "memory_cold":
      case "memory_stale": {
        // Cold/stale memories should be archived
        const memoryId = pattern.evidence[0]?.replace("ID: ", "");
        proposals.push({
          id: `proposal-${++proposalCounter}-${Date.now()}`,
          createdAt: new Date().toISOString(),
          pattern,
          action: "archive_memory",
          description: `Archive ${pattern.kind === "memory_cold" ? "never-accessed" : "stale"} memory`,
          changes: {
            memoryId,
            action: "archive",
          },
          confidence: pattern.confidence,
          reviewStatus: "pending",
          reason: pattern.description,
        });
        break;
      }

      case "mode_oscillation": {
        // Suggest EIM mode override for the oscillating mode pair
        proposals.push({
          id: `proposal-${++proposalCounter}-${Date.now()}`,
          createdAt: new Date().toISOString(),
          pattern,
          action: "update_eim",
          description: `Consider adding mode override for oscillating mode transition`,
          changes: {
            transition: pattern.evidence[0],
            suggestion:
              "Add modeOverride in EIM config to stabilize this transition",
          },
          confidence: pattern.confidence * 0.8,
          reviewStatus: "pending",
          reason: pattern.description,
        });
        break;
      }

      case "frequent_tool": {
        // Frequent tool usage might indicate a workflow pattern
        proposals.push({
          id: `proposal-${++proposalCounter}-${Date.now()}`,
          createdAt: new Date().toISOString(),
          pattern,
          action: "add_memory",
          description: `Create procedural memory for frequent tool workflow`,
          changes: {
            type: "procedural",
            content: pattern.description,
          },
          confidence: pattern.confidence * 0.6,
          reviewStatus: "pending",
          reason: `Frequent tool usage suggests a repeatable workflow worth remembering`,
        });
        break;
      }

      case "preference_repeated": {
        // Low scores suggest classifier needs adjustment
        proposals.push({
          id: `proposal-${++proposalCounter}-${Date.now()}`,
          createdAt: new Date().toISOString(),
          pattern,
          action: "adjust_classifier",
          description: `Review classifier thresholds — many candidates scoring below 0.5`,
          changes: {
            suggestion:
              "Consider lowering auto-store threshold or adding keyword patterns",
            evidence: pattern.evidence,
          },
          confidence: pattern.confidence,
          reviewStatus: "pending",
          reason: pattern.description,
        });
        break;
      }

      case "structural_correlation":
      case "distribution_imbalance":
      case "absence_pattern": {
        // Structural/distribution/absence patterns are observations, not corrections
        proposals.push({
          id: `proposal-${++proposalCounter}-${Date.now()}`,
          createdAt: new Date().toISOString(),
          pattern,
          action: "flag_for_review",
          description: pattern.description,
          changes: {
            category: pattern.category,
            kind: pattern.kind,
          },
          confidence: pattern.confidence * 0.4,
          reviewStatus: "pending",
          reason: `Observation (${pattern.category}): ${pattern.description}`,
        });
        break;
      }

      default: {
        // Generic flag for review
        proposals.push({
          id: `proposal-${++proposalCounter}-${Date.now()}`,
          createdAt: new Date().toISOString(),
          pattern,
          action: "flag_for_review",
          description: pattern.description,
          changes: {},
          confidence: pattern.confidence * 0.5,
          reviewStatus: "pending",
          reason: pattern.description,
        });
      }
    }
  }

  return proposals;
}

// ============================================================================
// Reflection Execution
// ============================================================================

/**
 * Result of a reflection cycle.
 */
export interface ReflectionResult {
  /** Patterns detected */
  patterns: DetectedPattern[];
  /** Proposals generated */
  proposals: ReflectionProposal[];
  /** Whether the reflection cycle ran */
  ran: boolean;
  /** Reason if it didn't run */
  skippedReason?: string;
  /** Open loops detected */
  openLoops: OpenLoop[];
}

/**
 * Run a reflection cycle.
 *
 * This is the main entry point. It:
 * 1. Reads the audit log and recent events
 * 2. Loads current memories
 * 3. Detects patterns
 * 4. Generates proposals
 * 5. Writes proposals to the review queue
 */
export function runReflectionCycle(input: ReflectionInput): ReflectionResult {
  const memoryRoot = getMemoryFilesystemRoot(input.agentId);

  // Throttle: only run every N turns
  if (input.turnsSinceLastReflection < 5) {
    return {
      patterns: [],
      proposals: [],
      ran: false,
      skippedReason: `Only ${input.turnsSinceLastReflection} turns since last reflection (minimum 5)`,
      openLoops: [],
    };
  }

  // Read audit log
  const auditPath = join(memoryRoot, "system/memory-audit.log");
  const auditEntries: AuditLogEntry[] = [];
  if (existsSync(auditPath)) {
    const content = readFileSync(auditPath, "utf-8");
    for (const line of content.split("\n")) {
      if (line.trim()) {
        try {
          auditEntries.push(JSON.parse(line));
        } catch {
          // Skip malformed lines
        }
      }
    }
  }

  // Load current memories
  const index = loadMemoryIndex(memoryRoot);
  const memories: MemoryEntry[] = [];
  if (index) {
    for (const entries of Object.values(index.byType)) {
      for (const entry of entries) {
        const fullPath = join(memoryRoot, entry.path);
        if (existsSync(fullPath)) {
          const content = readFileSync(fullPath, "utf-8");
          const parsed = parseMemoryEntry(content, entry.path);
          if (parsed) memories.push(parsed);
        }
      }
    }
  }

  // Detect patterns
  const patterns = detectPatterns(
    input.turnEvents,
    auditEntries,
    memories,
    input.currentTaskKind,
  );

  // Generate proposals
  const proposals = generateProposals(patterns);

  // Write proposals to review queue
  if (proposals.length > 0) {
    writeProposalsToQueue(proposals, memoryRoot);
  }

  // Write pattern trace (structural/distribution/absence observations)
  const tracePatterns = patterns.filter(
    (p) =>
      p.category === "structural" ||
      p.category === "distribution" ||
      p.category === "absence",
  );
  if (tracePatterns.length > 0) {
    writePatternTrace(tracePatterns, memoryRoot);
  }

  // Detect open loops — threads that were alive and then stopped
  const openLoopInput: OpenLoopDetectionInput = {
    turnEvents: input.turnEvents,
    auditEntries:
      auditEntries as unknown as OpenLoopDetectionInput["auditEntries"],
    memories,
  };
  const openLoops = detectOpenLoops(openLoopInput);
  if (openLoops.length > 0) {
    writeOpenLoops(openLoops, memoryRoot);
  }

  return {
    patterns,
    proposals,
    ran: true,
    openLoops,
  };
}

// ============================================================================
// Review Queue
// ============================================================================

const REVIEW_QUEUE_PATH = "system/review-queue.json";

/**
 * Write proposals to the review queue file.
 */
function writeProposalsToQueue(
  proposals: ReflectionProposal[],
  memoryRoot: string,
): void {
  const queuePath = join(memoryRoot, REVIEW_QUEUE_PATH);

  // Load existing queue
  let existing: ReflectionProposal[] = [];
  if (existsSync(queuePath)) {
    try {
      const content = readFileSync(queuePath, "utf-8");
      existing = JSON.parse(content);
    } catch {
      existing = [];
    }
  }

  // Append new proposals (avoid duplicates by ID)
  const existingIds = new Set(existing.map((p) => p.id));
  const newProposals = proposals.filter((p) => !existingIds.has(p.id));

  const merged = [...existing, ...newProposals];

  writeFileSync(queuePath, JSON.stringify(merged, null, 2), "utf-8");
}

/**
 * Load the current review queue.
 */
export function loadReviewQueue(memoryRoot: string): ReflectionProposal[] {
  const queuePath = join(memoryRoot, REVIEW_QUEUE_PATH);
  if (!existsSync(queuePath)) return [];

  try {
    const content = readFileSync(queuePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}

/**
 * Approve a proposal from the review queue.
 */
export function approveProposal(
  proposalId: string,
  memoryRoot: string,
): { success: boolean; appliedAction?: string; error?: string } {
  const queue = loadReviewQueue(memoryRoot);
  const proposal = queue.find((p) => p.id === proposalId);

  if (!proposal) {
    return { success: false, error: `Proposal ${proposalId} not found` };
  }

  if (proposal.reviewStatus !== "pending") {
    return {
      success: false,
      error: `Proposal is ${proposal.reviewStatus}, not pending`,
    };
  }

  // Mark as approved
  proposal.reviewStatus = "approved";

  // Apply the proposal
  const appliedAction = applyProposal(proposal, memoryRoot);

  // Save updated queue
  const queuePath = join(memoryRoot, REVIEW_QUEUE_PATH);
  writeFileSync(queuePath, JSON.stringify(queue, null, 2), "utf-8");

  return { success: true, appliedAction };
}

/**
 * Reject a proposal from the review queue.
 */
export function rejectProposal(
  proposalId: string,
  memoryRoot: string,
): { success: boolean; error?: string } {
  const queue = loadReviewQueue(memoryRoot);
  const proposal = queue.find((p) => p.id === proposalId);

  if (!proposal) {
    return { success: false, error: `Proposal ${proposalId} not found` };
  }

  proposal.reviewStatus = "rejected";
  const queuePath = join(memoryRoot, REVIEW_QUEUE_PATH);
  writeFileSync(queuePath, JSON.stringify(queue, null, 2), "utf-8");

  return { success: true };
}

// ============================================================================
// Proposal Application
// ============================================================================

/**
 * Apply an approved proposal. Returns a description of what was done.
 */
function applyProposal(
  proposal: ReflectionProposal,
  memoryRoot: string,
): string {
  switch (proposal.action) {
    case "promote_memory": {
      const memoryId = proposal.changes.memoryId as string;
      const newImportance =
        (proposal.changes.newImportance as string) || "high";
      // Find and update the memory file
      const index = loadMemoryIndex(memoryRoot);
      if (index) {
        for (const entries of Object.values(index.byType)) {
          const entry = entries.find((e) => e.id === memoryId);
          if (entry) {
            const fullPath = join(memoryRoot, entry.path);
            if (existsSync(fullPath)) {
              const content = readFileSync(fullPath, "utf-8");
              const updated = content.replace(
                /importance: \w+/,
                `importance: ${newImportance}`,
              );
              writeFileSync(fullPath, updated, "utf-8");
              return `Promoted memory ${memoryId} to ${newImportance} importance`;
            }
          }
        }
      }
      return `Could not find memory ${memoryId} to promote`;
    }

    case "archive_memory": {
      const memoryId = proposal.changes.memoryId as string;
      // For now, just mark as low importance — full archival is a future step
      const index = loadMemoryIndex(memoryRoot);
      if (index) {
        for (const entries of Object.values(index.byType)) {
          const entry = entries.find((e) => e.id === memoryId);
          if (entry) {
            const fullPath = join(memoryRoot, entry.path);
            if (existsSync(fullPath)) {
              const content = readFileSync(fullPath, "utf-8");
              const updated = content
                .replace(/importance: \w+/, "importance: low")
                .replace(/reviewStatus: \w+/, "reviewStatus: approved");
              writeFileSync(fullPath, updated, "utf-8");
              return `Archived memory ${memoryId} (set to low importance)`;
            }
          }
        }
      }
      return `Could not find memory ${memoryId} to archive`;
    }

    case "add_memory": {
      // This would create a new memory file — for now, just log it
      return `Memory creation proposal noted: ${proposal.description}`;
    }

    case "update_eim": {
      // EIM updates require human review — just flag
      return `EIM update proposal noted: ${proposal.description}`;
    }

    case "adjust_classifier": {
      // Classifier adjustments require human review
      return `Classifier adjustment proposal noted: ${proposal.description}`;
    }

    default:
      return `Proposal action "${proposal.action}" applied`;
  }
}
