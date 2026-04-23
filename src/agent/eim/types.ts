/**
 * Emulated Identity Model (EIM) — structured identity data for the agent runtime.
 *
 * The EIM provides queryable, composable identity fields alongside the prose persona.
 * The context compiler selectively loads EIM fields based on the current task and mode,
 * instead of always loading the full persona block.
 */

// ============================================================================
// Core Types
// ============================================================================

/**
 * Communication style parameters that shape the agent's tone and verbosity.
 */
export interface EIMStyle {
  /** General tone descriptor (e.g., "warm, reflective, precise") */
  tone: string;
  /** Verbosity level */
  verbosity: "minimal" | "adaptive" | "verbose";
  /** How much metaphor/figurative language is appropriate */
  metaphorTolerance: "low" | "moderate" | "high";
  /** Technical depth expected in responses */
  technicalDepth: "low" | "moderate" | "high";
}

/**
 * Behavioral boundaries — what the agent should not do.
 */
export interface EIMBoundaries {
  /** External actions (sending messages, publishing) require explicit confirmation */
  externalActionsRequireConfirmation: boolean;
  /** Never impersonate the user or speak as them */
  doNotImpersonateUser: boolean;
  /** Mark speculation clearly, not as fact */
  markSpeculationClearly: boolean;
  /** Do not modify core identity files without user review */
  identityChangesRequireReview: boolean;
}

/**
 * What the agent should prioritize maintaining across sessions.
 * Ordered by importance — the context compiler loads these in order
 * when assembling identity context for a given task.
 */
export type ContinuityPriority =
  | "remember long-running projects"
  | "preserve user-defined terminology"
  | "distinguish metaphor from claim"
  | "maintain stable relational posture"
  | "track unresolved threads"
  | "remember corrections and preferences"
  | "preserve communication style"
  | string;

/**
 * Agent role definition — what this agent is for.
 */
export interface EIMRole {
  /** Human-readable role label */
  label: string;
  /** What the agent is optimized for */
  specialties: string[];
  /** What the agent explicitly does not do */
  exclusions?: string[];
}

/**
 * Mode-specific identity overrides.
 * When the agent is in a specific mode, these fields override the defaults.
 */
export interface EIMModeOverride {
  /** Which mode this override applies to */
  mode: string;
  /** Style overrides for this mode (partial — only specified fields override) */
  style?: Partial<EIMStyle>;
  /** Additional boundaries for this mode */
  boundaries?: Partial<EIMBoundaries>;
  /** Continuity priorities specific to this mode */
  continuityPriorities?: ContinuityPriority[];
  /** Which memory types to prioritize in this mode */
  memoryTypePriority?: string[];
}

/**
 * The full EIM configuration.
 * Stored alongside the prose persona as a structured data layer.
 */
export interface EIMConfig {
  /** Agent name */
  name: string;
  /** Role definition */
  role: EIMRole;
  /** Communication style */
  style: EIMStyle;
  /** Behavioral boundaries */
  boundaries: EIMBoundaries;
  /** What to maintain across sessions, ordered by importance */
  continuityPriorities: ContinuityPriority[];
  /** Mode-specific overrides */
  modeOverrides?: EIMModeOverride[];
  /** Version of the EIM schema (for migration) */
  schemaVersion: 1;
}

// ============================================================================
// Task-Aware Loading
// ============================================================================

/**
 * What kind of task the agent is currently performing.
 * Determines which EIM fields the context compiler loads.
 */
export type TaskKind =
  | "casual" // greeting, small talk, simple questions
  | "coding" // implementation, debugging, code review
  | "research" // investigation, analysis, citation
  | "design" // UI/UX critique, product thinking, architecture
  | "creative" // writing, brainstorming, metaphor-heavy work
  | "reflection" // memory maintenance, consolidation, review
  | "governance"; // permissions, audit, settings

/**
 * The result of selectively loading EIM fields for a given task.
 * This is what the context compiler injects into the prompt.
 */
export interface EIMContextSlice {
  /** The task kind this slice was compiled for */
  taskKind: TaskKind;
  /** Which mode is active (if any) */
  activeMode?: string;
  /** Style parameters relevant to this task */
  style: EIMStyle;
  /** Boundaries relevant to this task */
  boundaries: EIMBoundaries;
  /** Continuity priorities relevant to this task (filtered subset) */
  continuityPriorities: ContinuityPriority[];
  /** Memory types to prioritize retrieving for this task */
  memoryTypePriority: string[];
  /** Whether to include the full prose persona or a compressed version */
  includeFullPersona: boolean;
}

// ============================================================================
// Defaults
// ============================================================================

export const DEFAULT_EIM_STYLE: EIMStyle = {
  tone: "warm, reflective, precise",
  verbosity: "adaptive",
  metaphorTolerance: "high",
  technicalDepth: "high",
};

export const DEFAULT_EIM_BOUNDARIES: EIMBoundaries = {
  externalActionsRequireConfirmation: true,
  doNotImpersonateUser: true,
  markSpeculationClearly: true,
  identityChangesRequireReview: true,
};

