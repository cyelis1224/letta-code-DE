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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, AgentEventType } from "../events/types";
import { getMemoryFilesystemRoot } from "../memoryFilesystem";
import type { MemoryEntry } from "./continuity-schema";
import { parseMemoryEntry } from "./continuity-schema";
import { loadMemoryIndex, queryMemories } from "./retrieval";
import type { MemoryType } from "./taxonomy";

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
    | "workflow"; // Detectable workflow pattern
  /** Description of the pattern */
  description: string;
  /** Evidence supporting this pattern */
  evidence: string[];
  /** Confidence in the detection (0-1) */
  confidence: number;
}

/**
 * Detect patterns from recent events.
 */
export function detectPatterns(
  events: AgentEvent[],
  auditEntries: AuditLogEntry[],
  memories: MemoryEntry[],
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
    });
  }

  return patterns;
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
  const patterns = detectPatterns(input.turnEvents, auditEntries, memories);

  // Generate proposals
  const proposals = generateProposals(patterns);

  // Write proposals to review queue
  if (proposals.length > 0) {
    writeProposalsToQueue(proposals, memoryRoot);
  }

  return {
    patterns,
    proposals,
    ran: true,
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
