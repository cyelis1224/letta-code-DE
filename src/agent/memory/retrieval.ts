/**
 * Memory Retrieval Engine — query and rank stored memories.
 *
 * This module provides the retrieval API used by the context compiler
 * to load relevant memories before each turn. It:
 *
 * 1. Queries the memory index by type, tag, project, or text search
 * 2. Ranks results by relevance (recency, access count, importance, task priority)
 * 3. Loads full content for top candidates
 * 4. Returns scored memories ready for injection
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskKind } from "../eim/types";
import { getMemoryFilesystemRoot } from "../memoryFilesystem";
import type {
  MemoryEntry,
  MemoryIndex,
  MemoryIndexEntry,
  MemoryQuery,
  MemoryQueryResult,
  RetrievedMemory,
} from "./continuity-schema";
import {
  MEMORY_TYPE_DIRECTORIES,
  type MemoryType,
  TASK_MEMORY_PRIORITY,
} from "./taxonomy";

// ============================================================================
// Index Management
// ============================================================================

const INDEX_PATH = "system/continuity-index.json";

/**
 * Load the memory index from disk, or return null if not found.
 */
export function loadMemoryIndex(memoryRoot: string): MemoryIndex | null {
  const indexPath = join(memoryRoot, INDEX_PATH);
  if (!existsSync(indexPath)) return null;

  try {
    const content = readFileSync(indexPath, "utf-8");
    return JSON.parse(content) as MemoryIndex;
  } catch {
    return null;
  }
}

/**
 * Rebuild the memory index by scanning all memory files.
 */
export function rebuildMemoryIndex(memoryRoot: string): MemoryIndex {
  const index: MemoryIndex = {
    schemaVersion: 1,
    lastRebuiltAt: new Date().toISOString(),
    totalEntries: 0,
    byType: {
      episodic: [],
      semantic: [],
      procedural: [],
      relationship: [],
      project: [],
      reflective: [],
    },
    byRecency: [],
    byTag: {},
    byProject: {},
  };

  // Scan each type directory
  for (const type of Object.keys(index.byType)) {
    const dirName =
      MEMORY_TYPE_DIRECTORIES[type as keyof typeof MEMORY_TYPE_DIRECTORIES] ||
      type;
    const typeDir = join(memoryRoot, dirName);
    if (!existsSync(typeDir)) continue;

    const files = readdirSync(typeDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const filePath = join(typeDir, file);
      try {
        const content = readFileSync(filePath, "utf-8");
        const entry = parseMemoryFile(content, `${dirName}/${file}`);
        if (!entry) continue;

        const indexEntry: MemoryIndexEntry = {
          id: entry.frontmatter.id,
          type: entry.frontmatter.type,
          importance: entry.frontmatter.importance,
          createdAt: entry.frontmatter.createdAt,
          lastAccessedAt: entry.frontmatter.lastAccessedAt,
          accessCount: entry.frontmatter.accessCount,
          tags: entry.frontmatter.tags,
          preview: entry.content.slice(0, 200),
          path: entry.path,
        };

        index.byType[type as keyof typeof index.byType].push(indexEntry);
        index.byRecency.push(indexEntry);
        index.totalEntries++;

        // Index by tags
        for (const tag of entry.frontmatter.tags) {
          if (!index.byTag[tag]) index.byTag[tag] = [];
          index.byTag[tag].push(entry.frontmatter.id);
        }

        // Index by projects
        if (entry.frontmatter.projects) {
          for (const project of entry.frontmatter.projects) {
            if (!index.byProject[project]) index.byProject[project] = [];
            index.byProject[project].push(entry.frontmatter.id);
          }
        }
      } catch {
        // Skip malformed files
      }
    }
  }

  // Sort by recency
  index.byRecency.sort(
    (a, b) =>
      new Date(b.lastAccessedAt).getTime() -
      new Date(a.lastAccessedAt).getTime(),
  );

  return index;
}

// ============================================================================
// Query Execution
// ============================================================================

/**
 * Execute a memory query against the index.
 */
export function queryMemories(
  query: MemoryQuery,
  memoryRoot: string,
  taskKind?: TaskKind,
  eimTypePriority?: string[],
): MemoryQueryResult {
  const startTime = Date.now();

  // Load or rebuild index
  let index = loadMemoryIndex(memoryRoot);
  if (!index) {
    index = rebuildMemoryIndex(memoryRoot);
  }

  // Determine type priority: EIM override > task-based defaults
  const typePriority =
    eimTypePriority && eimTypePriority.length > 0
      ? eimTypePriority
      : taskKind
        ? TASK_MEMORY_PRIORITY[taskKind] || []
        : undefined;

  // Collect candidate entries
  let candidates: MemoryIndexEntry[] = [];

  if (query.types && query.types.length > 0) {
    // Filter by specified types
    for (const type of query.types) {
      candidates.push(...(index.byType[type] || []));
    }
  } else if (typePriority && typePriority.length > 0) {
    // Use task-based priority (from EIM or taxonomy defaults)
    for (const type of typePriority) {
      candidates.push(...(index.byType[type as MemoryType] || []));
    }
  } else {
    // All types, sorted by recency
    candidates = [...index.byRecency];
  }

  // Filter by tags
  if (query.tags && query.tags.length > 0) {
    const tagMatches = new Set<string>();
    for (const tag of query.tags) {
      const ids = index.byTag[tag] || [];
      for (const id of ids) tagMatches.add(id);
    }
    candidates = candidates.filter((c) => tagMatches.has(c.id));
  }

  // Filter by project
  if (query.project) {
    const projectIds = new Set(index.byProject[query.project] || []);
    candidates = candidates.filter((c) => projectIds.has(c.id));
  }

  // Filter by importance
  if (query.minImportance) {
    const importanceOrder = ["low", "medium", "high", "critical"];
    const minIdx = importanceOrder.indexOf(query.minImportance);
    candidates = candidates.filter(
      (c) => importanceOrder.indexOf(c.importance) >= minIdx,
    );
  }

  // Text search
  if (query.searchText) {
    const searchLower = query.searchText.toLowerCase();
    candidates = candidates.filter((c) =>
      c.preview.toLowerCase().includes(searchLower),
    );
  }

  // Score and rank
  const scored = candidates.map((entry) => ({
    entry,
    relevance: calculateRelevance(entry, query, typePriority),
  }));

  scored.sort((a, b) => b.relevance - a.relevance);

  // Apply limit
  const limit = query.limit || 10;
  const topCandidates = scored.slice(0, limit);

  // Load full content if requested
  const memories: RetrievedMemory[] = [];
  if (query.includeContent !== false) {
    for (const { entry, relevance } of topCandidates) {
      const fullEntry = loadMemoryEntry(entry.path, memoryRoot);
      if (fullEntry) {
        memories.push({
          ...fullEntry,
          relevance,
          matchReason: describeMatch(entry, query, typePriority),
        });
      }
    }
  }

  return {
    memories,
    totalMatching: candidates.length,
    queryTimeMs: Date.now() - startTime,
  };
}