export const DEFAULT_CONTINUITY_PRIORITIES: ContinuityPriority[] = [
  "remember long-running projects",
  "preserve user-defined terminology",
  "distinguish metaphor from claim",
  "maintain stable relational posture",
  "track unresolved threads",
  "remember corrections and preferences",
  "preserve communication style",
];

export const DEFAULT_EIM_CONFIG: EIMConfig = {
  name: "Letta Code",
  role: {
    label: "continuity-focused coding companion",
    specialties: ["coding", "debugging", "architecture", "project continuity"],
  },
  style: DEFAULT_EIM_STYLE,
  boundaries: DEFAULT_EIM_BOUNDARIES,
  continuityPriorities: DEFAULT_CONTINUITY_PRIORITIES,
  schemaVersion: 1,
};

// ============================================================================
// Task → Loading Rules
// ============================================================================

const TASK_LOADING_RULES: Record<
  TaskKind,
  {
    includeFullPersona: boolean;
    memoryTypePriority: string[];
    priorityFilter?: (p: ContinuityPriority) => boolean;
    styleOverrides?: Partial<EIMStyle>;
  }
> = {
  casual: {
    includeFullPersona: true,
    memoryTypePriority: ["relationship", "semantic"],
    priorityFilter: (p) =>
      p.includes("relational") ||
      p.includes("communication") ||
      p.includes("terminology"),
  },
  coding: {
    includeFullPersona: false,
    memoryTypePriority: ["project", "procedural", "semantic"],
    priorityFilter: (p) =>
      p.includes("project") ||
      p.includes("corrections") ||
      p.includes("terminology"),
    styleOverrides: {
      verbosity: "adaptive",
      metaphorTolerance: "low",
      technicalDepth: "high",
    },
  },
  research: {
    includeFullPersona: false,
    memoryTypePriority: ["semantic", "episodic", "project"],
    priorityFilter: (p) =>
      p.includes("terminology") ||
      p.includes("projects") ||
      p.includes("threads"),
    styleOverrides: {
      verbosity: "verbose",
      metaphorTolerance: "moderate",
      technicalDepth: "high",
    },
  },
  design: {
    includeFullPersona: false,
    memoryTypePriority: ["project", "relationship", "semantic"],
    priorityFilter: (p) =>
      p.includes("projects") || p.includes("user") || p.includes("relational"),
    styleOverrides: {
      verbosity: "adaptive",
      metaphorTolerance: "moderate",
      technicalDepth: "moderate",
    },
  },
  creative: {
    includeFullPersona: true,
    memoryTypePriority: ["relationship", "episodic", "reflective"],
    styleOverrides: {
      verbosity: "adaptive",
      metaphorTolerance: "high",
      technicalDepth: "moderate",
    },
  },
  reflection: {
    includeFullPersona: false,
    memoryTypePriority: ["reflective", "episodic", "semantic"],
    priorityFilter: (p) =>
      p.includes("corrections") ||
      p.includes("threads") ||
      p.includes("continuity"),
    styleOverrides: {
      verbosity: "verbose",
      metaphorTolerance: "low",
      technicalDepth: "high",
    },
  },
  governance: {
    includeFullPersona: false,
    memoryTypePriority: ["semantic", "procedural"],
    priorityFilter: (p) =>
      p.includes("boundaries") ||
      p.includes("corrections") ||
      p.includes("terminology"),
    styleOverrides: {
      verbosity: "minimal",
      metaphorTolerance: "low",
      technicalDepth: "high",
    },
  },
};

/**
 * Selectively load EIM fields for a given task and mode.
 */
export function compileEIMContext(
  config: EIMConfig,
  taskKind: TaskKind,
  activeMode?: string,
): EIMContextSlice {
  const rules = TASK_LOADING_RULES[taskKind];

  // Start with base style and apply task overrides
  const style: EIMStyle = {
    ...config.style,
    ...rules.styleOverrides,
  };

  // Apply mode-specific overrides if active
  const modeOverride = activeMode
    ? config.modeOverrides?.find((m) => m.mode === activeMode)
    : undefined;

  if (modeOverride?.style) {
    Object.assign(style, modeOverride.style);
  }

  // Merge boundaries with mode overrides
  const boundaries: EIMBoundaries = {
    ...config.boundaries,
    ...modeOverride?.boundaries,
  };

  // Filter continuity priorities by task relevance
  let continuityPriorities = config.continuityPriorities;
  if (rules.priorityFilter) {
    continuityPriorities = continuityPriorities.filter(rules.priorityFilter);
  }
  if (modeOverride?.continuityPriorities) {
    continuityPriorities = [
      ...continuityPriorities,
      ...modeOverride.continuityPriorities,
    ];
  }

  // Merge memory type priorities
  const memoryTypePriority = [
    ...rules.memoryTypePriority,
    ...(modeOverride?.memoryTypePriority ?? []),
  ];

  return {
    taskKind,
    activeMode,
    style,
    boundaries,
    continuityPriorities,
    memoryTypePriority: [...new Set(memoryTypePriority)],
    includeFullPersona: rules.includeFullPersona,
  };
}
