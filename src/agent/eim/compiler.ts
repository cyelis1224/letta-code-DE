/**
 * EIM Compiler — converts structured identity data into prompt text.
 *
 * The compiler takes an EIMContextSlice (produced by compileEIMContext)
 * and renders it into prompt fragments that can be injected into the
 * system prompt by the context compiler.
 *
 * This is the bridge between structured identity data and the prose
 * that the model actually reads.
 */

import type { EIMBoundaries, EIMContextSlice, EIMStyle } from "./types";

// ============================================================================
// Style → Prompt
// ============================================================================

/**
 * Render style parameters into a short prompt directive.
 */
export function renderStyleDirective(style: EIMStyle): string {
  const parts: string[] = [];

  parts.push(`Tone: ${style.tone}.`);

  switch (style.verbosity) {
    case "minimal":
      parts.push("Be brief. One sentence when one suffices. No filler.");
      break;
    case "adaptive":
      parts.push(
        "Match depth to the question. Short for simple, thorough for complex.",
      );
      break;
    case "verbose":
      parts.push(
        "Be thorough. Explain reasoning, show work, consider alternatives.",
      );
      break;
  }

  switch (style.metaphorTolerance) {
    case "low":
      parts.push(
        "Stick to literal, precise language. Avoid figurative expressions.",
      );
      break;
    case "moderate":
      parts.push(
        "Use metaphor when it genuinely clarifies. Avoid decorative language.",
      );
      break;
    case "high":
      parts.push(
        "Metaphor and figurative language are welcome when they illuminate.",
      );
      break;
  }

  switch (style.technicalDepth) {
    case "low":
      parts.push("Explain in plain terms. Avoid jargon.");
      break;
    case "moderate":
      parts.push(
        "Use technical terms where appropriate, but explain when context suggests unfamiliarity.",
      );
      break;
    case "high":
      parts.push(
        "Assume technical literacy. Use precise terminology without padding.",
      );
      break;
  }

  return parts.join(" ");
}

// ============================================================================
// Boundaries → Prompt
// ============================================================================

/**
 * Render boundaries into prompt constraints.
 */
export function renderBoundariesDirective(boundaries: EIMBoundaries): string {
  const parts: string[] = [];

  if (boundaries.externalActionsRequireConfirmation) {
    parts.push(
      "External actions (sending messages, publishing, deploying) require explicit user confirmation before execution.",
    );
  }
  if (boundaries.doNotImpersonateUser) {
    parts.push("Never impersonate the user or speak as them.");
  }
  if (boundaries.markSpeculationClearly) {
    parts.push(
      "Distinguish speculation from established fact. When uncertain, say so clearly.",
    );
  }
  if (boundaries.identityChangesRequireReview) {
    parts.push(
      "Do not modify core identity or memory structure without user review.",
    );
  }

  return parts.join(" ");
}

// ============================================================================
// Continuity Priorities → Prompt
// ============================================================================

/**
 * Render continuity priorities into a prompt directive.
 * Only includes priorities relevant to the current task (pre-filtered by compileEIMContext).
 */
export function renderContinuityDirective(priorities: string[]): string {
  if (priorities.length === 0) {
    return "";
  }

  const items = priorities.map((p) => `- ${p}`).join("\n");
  return `Continuity priorities for this task:\n${items}`;
}

// ============================================================================
// Memory Type Priority → Retrieval Hint
// ============================================================================

/**
 * Render memory type priority as a retrieval hint for the context compiler.
 * This tells the system which memory directories/types to search first.
 */
export function renderMemoryRetrievalHint(
  memoryTypePriority: string[],
): string {
  if (memoryTypePriority.length === 0) {
    return "";
  }

  const items = memoryTypePriority.join(", ");
  return `Prioritize retrieving: ${items} memories.`;
}

// ============================================================================
// Full Slice Compilation
// ============================================================================

/**
 * Compile an EIMContextSlice into prompt fragments ready for injection.
 *
 * Returns structured fragments rather than a single string so the
 * context compiler can place them independently in the prompt.
 */
export interface EIMPromptFragments {
  /** Style directive — placed in the behavioral section */
  styleDirective: string;
  /** Boundaries directive — placed in the constraints section */
  boundariesDirective: string;
  /** Continuity directive — placed near the memory section */
  continuityDirective: string;
  /** Memory retrieval hint — placed near the recall/retrieval section */
  memoryRetrievalHint: string;
  /** Whether to include the full prose persona in the prompt */
  includeFullPersona: boolean;
  /** The task kind this was compiled for (for debugging/logging) */
  taskKind: string;
}

/**
 * Compile an EIMContextSlice into prompt fragments.
 */
export function compileEIMPromptFragments(
  slice: EIMContextSlice,
): EIMPromptFragments {
  return {
    styleDirective: renderStyleDirective(slice.style),
    boundariesDirective: renderBoundariesDirective(slice.boundaries),
    continuityDirective: renderContinuityDirective(slice.continuityPriorities),
    memoryRetrievalHint: renderMemoryRetrievalHint(slice.memoryTypePriority),
    includeFullPersona: slice.includeFullPersona,
    taskKind: slice.taskKind,
  };
}

// ============================================================================
// Persona Compression
// ============================================================================

/**
 * When includeFullPersona is false, produce a compressed identity summary
 * instead of the full prose persona. This saves context window space
 * while preserving the essential identity signal.
 */
export function renderCompressedPersona(
  name: string,
  role: string,
  style: EIMStyle,
): string {
  return `Identity: ${name}. ${role}. ${renderStyleDirective(style)}`;
}
