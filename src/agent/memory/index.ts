/**
 * Memory module — typed memory taxonomy for the agent runtime.
 *
 * This module provides:
 * - Memory type classification (episodic, semantic, procedural, relationship, project, reflective)
 * - Sensitivity and importance levels
 * - Directory conventions for each type
 * - Frontmatter schema and parsing
 * - Classification (heuristic and LLM-based)
 */

export type {
  ClassificationResult,
  MemoryCandidate,
} from "./classifier";
export {
  buildClassificationPrompt,
  heuristicClassifyMemory,
  parseLLMClassificationOutput,
} from "./classifier";

export type {
  LegacyMemoryMetadata,
  MemoryMetadata,
} from "./schema";

export {
  createMemoryFile,
  parseMemoryFrontmatter,
  parseMemoryMetadata,
  serializeMemoryFrontmatter,
  validateMemoryFrontmatter,
} from "./schema";
export type {
  MemoryImportance,
  MemorySensitivity,
  MemoryType,
} from "./taxonomy";
export {
  DEFAULT_IMPORTANCE_BY_TYPE,
  DEFAULT_SENSITIVITY_BY_TYPE,
  DIRECTORY_TO_MEMORY_TYPE,
  getMemoryTypeDirectory,
  inferMemoryTypeFromPath,
  isMemoryImportance,
  isMemorySensitivity,
  isMemoryType,
  MEMORY_IMPORTANCES,
  MEMORY_SENSITIVITIES,
  MEMORY_TYPE_DESCRIPTIONS,
  MEMORY_TYPE_DIRECTORIES,
  MEMORY_TYPES,
  TASK_MEMORY_PRIORITY,
} from "./taxonomy";
