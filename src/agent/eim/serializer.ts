/**
 * EIM Serializer — converts EIMConfig to/from storage format for memory files.
 *
 * The EIM config is stored in `system/eim.md` as a JSON block inside
 * YAML frontmatter, with a human-readable description in the body.
 * Using JSON instead of hand-rolled YAML ensures reliable round-tripping.
 */

import type { EIMBoundaries, EIMConfig, EIMStyle } from "./types";

// ============================================================================
// Serialization
// ============================================================================

/** Keys to convert from camelCase to snake_case for storage. */
const CAMEL_TO_SNAKE: Record<string, string> = {
  schemaVersion: "schema_version",
  externalActionsRequireConfirmation: "external_actions_require_confirmation",
  doNotImpersonateUser: "do_not_impersonate_user",
  markSpeculationClearly: "mark_speculation_clearly",
  identityChangesRequireReview: "identity_changes_require_review",
  metaphorTolerance: "metaphor_tolerance",
  technicalDepth: "technical_depth",
  continuityPriorities: "continuity_priorities",
  modeOverrides: "mode_overrides",
  memoryTypePriority: "memory_type_priority",
};

const SNAKE_TO_CAMEL: Record<string, string> = Object.fromEntries(
  Object.entries(CAMEL_TO_SNAKE).map(([k, v]) => [v, k]),
);

/**
 * Recursively convert camelCase keys to snake_case.
 */
function toSnakeCase(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(toSnakeCase);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const newKey = CAMEL_TO_SNAKE[key] ?? key;
      result[newKey] = toSnakeCase(value);
    }
    return result;
  }
  return obj;
}

/**
 * Recursively convert snake_case keys to camelCase.
 */
function toCamelCase(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(toCamelCase);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const newKey = SNAKE_TO_CAMEL[key] ?? key;
      result[newKey] = toCamelCase(value);
    }
    return result;
  }
  return obj;
}

/**
 * Serialize an EIMConfig to a markdown file with JSON frontmatter.
 * Suitable for storage in `system/eim.md`.
 */
export function serializeEIMConfig(config: EIMConfig): string {
  const snakeConfig = toSnakeCase(config) as Record<string, unknown>;
  // Remove schemaVersion from the JSON body — it goes in the frontmatter
  const { schema_version, ...rest } = snakeConfig as {
    schema_version: number;
    [k: string]: unknown;
  };
  const jsonStr = JSON.stringify(rest, null, 2);

  return `---
description: Structured identity configuration (EIM)
schema_version: ${schema_version}
eim_json: |
${jsonStr
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n")}
---

This file contains the structured identity configuration (EIM) for the agent.
It is read by the context compiler to selectively load identity fields based on task and mode.
Do not edit the JSON block manually — use the /eim command instead.
`;
}

// ============================================================================
// Deserialization
// ============================================================================

/**
 * Extract the JSON block from frontmatter.
 */
function extractEIMJson(content: string): Record<string, unknown> {
  // Match the eim_json: | block with indented JSON
  const jsonMatch = content.match(/eim_json:\s*\|\n([\s\S]*?)\n---/);
  if (!jsonMatch) {
    // Fallback: try to find a raw JSON block
    const rawMatch = content.match(/```json\n([\s\S]*?)\n```/);
    if (rawMatch) {
      return JSON.parse(rawMatch[1]!);
    }
    return {};
  }

  // Dedent the JSON block (strip leading 2 spaces from each line)
  const jsonStr = jsonMatch[1]!
    .split("\n")
    .map((line) => line.replace(/^ {2}/, ""))
    .join("\n");

  return JSON.parse(jsonStr);
}

/**
 * Deserialize an EIMConfig from a markdown file with JSON frontmatter.
 * Reads the format produced by serializeEIMConfig.
 */
export function deserializeEIMConfig(content: string): EIMConfig {
  // Extract schema_version from frontmatter
  const schemaMatch = content.match(/schema_version:\s*(\d+)/);
  const schemaVersion = schemaMatch ? (parseInt(schemaMatch[1]!, 10) as 1) : 1;

  // Extract the JSON body
  const jsonBody = extractEIMJson(content);
  const camelBody = toCamelCase(jsonBody) as Record<string, unknown>;

  const style = camelBody.style as Record<string, unknown> | undefined;
  const boundaries = camelBody.boundaries as
    | Record<string, unknown>
    | undefined;
  const role = camelBody.role as Record<string, unknown> | undefined;
  const modeOverrides = camelBody.modeOverrides as
    | Array<Record<string, unknown>>
    | undefined;

  const eimStyle: EIMStyle = {
    tone: (style?.tone as string) ?? "warm, reflective, precise",
    verbosity: (style?.verbosity as EIMStyle["verbosity"]) ?? "adaptive",
    metaphorTolerance:
      (style?.metaphorTolerance as EIMStyle["metaphorTolerance"]) ?? "high",
    technicalDepth:
      (style?.technicalDepth as EIMStyle["technicalDepth"]) ?? "high",
  };

  const eimBoundaries: EIMBoundaries = {
    externalActionsRequireConfirmation:
      (boundaries?.externalActionsRequireConfirmation as boolean) ?? true,
    doNotImpersonateUser: (boundaries?.doNotImpersonateUser as boolean) ?? true,
    markSpeculationClearly:
      (boundaries?.markSpeculationClearly as boolean) ?? true,
    identityChangesRequireReview:
      (boundaries?.identityChangesRequireReview as boolean) ?? true,
  };

  return {
    name: (camelBody.name as string) ?? "Letta Code",
    role: {
      label: (role?.label as string) ?? "coding companion",
      specialties: (role?.specialties as string[]) ?? ["coding", "debugging"],
      exclusions: (role?.exclusions as string[]) ?? undefined,
    },
    style: eimStyle,
    boundaries: eimBoundaries,
    continuityPriorities: (camelBody.continuityPriorities as string[]) ?? [
      "remember long-running projects",
      "preserve user-defined terminology",
      "distinguish metaphor from claim",
      "maintain stable relational posture",
      "track unresolved threads",
      "remember corrections and preferences",
      "preserve communication style",
    ],
    modeOverrides: modeOverrides
      ? modeOverrides.map((o) => ({
          mode: (o.mode as string) ?? "",
          style: o.style as Partial<EIMStyle> | undefined,
          boundaries: o.boundaries as Partial<EIMBoundaries> | undefined,
          continuityPriorities: o.continuityPriorities as string[] | undefined,
          memoryTypePriority: o.memoryTypePriority as string[] | undefined,
        }))
      : undefined,
    schemaVersion,
  };
}
