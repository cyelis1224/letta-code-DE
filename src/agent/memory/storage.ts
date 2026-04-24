/**
 * Memory Storage — persist pipeline results to the continuity core.
 *
 * This module bridges the memory pipeline to the continuity schema:
 * - Takes scored candidates from the pipeline
 * - Converts them to MemoryEntry format
 * - Writes them to the appropriate type directory
 * - Updates the memory index
 *
 * It also provides the retrieval hook for the context compiler
 * to load relevant memories before each turn.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskKind } from "../eim/types";
import { getMemoryFilesystemRoot } from "../memoryFilesystem";
import type { MemoryEntry, MemoryEntryFrontmatter } from "./continuity-schema";
import { buildMemoryPath, serializeMemoryEntry } from "./continuity-schema";
import type { PipelineResult } from "./pipeline";
import { queryMemories, rebuildMemoryIndex } from "./retrieval";
import type { MemoryImportance, MemorySensitivity } from "./taxonomy";
import {
  DEFAULT_IMPORTANCE_BY_TYPE,
  MEMORY_TYPE_DIRECTORIES,
} from "./taxonomy";

// ============================================================================
// Storage Configuration
// ============================================================================

export interface StorageConfig {
  /** Minimum score to auto-store (bypass review) */
  autoStoreThreshold: number;
  /** Maximum sensitivity to auto-store */
  maxAutoStoreSensitivity: MemorySensitivity;
  /** Whether to update the index after each store */
  updateIndexOnStore: boolean;
  /** Path to the memory filesystem root */
  memoryRoot?: string;
}

export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  autoStoreThreshold: 0.6,
  maxAutoStoreSensitivity: "public",
  updateIndexOnStore: true,
};

// ============================================================================
// Store Pipeline Results
// ============================================================================

/**
 * Result of storing pipeline results.
 */
export interface StorageResult {
  /** Successfully stored entries */
  stored: MemoryEntry[];
  /** Entries queued for review */
  pending: MemoryEntry[];
  /** Entries rejected (score too low) */
  rejected: Array<{ result: PipelineResult; reason: string }>;
  /** Errors encountered */
  errors: Array<{ result: PipelineResult; error: Error }>;
}

/**
 * Store pipeline results to the continuity core.
 *
 * This is the main entry point for the post-turn hook.
 * It takes scored candidates and persists them according to
 * their score, sensitivity, and the storage config.
 */
