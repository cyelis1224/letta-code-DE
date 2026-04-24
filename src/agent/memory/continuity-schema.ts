/**
 * Continuity Core Schema — the shape of what survives across sessions.
 *
 * This module defines:
 * - Memory entry format (frontmatter + body)
 * - Index structure for fast retrieval
 * - Query API for the context compiler
 * - Lifecycle rules (promotion, aging, consolidation)
 *
 * The continuity core is the persistent layer beneath Lantern Shell.
 * It stores scored memories from the pipeline and retrieves them
 * based on task kind, recency, and relevance.
 */

import type {
  MemoryImportance,
  MemorySensitivity,
  MemoryType,
} from "./taxonomy";
import { MEMORY_TYPE_DIRECTORIES } from "./taxonomy";

// ============================================================================
// Memory Entry Schema
// ============================================================================

/**
 * Frontmatter fields for a stored memory entry.
 *
 * Every memory file in the continuity core has this frontmatter
 * followed by a markdown body containing the actual content.
 */
export interface MemoryEntryFrontmatter {
  /** Unique ID (UUID) */
  id: string;
  /** Memory type (determines directory and retrieval priority) */
  type: MemoryType;
  /** Sensitivity level (affects auto-approval and access) */
  sensitivity: MemorySensitivity;
  /** Importance level (affects retention and lifecycle) */
  importance: MemoryImportance;
  /** When this memory was created (ISO timestamp) */
  createdAt: string;
  /** When this memory was last accessed or reinforced */
  lastAccessedAt: string;
  /** How many times this memory has been retrieved */
  accessCount: number;
  /** Source of the memory (conversation, reflection, manual) */
  source: "conversation" | "reflection" | "manual" | "import";
  /** Conversation ID where this memory originated */
  conversationId?: string;
  /** Turn number where this memory originated */
  turnNumber?: number;
  /** Pipeline score when this memory was stored */
  storedScore: number;
  /** Whether this memory was auto-approved or reviewed */
  reviewStatus: "auto" | "approved" | "pending" | "rejected";
  /** Tags for free-form categorization */
  tags: string[];
  /** Projects this memory is relevant to (for project-scoped retrieval) */
  projects?: string[];
  /** Whether this memory is eligible for open loop detection */
  loopEligible?: boolean;
  /** Intent to resume this thread (stronger signal for open loop detection) */
  intentToResume?: "possible" | "likely" | "unlikely";
}

/**
 * A complete memory entry (frontmatter + content).
 */
export interface MemoryEntry {
  frontmatter: MemoryEntryFrontmatter;
  content: string;
  /** File path relative to memory root */
  path: string;
}

// ============================================================================
// Index Schema
// ============================================================================

/**
 * Entry in the memory index.
 *
 * The index is a lightweight summary of all stored memories,
 * optimized for fast retrieval queries without loading full content.
 */
export interface MemoryIndexEntry {
  id: string;
  type: MemoryType;
  importance: MemoryImportance;
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  tags: string[];
  /** First 200 chars of content for preview/quick matching */
  preview: string;
  /** Path relative to memory root */
  path: string;
}

/**
 * The full memory index structure.
 *
 * Stored as `system/continuity-index.json` and rebuilt on startup
 * if the file is missing or stale.
 */
export interface MemoryIndex {
  /** Schema version for migration support */
  schemaVersion: 1;
  /** When the index was last rebuilt */
  lastRebuiltAt: string;
  /** Total number of memories */
  totalEntries: number;
  /** Entries organized by type for fast filtering */
  byType: Record<MemoryType, MemoryIndexEntry[]>;
  /** All entries sorted by lastAccessedAt (most recent first) */
  byRecency: MemoryIndexEntry[];
  /** Tag → entry IDs mapping */
  byTag: Record<string, string[]>;
  /** Project → entry IDs mapping */
  byProject: Record<string, string[]>;
}

// ============================================================================
// Retrieval API
// ============================================================================

/**
 * Parameters for querying memories.
 */
export interface MemoryQuery {
  /** Filter by memory type(s) */
  types?: MemoryType[];
  /** Filter by tags (any match) */
  tags?: string[];
  /** Filter by project */
  project?: string;
  /** Maximum number of results */
  limit?: number;
  /** Minimum importance level */
  minImportance?: MemoryImportance;
  /** Include content or just metadata */
  includeContent?: boolean;
  /** Text search in content */
  searchText?: string;
}

/**
 * A retrieved memory with relevance score.
 */
export interface RetrievedMemory extends MemoryEntry {
  /** Relevance score for this query (0-1) */
  relevance: number;
  /** Why this memory was retrieved */
  matchReason: string;
}

/**
 * Result of a memory query.
 */
export interface MemoryQueryResult {
  memories: RetrievedMemory[];
  /** Total matching before limit */
  totalMatching: number;
  /** Query execution time in ms */
  queryTimeMs: number;
}

// ============================================================================
// Lifecycle Rules
// ============================================================================