// ============================================================================
// Scoring
// ============================================================================

/**
 * Calculate relevance score for an entry.
 */
function calculateRelevance(
  entry: MemoryIndexEntry,
  query: MemoryQuery,
  typePriority?: string[],
): number {
  let score = 0;

  // Recency (0-0.3)
  const ageMs = Date.now() - new Date(entry.lastAccessedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  score += Math.max(0, 0.3 - ageDays * 0.01);

  // Access count (0-0.2)
  score += Math.min(0.2, entry.accessCount * 0.02);

  // Importance (0-0.2)
  const importanceScores: Record<string, number> = {
    critical: 0.2,
    high: 0.15,
    medium: 0.1,
    low: 0.05,
  };
  score += importanceScores[entry.importance] || 0.1;

  // Type priority from task (0-0.3)
  if (typePriority) {
    const typeIdx = typePriority.indexOf(entry.type);
    if (typeIdx >= 0) {
      score += 0.3 - typeIdx * 0.1;
    }
  }

  // Tag matches (0-0.1)
  if (query.tags) {
    const tagMatches = query.tags.filter((t) => entry.tags.includes(t)).length;
    score += Math.min(0.1, tagMatches * 0.03);
  }

  return Math.min(1, score);
}

/**
 * Describe why a memory was retrieved.
 */
function describeMatch(
  entry: MemoryIndexEntry,
  query: MemoryQuery,
  typePriority?: string[],
): string {
  const reasons: string[] = [];

  if (typePriority && typePriority.includes(entry.type)) {
    reasons.push(`type priority for task`);
  }

  if (query.tags) {
    const matches = query.tags.filter((t) => entry.tags.includes(t));
    if (matches.length > 0) {
      reasons.push(`tags: ${matches.join(", ")}`);
    }
  }

  if (query.project && entry.tags.includes(query.project)) {
    reasons.push(`project: ${query.project}`);
  }

  if (entry.importance === "critical" || entry.importance === "high") {
    reasons.push(`high importance`);
  }

  if (entry.accessCount > 5) {
    reasons.push(`frequently accessed`);
  }

  const ageDays =
    (Date.now() - new Date(entry.lastAccessedAt).getTime()) /
    (1000 * 60 * 60 * 24);
  if (ageDays < 1) {
    reasons.push(`recent`);
  }

  return reasons.length > 0 ? reasons.join("; ") : "general relevance";
}

// ============================================================================
// Entry Loading
// ============================================================================

/**
 * Load a full memory entry from disk.
 */
function loadMemoryEntry(path: string, memoryRoot: string): MemoryEntry | null {
  const fullPath = join(memoryRoot, path);
  if (!existsSync(fullPath)) return null;

  try {
    const content = readFileSync(fullPath, "utf-8");
    return parseMemoryFile(content, path);
  } catch {
    return null;
  }
}

/**
 * Parse a memory file into an entry.
 */
function parseMemoryFile(content: string, path: string): MemoryEntry | null {
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
      if (value.startsWith("[") && value.endsWith("]")) {
        fm[key] = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""))
          .filter(Boolean);
      } else if (/^\d+$/.test(value)) {
        fm[key] = parseInt(value, 10);
      } else if (/^\d+\.\d+$/.test(value)) {
        fm[key] = parseFloat(value);
      } else {
        fm[key] = value;
      }
    }
  }

  return {
    frontmatter: {
      id: fm.id as string,
      type: fm.type as MemoryEntry["frontmatter"]["type"],
      sensitivity: fm.sensitivity as MemoryEntry["frontmatter"]["sensitivity"],
      importance: fm.importance as MemoryEntry["frontmatter"]["importance"],
      createdAt: fm.createdAt as string,
      lastAccessedAt: fm.lastAccessedAt as string,
      accessCount: (fm.accessCount as number) || 0,
      source: fm.source as MemoryEntry["frontmatter"]["source"],
      conversationId: fm.conversationId as string | undefined,
      turnNumber: fm.turnNumber as number | undefined,
      storedScore: (fm.storedScore as number) || 0,
      reviewStatus:
        fm.reviewStatus as MemoryEntry["frontmatter"]["reviewStatus"],
      tags: (fm.tags as string[]) || [],
      projects: fm.projects as string[] | undefined,
    },
    content: body.trim(),
    path,
  };
}