export function storePipelineResults(
  results: PipelineResult[],
  config: StorageConfig = DEFAULT_STORAGE_CONFIG,
  agentId: string,
  conversationId?: string,
  turnNumber?: number,
): StorageResult {
  const memoryRoot = config.memoryRoot || getMemoryFilesystemRoot(agentId);
  const output: StorageResult = {
    stored: [],
    pending: [],
    rejected: [],
    errors: [],
  };

  for (const result of results) {
    try {
      // Check score threshold
      if (result.scoring.score < config.autoStoreThreshold) {
        output.rejected.push({
          result,
          reason: `Score ${result.scoring.score.toFixed(2)} below threshold ${config.autoStoreThreshold}`,
        });
        continue;
      }

      // Check sensitivity for auto-store
      const sensitivity = result.classification.sensitivity;
      const autoStoreAllowed =
        sensitivity === "public" ||
        (config.maxAutoStoreSensitivity === "sensitive" &&
          sensitivity !== "private");

      // Build the memory entry
      const entry = pipelineResultToEntry(
        result,
        agentId,
        conversationId,
        turnNumber,
        autoStoreAllowed ? "auto" : "pending",
      );

      // Ensure directory exists
      const filePath = buildMemoryPath(entry.frontmatter, memoryRoot);
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Write the file
      const content = serializeMemoryEntry(entry);
      writeFileSync(filePath, content, "utf-8");

      // Track result
      if (autoStoreAllowed) {
        output.stored.push(entry);
      } else {
        output.pending.push(entry);
      }

      // Log to audit
      appendToAuditLog(result, entry, memoryRoot);
    } catch (err) {
      output.errors.push({
        result,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  // Update index if configured
  if (config.updateIndexOnStore && output.stored.length > 0) {
    rebuildMemoryIndex(memoryRoot);
  }

  return output;
}

// ============================================================================
// Conversion Helpers
// ============================================================================

/**
 * Convert a pipeline result to a memory entry.
 */
function pipelineResultToEntry(
  result: PipelineResult,
  _agentId: string,
  conversationId?: string,
  turnNumber?: number,
  reviewStatus: MemoryEntryFrontmatter["reviewStatus"] = "auto",
): MemoryEntry {
  const now = new Date().toISOString();
  const id = result.candidate.id || randomUUID();

  const frontmatter: MemoryEntryFrontmatter = {
    id,
    type: result.classification.type,
    sensitivity: result.classification.sensitivity,
    importance: classifyImportance(result),
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    source: result.candidate.source,
    conversationId,
    turnNumber,
    storedScore: result.scoring.score,
    reviewStatus,
    tags: [],
    projects: inferProjects(result),
  };

  return {
    frontmatter,
    content: result.candidate.content,
    path: `${MEMORY_TYPE_DIRECTORIES[result.classification.type] || result.classification.type}/${id}.md`,
  };
}

/**
 * Determine importance from pipeline result.
 */
function classifyImportance(result: PipelineResult): MemoryImportance {
  // High score + high utility = critical
  if (result.scoring.score >= 0.9 && result.scoring.factors.utility >= 0.8) {
    return "critical";
  }

  // Good score + relationship/project type = high
  if (
    result.scoring.score >= 0.7 &&
    (result.classification.type === "relationship" ||
      result.classification.type === "project" ||
      result.classification.type === "reflective")
  ) {
    return "high";
  }

  // Default by type
  return DEFAULT_IMPORTANCE_BY_TYPE[result.classification.type];
}

/**
 * Infer project tags from candidate content.
 */
function inferProjects(_result: PipelineResult): string[] | undefined {
  // TODO: Extract project references from content
  // For now, return undefined - this can be enhanced later
  return undefined;
}

// ============================================================================
// Audit Logging
// ============================================================================

const AUDIT_LOG_PATH = "system/memory-audit.log";

/**
 * Append a storage event to the audit log.
 */
function appendToAuditLog(
  result: PipelineResult,
  entry: MemoryEntry,
  memoryRoot: string,
): void {
  const logPath = join(memoryRoot, AUDIT_LOG_PATH);
  const logDir = dirname(logPath);

  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    action: "store",
    memoryId: entry.frontmatter.id,
    type: entry.frontmatter.type,
    score: result.scoring.score,
    source: entry.frontmatter.source,
    preview: entry.content.slice(0, 100),
  };

  appendFileSync(logPath, `${JSON.stringify(logEntry)}\n`, "utf-8");
}

// ============================================================================
// Retrieval Hook for Context Compiler
// ============================================================================

/**
 * Retrieve memories relevant to the current turn.
 *
 * This is called by the context compiler to load memories
 * before assembling the prompt.
 */
export function retrieveMemoriesForTurn(
  taskKind: TaskKind,
  agentId: string,
  options?: {
    project?: string;
    limit?: number;
    searchText?: string;
  },
): MemoryEntry[] {
  const memoryRoot = getMemoryFilesystemRoot(agentId);

  const result = queryMemories(
    {
      types: undefined, // Use task-based priority
      project: options?.project,
      limit: options?.limit || 10,
      includeContent: true,
      searchText: options?.searchText,
    },
    memoryRoot,
    taskKind,
  );

  // Update access counts for retrieved memories
  for (const memory of result.memories) {
    incrementAccessCount(memory, memoryRoot);
  }

  return result.memories;
}

/**
 * Increment the access count for a memory.
 */
function incrementAccessCount(memory: MemoryEntry, memoryRoot: string): void {
  memory.frontmatter.accessCount++;
  memory.frontmatter.lastAccessedAt = new Date().toISOString();

  const filePath = join(memoryRoot, memory.path);
  if (existsSync(filePath)) {
    const content = serializeMemoryEntry(memory);
    writeFileSync(filePath, content, "utf-8");
  }
}
