/**
 * Memory Classifier — determines type, sensitivity, and importance for memory candidates.
 *
 * The classifier is used by the memory lifecycle pipeline when new memories
 * are extracted from conversations. It can run via LLM (for accurate classification)
 * or via heuristics (for fast local classification).
 */

import type {
  MemoryImportance,
  MemorySensitivity,
  MemoryType,
} from "./taxonomy";
import {
  DEFAULT_IMPORTANCE_BY_TYPE,
  DEFAULT_SENSITIVITY_BY_TYPE,
  MEMORY_TYPE_DESCRIPTIONS,
} from "./taxonomy";

// ============================================================================
// Classification Result
// ============================================================================

/**
 * A memory candidate to be classified.
 */
export interface MemoryCandidate {
  /** The memory content (what would go in the body) */
  content: string;
  /** Optional context about where this memory came from */
  context?: string;
  /** Optional proposed description (from the LLM that suggested this memory) */
  proposedDescription?: string;
}

/**
 * The result of classifying a memory candidate.
 */
export interface ClassificationResult {
  /** Assigned memory type */
  type: MemoryType;
  /** Assigned sensitivity level */
  sensitivity: MemorySensitivity;
  /** Assigned importance level */
  importance: MemoryImportance;
  /** Confidence in the classification (0-1) */
  confidence: number;
  /** Human-readable description for the memory */
  description: string;
  /** Suggested filename (without extension) */
  suggestedFilename?: string;
  /** Reasoning for the classification */
  reasoning?: string;
}

// ============================================================================
// Heuristic Classifier (fast, local)
// ============================================================================

/**
 * Keyword patterns for heuristic type classification.
 */
