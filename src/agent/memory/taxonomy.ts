/**
 * Memory Taxonomy — typed memory classification for the agent runtime.
 *
 * The taxonomy defines memory types, directory conventions, and sensitivity levels.
 * Memory files are classified by type, which affects:
 * - Where they are stored (directory structure)
 * - How they are retrieved (priority by task kind)
 * - Whether they require review before storage (sensitivity)
 * - How long they are retained (importance/lifecycle)
 */

// ============================================================================
// Memory Types
// ============================================================================

/**
 * The six core memory types in the taxonomy.
 *
 * Each type has distinct storage patterns, retrieval priorities,
 * and lifecycle characteristics.
 */
export type MemoryType =
  | "episodic" // Events, interactions, experiences (time-bound)
  | "semantic" // Facts, concepts, definitions (timeless)
  | "procedural" // How-to, processes, patterns (action-oriented)
  | "relationship" // User traits, preferences, rapport (person-oriented)
  | "project" // Project state, architecture, decisions (work-oriented)
  | "reflective"; // Self-observations, corrections, insights (meta)

/**
 * All known memory type values for validation.
 */
export const MEMORY_TYPES: readonly MemoryType[] = [
  "episodic",
  "semantic",
  "procedural",
  "relationship",
  "project",
  "reflective",
];

/**
 * Check if a string is a valid memory type.
 */
export function isMemoryType(value: string): value is MemoryType {
  return MEMORY_TYPES.includes(value as MemoryType);
}

// ============================================================================
// Sensitivity Levels
// ============================================================================

/**
 * Sensitivity classification for memory entries.
 *
 * Determines whether automatic storage is allowed or human review is required.
 */
export type MemorySensitivity =
  | "public" // Safe for automatic storage, no review needed
  | "sensitive" // Contains user preferences/personal info, review recommended
  | "private"; // Requires explicit user consent before storage

export const MEMORY_SENSITIVITIES: readonly MemorySensitivity[] = [
  "public",
  "sensitive",
  "private",
];

export function isMemorySensitivity(value: string): value is MemorySensitivity {
  return MEMORY_SENSITIVITIES.includes(value as MemorySensitivity);
}

// ============================================================================
// Importance Levels
// ============================================================================

/**
 * Importance classification for memory retention.
 *
 * Affects how long memories are retained and whether they're candidates
 * for consolidation or archival.
 */
export type MemoryImportance =
  | "critical" // Always retain, never archive (identity-critical)
  | "high" // Retain indefinitely, archive only when explicitly superseded
  | "medium" // Retain for extended period, consolidate when dormant
  | "low"; // Retain for limited period, archive when dormant

export const MEMORY_IMPORTANCES: readonly MemoryImportance[] = [
  "critical",
  "high",
  "medium",
  "low",
];

export function isMemoryImportance(value: string): value is MemoryImportance {
  return MEMORY_IMPORTANCES.includes(value as MemoryImportance);
}

// ============================================================================
// Directory Conventions
// ============================================================================

/**
 * Directory where each memory type is stored.
 *
 * This convention is used by the memory tool to route new memories
 * to the appropriate location based on type.
 */
export const MEMORY_TYPE_DIRECTORIES: Record<MemoryType, string> = {
  episodic: "episodes",
  semantic: "knowledge",
  procedural: "procedures",
  relationship: "relationship",
  project: "projects",
  reflective: "reflection",
};

/**
 * Reverse mapping: directory name → memory type.
 */
export const DIRECTORY_TO_MEMORY_TYPE: Record<string, MemoryType> = {
  episodes: "episodic",
  knowledge: "semantic",
  procedures: "procedural",
  relationship: "relationship",
  projects: "project",
  reflection: "reflective",
};

/**
 * Get the storage directory for a memory type.
 */
export function getMemoryTypeDirectory(type: MemoryType): string {
  return MEMORY_TYPE_DIRECTORIES[type];
}

/**
 * Infer memory type from a file path.
 * Returns undefined if the path doesn't match a known type directory.
 */
export function inferMemoryTypeFromPath(
  filePath: string,
): MemoryType | undefined {
  const segments = filePath.split(/[/\\]/);
  for (const segment of segments) {
    if (segment in DIRECTORY_TO_MEMORY_TYPE) {
      return DIRECTORY_TO_MEMORY_TYPE[segment];
    }
  }
  return undefined;
}

// ============================================================================
// Type Descriptions (for classifier prompt)
// ============================================================================

/**
 * Human-readable descriptions of each memory type.
 * Used by the classifier to determine which type a memory candidate belongs to.
 */
export const MEMORY_TYPE_DESCRIPTIONS: Record<MemoryType, string> = {
  episodic:
    "Events, interactions, or experiences that occurred at a specific time. First-person recollections of what happened, when, and in what context. Example: 'On 2024-01-15, the user mentioned they were switching jobs.'",
  semantic:
    "Facts, concepts, definitions, or knowledge that is not tied to a specific time. General truths about the world, domains, or topics. Example: 'The user prefers TypeScript over JavaScript for type safety.'",
  procedural:
    "How-to knowledge, processes, patterns, or sequences of actions. Step-by-step instructions or workflows. Example: 'To deploy the project: run bun run build, then push to main branch.'",
  relationship:
    "User traits, preferences, communication style, or rapport-building details. Information about the user as a person. Example: 'The user is detail-oriented and prefers thorough explanations with examples.'",
  project:
    "Project state, architecture, decisions, work-in-progress, or codebase-specific knowledge. Information tied to a specific project or workspace. Example: 'The letta-code-DE fork uses EIM for structured identity.'",
  reflective:
    "Self-observations, corrections, insights, or meta-knowledge about the agent's own behavior. Lessons learned from past interactions. Example: 'I should ask about preferences before making assumptions about coding style.'",
};

// ============================================================================
// Retrieval Priority by Task Kind
// ============================================================================

/**
 * Which memory types to prioritize for each task kind.
 * Used by the context compiler when assembling retrieved memories.
 */
export const TASK_MEMORY_PRIORITY: Record<string, MemoryType[]> = {
  casual: ["relationship", "semantic", "episodic"],
  coding: ["project", "procedural", "semantic"],
  research: ["semantic", "episodic", "project"],
  design: ["project", "relationship", "semantic"],
  creative: ["relationship", "episodic", "reflective"],
  reflection: ["reflective", "episodic", "semantic"],
  governance: ["semantic", "procedural"],
};

// ============================================================================
// Default Settings by Type
// ============================================================================

/**
 * Default sensitivity for each memory type.
 */
export const DEFAULT_SENSITIVITY_BY_TYPE: Record<
  MemoryType,
  MemorySensitivity
> = {
  episodic: "public",
  semantic: "public",
  procedural: "public",
  relationship: "sensitive",
  project: "public",
  reflective: "sensitive",
};

/**
 * Default importance for each memory type.
 */
export const DEFAULT_IMPORTANCE_BY_TYPE: Record<MemoryType, MemoryImportance> =
  {
    episodic: "medium",
    semantic: "high",
    procedural: "high",
    relationship: "high",
    project: "high",
    reflective: "critical",
  };
