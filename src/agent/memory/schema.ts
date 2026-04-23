/**
 * Memory Schema — frontmatter structure and validation for typed memory files.
 *
 * Extends the existing memory tool's frontmatter (description) with
 * type, sensitivity, and importance fields.
 *
 * Example frontmatter:
 * ```yaml
 * ---
 * description: User prefers TypeScript for type safety
 * type: semantic
 * sensitivity: public
 * importance: high
 * created: 2024-01-15T10:30:00Z
 * updated: 2024-01-15T10:30:00Z
 * ---
 * ```
 */

import type {
  MemoryImportance,
  MemorySensitivity,
  MemoryType,
} from "./taxonomy";
import {
  DEFAULT_IMPORTANCE_BY_TYPE,
  DEFAULT_SENSITIVITY_BY_TYPE,
  inferMemoryTypeFromPath,
  isMemoryImportance,
  isMemorySensitivity,
  isMemoryType,
  MEMORY_IMPORTANCES,
  MEMORY_SENSITIVITIES,
  MEMORY_TYPES,
} from "./taxonomy";

// ============================================================================
// Memory Metadata Schema
// ============================================================================

/**
 * Full metadata for a typed memory file.
 *
 * All fields are optional during parsing (to support legacy files),
 * but type defaults to "semantic" if not specified.
 */
export interface MemoryMetadata {
  /** Human-readable description (required by existing memory tool) */
  description: string;
  /** Memory type classification */
  type: MemoryType;
  /** Sensitivity level (affects review requirements) */
  sensitivity: MemorySensitivity;
  /** Importance level (affects retention) */
  importance: MemoryImportance;
  /** When this memory was created (ISO timestamp) */
  created?: string;
  /** When this memory was last updated (ISO timestamp) */
  updated?: string;
  /** Additional metadata (for extensions) */
  metadata?: Record<string, unknown>;
}

/**
 * Minimal frontmatter that legacy memory files have.
 */
export interface LegacyMemoryMetadata {
  description: string;
  read_only?: string;
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse frontmatter from a memory file.
 *
 * Supports both:
 * - Legacy format: just description
 * - Typed format: description + type + sensitivity + importance
 */
export function parseMemoryFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterText = match[1]!;
  const body = match[2]!;
  const frontmatter: Record<string, string> = {};

  // Parse YAML-like key: value pairs
  for (const line of frontmatterText.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body: body.trim() };
}

/**
 * Parse and validate memory metadata from a file's content.
 *
 * Falls back to defaults for missing fields, and infers type from
 * directory structure if not specified in frontmatter.
 */
export function parseMemoryMetadata(
  content: string,
  filePath?: string,
): MemoryMetadata {
  const { frontmatter } = parseMemoryFrontmatter(content);

  // Type: from frontmatter, or infer from path, or default to semantic
  let type: MemoryType = "semantic";
  if (frontmatter.type && isMemoryType(frontmatter.type)) {
    type = frontmatter.type;
  } else if (filePath) {
    // Try to infer from path
    const inferred = inferMemoryTypeFromPath(filePath);
    if (inferred) type = inferred;
  }

  // Sensitivity: from frontmatter, or default by type
  let sensitivity: MemorySensitivity = DEFAULT_SENSITIVITY_BY_TYPE[type];
  if (frontmatter.sensitivity && isMemorySensitivity(frontmatter.sensitivity)) {
    sensitivity = frontmatter.sensitivity;
  }

  // Importance: from frontmatter, or default by type
  let importance: MemoryImportance = DEFAULT_IMPORTANCE_BY_TYPE[type];
  if (frontmatter.importance && isMemoryImportance(frontmatter.importance)) {
    importance = frontmatter.importance;
  }

  return {
    description: frontmatter.description ?? frontmatter.label ?? "",
    type,
    sensitivity,
    importance,
    created: frontmatter.created,
    updated: frontmatter.updated,
    metadata: frontmatter.metadata
      ? JSON.parse(frontmatter.metadata)
      : undefined,
  };
}

// ============================================================================
// Serialization
// ============================================================================

/**
 * Serialize memory metadata to frontmatter string.
 */
export function serializeMemoryFrontmatter(meta: MemoryMetadata): string {
  const lines: string[] = [];

  lines.push(`description: ${meta.description}`);
  lines.push(`type: ${meta.type}`);
  lines.push(`sensitivity: ${meta.sensitivity}`);
  lines.push(`importance: ${meta.importance}`);

  if (meta.created) {
    lines.push(`created: ${meta.created}`);
  }
  if (meta.updated) {
    lines.push(`updated: ${meta.updated}`);
  }
  if (meta.metadata && Object.keys(meta.metadata).length > 0) {
    lines.push(`metadata: ${JSON.stringify(meta.metadata)}`);
  }

  return `---\n${lines.join("\n")}\n---\n`;
}

/**
 * Create a complete memory file with frontmatter and body.
 */
export function createMemoryFile(
  meta: Partial<MemoryMetadata> & { description: string },
  body: string,
): string {
  const now = new Date().toISOString();

  // Infer defaults
  const type: MemoryType = meta.type ?? "semantic";
  const fullMeta: MemoryMetadata = {
    description: meta.description,
    type,
    sensitivity: meta.sensitivity ?? DEFAULT_SENSITIVITY_BY_TYPE[type],
    importance: meta.importance ?? DEFAULT_IMPORTANCE_BY_TYPE[type],
    created: meta.created ?? now,
    updated: meta.updated ?? now,
    metadata: meta.metadata,
  };

  return `${serializeMemoryFrontmatter(fullMeta)}\n${body.trim()}\n`;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate that frontmatter has all required fields.
 * Returns list of missing or invalid fields.
 */
export function validateMemoryFrontmatter(
  frontmatter: Record<string, string>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!frontmatter.description?.trim()) {
    errors.push("Missing required field: description");
  }

  if (frontmatter.type && !isMemoryType(frontmatter.type)) {
    errors.push(
      `Invalid type: ${frontmatter.type}. Valid types: ${[...MEMORY_TYPES].join(", ")}`,
    );
  }

  if (
    frontmatter.sensitivity &&
    !isMemorySensitivity(frontmatter.sensitivity)
  ) {
    errors.push(
      `Invalid sensitivity: ${frontmatter.sensitivity}. Valid values: ${[...MEMORY_SENSITIVITIES].join(", ")}`,
    );
  }

  if (frontmatter.importance && !isMemoryImportance(frontmatter.importance)) {
    errors.push(
      `Invalid importance: ${frontmatter.importance}. Valid values: ${[...MEMORY_IMPORTANCES].join(", ")}`,
    );
  }

  return { valid: errors.length === 0, errors };
}