/**
 * Lifecycle configuration for memory management.
 */
export interface MemoryLifecycleConfig {
  /** How many accesses before a memory is promoted */
  promotionThreshold: number;
  /** Days without access before a memory is considered dormant */
  dormantAfterDays: number;
  /** Days dormant before a low-importance memory is archived */
  archiveAfterDays: number;
  /** Maximum memories per type before consolidation */
  maxPerType: number;
  /** Whether to auto-consolidate similar memories */
  autoConsolidate: boolean;
}

/**
 * Default lifecycle configuration.
 */
export const DEFAULT_LIFECYCLE_CONFIG: MemoryLifecycleConfig = {
  promotionThreshold: 5,
  dormantAfterDays: 30,
  archiveAfterDays: 90,
  maxPerType: 100,
  autoConsolidate: true,
};

/**
 * Lifecycle action to take on a memory.
 */
export type LifecycleAction =
  | "promote" // Increase importance
  | "dormant" // Mark as dormant (less likely to retrieve)
  | "archive" // Move to cold storage
  | "consolidate" // Merge with similar memory
  | "retain" // No action needed
  | "delete"; // Remove entirely

/**
 * Result of lifecycle evaluation.
 */
export interface LifecycleDecision {
  memoryId: string;
  action: LifecycleAction;
  reason: string;
  /** For consolidate: the target memory to merge with */
  consolidateTarget?: string;
}

// ============================================================================
// Storage Helpers
// ============================================================================

/**
 * File extension for memory entries.
 */
export const MEMORY_FILE_EXTENSION = ".md";

/**
 * Build a memory file path from its frontmatter.
 */
export function buildMemoryPath(
  frontmatter: MemoryEntryFrontmatter,
  memoryRoot: string,
): string {
  const typeDir = MEMORY_TYPE_DIRECTORIES[frontmatter.type] || frontmatter.type;
  const filename = `${frontmatter.id}${MEMORY_FILE_EXTENSION}`;
  return `${memoryRoot}/${typeDir}/${filename}`;
}

/**
 * Serialize a memory entry to markdown with frontmatter.
 */
export function serializeMemoryEntry(entry: MemoryEntry): string {
  const fm = entry.frontmatter;
  const frontmatterYaml = [
    `id: ${fm.id}`,
    `type: ${fm.type}`,
    `sensitivity: ${fm.sensitivity}`,
    `importance: ${fm.importance}`,
    `createdAt: ${fm.createdAt}`,
    `lastAccessedAt: ${fm.lastAccessedAt}`,
    `accessCount: ${fm.accessCount}`,
    `source: ${fm.source}`,
    fm.conversationId ? `conversationId: ${fm.conversationId}` : null,
    fm.turnNumber !== undefined ? `turnNumber: ${fm.turnNumber}` : null,
    `storedScore: ${fm.storedScore}`,
    `reviewStatus: ${fm.reviewStatus}`,
    `tags: [${fm.tags.map((t) => `"${t}"`).join(", ")}]`,
    fm.projects
      ? `projects: [${fm.projects.map((p) => `"${p}"`).join(", ")}]`
      : null,
    fm.loopEligible !== undefined ? `loopEligible: ${fm.loopEligible}` : null,
    fm.intentToResume ? `intentToResume: ${fm.intentToResume}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `---
${frontmatterYaml}
---

${entry.content}
`;
}

/**
 * Parse a memory entry from markdown with frontmatter.
 */
export function parseMemoryEntry(
  content: string,
  path: string,
): MemoryEntry | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const [, frontmatterText, body] = match;
  if (!frontmatterText || !body) return null;

  const fm: Record<string, unknown> = {};
  for (const line of frontmatterText.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      // Parse arrays
      if (value.startsWith("[") && value.endsWith("]")) {
        fm[key] = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""))
          .filter(Boolean);
      } else {
        fm[key] = value;
      }
    }
  }

  return {
    frontmatter: {
      id: fm.id as string,
      type: fm.type as MemoryType,
      sensitivity: fm.sensitivity as MemorySensitivity,
      importance: fm.importance as MemoryImportance,
      createdAt: fm.createdAt as string,
      lastAccessedAt: fm.lastAccessedAt as string,
      accessCount: parseInt(fm.accessCount as string, 10) || 0,
      source: fm.source as MemoryEntryFrontmatter["source"],
      conversationId: fm.conversationId as string | undefined,
      turnNumber: fm.turnNumber
        ? parseInt(fm.turnNumber as string, 10)
        : undefined,
      storedScore: parseFloat(fm.storedScore as string) || 0,
      reviewStatus: fm.reviewStatus as MemoryEntryFrontmatter["reviewStatus"],
      tags: (fm.tags as string[]) || [],
      projects: fm.projects as string[] | undefined,
      loopEligible: fm.loopEligible === "true",
      intentToResume:
        fm.intentToResume as MemoryEntryFrontmatter["intentToResume"],
    },
    content: body.trim(),
    path,
  };
}