const TYPE_KEYWORDS: Record<MemoryType, RegExp[]> = {
  episodic: [
    /\bon\b.*\d{4}[-/]\d{1,2}[-/]\d{1,2}/i, // "on 2024-01-15" or similar
    /\d{4}[-/]\d{1,2}[-/]\d{1,2}.*\b(said|mentioned|told|asked)\b/i,
    /\b(yesterday|last week|last month|recently)\b.*\b(said|mentioned|told)\b/i,
    /\b(we|user) (were|was) (working|discussing|talking)\b/i,
  ],
  relationship: [
    /\buser\s+(is|are|seems?|appears?|tends?\s+to)\b/i, // specifically "user is/are..."
    /\bthey\s+(are|seem|appear|tend\s+to)\b/i,
    /\btheir\s+(style|preference|approach|habit|pattern)\b/i,
    /\b(communication|working)\s+style\b/i,
    /\b(they|user)\s+(like|don'?t\s+like|appreciate|get\s+frustrated)\b/i,
    // Direct preference statements
    /\b(my|I)\s+(favorite|favourite|preferred|preference)\b/i,
    /\bI\s+(love|hate|prefer|enjoy|can'?t\s+stand|really\s+like|don'?t\s+like)\b/i,
    /\b(my|the)\s+(color|colour|food|music|language|editor|tool|framework|stack|font|theme|shell)\s+(is|of\s+choice|of\s+preference)\b/i,
    // Identity and self-description
    /\bI\s+(am|'m|work\s+as|identify\s+as|go\s+by)\b/i,
    /\bmy\s+(name|pronouns|title|role|specialty)\b/i,
    // Personal history and life events
    /\bI\s+(used\s+to|grew\s+up|was\s+raised|started|stopped|quit|began)\b/i,
    /\b(my\s+)?(son|daughter|kid|child|family|parent|partner|spouse)\b/i,
    /\b(almost\s+died|survived|accident|injury|hospital|trauma)\b/i,
  ],
  semantic: [
    /\b(means|refers to|definition of|is defined as)\b/i,
    /\b(prefers?|likes?|dislikes?|wants?|needs?)\b.*\b(for|because|since)\b/i,
    /\b(fact|truth|concept|principle|rule)\b/i,
  ],
  procedural: [
    /\b(to|how)\s+(to|do|run|build|deploy|install|configure)\b/i,
    /\bsteps?\b.*:\s*\d+/i, // numbered steps
    /\b(run|execute|type|enter|press)\s+\S+/i, // commands
    /\b(workflow|process|procedure|pipeline)\b/i,
  ],
  project: [
    /\b(project|repo|repository|codebase|fork|branch)\b/i,
    /\b(architecture|structure|design|pattern)\s+(uses?|follows?|implements?)\b/i,
    /\b(we|I)\s+(built|created|implemented|refactored)\b/i,
    /\b(letta-code|lantern|DE)\b/i, // project-specific identifiers
  ],
  reflective: [
    /\b(I|me|my)\s+(should|shouldn'?t|need\s+to|learned|realized)\b/i,
    /\b(mistake|error|wrong|lesson|insight)\b/i,
    /\b(going\s+forward|in\s+the\s+future|next\s+time)\b/i,
    /\b(self|own)\s+(observation|reflection|correction)\b/i,
  ],
};

/**
 * Keywords that indicate sensitive content.
 */
const SENSITIVE_KEYWORDS = [
  /\b(password|secret|key|token|credential|api[_-]?key)\b/i,
  /\b(personal|private|confidential)\b/i,
  /\b(health|medical|mental)\b/i,
  /\b(family|relationship|spouse|partner|child)\b/i,
  /\b(financial|money|salary|income|debt)\b/i,
];

/**
 * Keywords that indicate private content (requires explicit consent).
 */
const PRIVATE_KEYWORDS = [
  /\b(never\s+share|don'?t\s+(ever\s+)?share|do\s+not\s+share)\b/i,
  /\b(secret|confidential|only\s+for\s+me)\b/i,
];

/**
 * Heuristic classifier — fast, rule-based classification.
 * Used when LLM classification isn't available or for quick passes.
 */
export function heuristicClassifyMemory(
  candidate: MemoryCandidate,
): ClassificationResult {
  const content = candidate.content.toLowerCase();
  const context = (candidate.context ?? "").toLowerCase();
  const combined = `${content} ${context}`;

  // Determine type by keyword matching
  let type: MemoryType = "semantic";
  let typeConfidence = 0.3;

  for (const [t, patterns] of Object.entries(TYPE_KEYWORDS)) {
    for (const pattern of patterns) {
      if (pattern.test(combined)) {
        type = t as MemoryType;
        typeConfidence = 0.7;
        // Boost confidence for first-person preference/identity statements
        if (
          t === "relationship" &&
          /\b(my|I)\s+(favorite|favourite|prefer|love|am|'m|used\s+to|grew\s+up|quit|stopped)\b/i.test(
            combined,
          )
        ) {
          typeConfidence = 0.9;
        }
        break;
      }
    }
    if (typeConfidence > 0.5) break;
  }

  // If context mentions project/codebase, boost project type
  if (/\b(project|code|repo|codebase)\b/i.test(context)) {
    type = "project";
    typeConfidence = 0.8;
  }

  // Determine sensitivity
  let sensitivity: MemorySensitivity = DEFAULT_SENSITIVITY_BY_TYPE[type];

  for (const pattern of SENSITIVE_KEYWORDS) {
    if (pattern.test(combined)) {
      sensitivity = "sensitive";
      break;
    }
  }

  for (const pattern of PRIVATE_KEYWORDS) {
    if (pattern.test(combined)) {
      sensitivity = "private";
      break;
    }
  }

  // Determine importance
  let importance: MemoryImportance = DEFAULT_IMPORTANCE_BY_TYPE[type];

  if (/\b(critical|essential|important|must|always)\b/i.test(combined)) {
    importance = "high";
  }
  if (
    /\b(preference|style|pattern)\b/i.test(combined) &&
    type === "relationship"
  ) {
    importance = "high";
  }

  // Generate description from content
  const description =
    candidate.proposedDescription ??
    generateDescriptionFromContent(candidate.content, type);

  return {
    type,
    sensitivity,
    importance,
    confidence: typeConfidence,
    description,
    suggestedFilename: generateFilename(description, type),
    reasoning: `Heuristic classification based on keyword patterns`,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a concise description from content.
 * Takes the first sentence or truncates to ~100 chars.
 */
function generateDescriptionFromContent(
  content: string,
  _type: MemoryType,
): string {
  // Take first sentence
  const firstSentence = content.split(/[.!?]\s+/)[0] ?? content;

  // Truncate to ~100 chars (accounting for "..." suffix)
  const maxLength = 100;
  if (firstSentence.length <= maxLength) {
    return firstSentence.trim();
  }

  // Find a good break point, leaving room for "..."
  const truncated = firstSentence.slice(0, maxLength - 3);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > 0) {
    return `${truncated.slice(0, lastSpace).trim()}...`;
  }
  return `${truncated.trim()}...`;
}

/**
 * Generate a filename from a description.
 * Slugifies the description and adds a type hint.
 */
function generateFilename(description: string, type: MemoryType): string {
  // Slugify: lowercase, replace spaces with underscores, remove special chars
  const slug = description
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 50);

  // Add type prefix
  const prefix =
    type === "episodic"
      ? "event"
      : type === "semantic"
        ? "fact"
        : type === "procedural"
          ? "howto"
          : type === "relationship"
            ? "user"
            : type === "project"
              ? "proj"
              : type === "reflective"
                ? "note"
                : "mem";

  return `${prefix}_${slug}`;
}

// ============================================================================
// LLM Classifier Prompt Template
// ============================================================================

/**
 * Build the prompt for LLM-based classification.
 * This is used when high-accuracy classification is needed.
 */
export function buildClassificationPrompt(candidate: MemoryCandidate): string {
  const typeDescriptions = Object.entries(MEMORY_TYPE_DESCRIPTIONS)
    .map(([type, desc]) => `- ${type}: ${desc}`)
    .join("\n");

  return `Classify this memory candidate and provide structured output.

## Memory Candidate
Content: ${candidate.content}
${candidate.context ? `Context: ${candidate.context}` : ""}

## Memory Types
${typeDescriptions}

## Sensitivity Levels
- public: Safe for automatic storage, no review needed
- sensitive: Contains preferences/personal info, review recommended
- private: Requires explicit user consent before storage

## Importance Levels
- critical: Always retain, never archive (identity-critical)
- high: Retain indefinitely, archive only when explicitly superseded
- medium: Retain for extended period, consolidate when dormant
- low: Retain for limited period, archive when dormant

## Output Format
Return a JSON object with these fields:
{
  "type": "<memory type>",
  "sensitivity": "<sensitivity level>",
  "importance": "<importance level>",
  "confidence": <0.0-1.0>,
  "description": "<concise description for frontmatter>",
  "reasoning": "<brief explanation of classification>"
}`;
}

/**
 * Parse LLM classification output.
 */
export function parseLLMClassificationOutput(
  output: string,
): ClassificationResult | null {
  try {
    // Try to extract JSON from the output
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (!parsed.type || !parsed.description) return null;

    return {
      type: parsed.type as MemoryType,
      sensitivity: (parsed.sensitivity as MemorySensitivity) ?? "public",
      importance: (parsed.importance as MemoryImportance) ?? "medium",
      confidence:
        typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      description: parsed.description,
      suggestedFilename:
        parsed.suggestedFilename ??
        generateFilename(parsed.description, parsed.type),
      reasoning: parsed.reasoning,
    };
  } catch {
    return null;
  }
}
