/**
 * Operation Modes — task-oriented modes that control context assembly,
 * tool access, and permissions.
 *
 * Operation modes are distinct from permission modes (which control
 * approval gating). Operation modes control:
 * - What identity context is loaded (full persona vs. compressed)
 * - What memory types are prioritized for retrieval
 * - What tools are available in this mode
 * - What the default style parameters should be
 * - What the mode entry/exit transitions look like
 *
 * A mode can optionally override permission behavior, but the primary
 * purpose is context shaping, not access control.
 */

import type { TaskKind } from "../eim/types";
import type { MemoryType } from "../memory/taxonomy";

// ============================================================================
// Mode Types
// ============================================================================

/**
 * The available operation modes.
 */
export type OperationMode =
  | "chat" // Relaxed conversation mode
  | "coding" // Implementation and debugging mode
  | "research" // Investigation and analysis mode
  | "design" // Architecture and design thinking mode
  | "creative" // Writing and brainstorming mode
  | "reflection" // Memory maintenance and introspection mode
  | "free-play"; // Unrestricted mode (all tools, full persona)

/**
 * All operation mode values.
 */
export const OPERATION_MODES: readonly OperationMode[] = [
  "chat",
  "coding",
  "research",
  "design",
  "creative",
  "reflection",
  "free-play",
];

/**
 * Check if a string is a valid operation mode.
 */
export function isOperationMode(value: string): value is OperationMode {
  return OPERATION_MODES.includes(value as OperationMode);
}

// ============================================================================
// Mode Configuration
// ============================================================================

/**
 * Tool access configuration for a mode.
 */
export interface ToolAccessConfig {
  /** Tools available in this mode (glob patterns) */
  allowedTools: string[];
  /** Tools explicitly excluded in this mode */
  disallowedTools: string[];
  /** Whether Bash is available in this mode */
  bashAllowed: boolean;
  /** Whether Bash requires approval even in permissive modes */
  bashRequiresApproval: boolean;
  /** Whether file writes require approval */
  writesRequireApproval: boolean;
}

/**
 * Context configuration for a mode.
 */
export interface ModeContextConfig {
  /** Whether to include full prose persona */
  includeFullPersona: boolean;
  /** Memory types to prioritize in this mode */
  memoryTypePriority: MemoryType[];
  /** Maximum number of memories to retrieve */
  maxMemories: number;
  /** Default style overrides for this mode */
  styleOverrides?: {
    verbosity?: "minimal" | "adaptive" | "verbose";
    metaphorTolerance?: "low" | "moderate" | "high";
    technicalDepth?: "low" | "moderate" | "high";
  };
}

/**
 * Full mode definition.
 */
export interface ModeDefinition {
  /** The mode identifier */
  mode: OperationMode;
  /** Human-readable label */
  label: string;
  /** Short description of what this mode is for */
  description: string;
  /** Which task kind this mode maps to for context compilation */
  defaultTaskKind: TaskKind;
  /** Context configuration */
  context: ModeContextConfig;
  /** Tool access configuration */
  tools: ToolAccessConfig;
  /** Whether this mode can be entered automatically (from task classification) */
  autoEnter: boolean;
  /** Whether exiting this mode requires confirmation */
  exitRequiresConfirmation: boolean;
}

// ============================================================================
// Mode Registry
// ============================================================================

/**
 * Built-in mode definitions.
 */
export const BUILTIN_MODES: Record<OperationMode, ModeDefinition> = {
  chat: {
    mode: "chat",
    label: "Chat",
    description:
      "Relaxed conversation mode. Full persona, relationship memory, warm tone.",
    defaultTaskKind: "casual",
    context: {
      includeFullPersona: true,
      memoryTypePriority: ["relationship", "semantic", "episodic"],
      maxMemories: 10,
      styleOverrides: {
        verbosity: "adaptive",
        metaphorTolerance: "high",
        technicalDepth: "moderate",
      },
    },
    tools: {
      allowedTools: ["*"],
      disallowedTools: [],
      bashAllowed: true,
      bashRequiresApproval: true,
      writesRequireApproval: true,
    },
    autoEnter: true,
    exitRequiresConfirmation: false,
  },

  coding: {
    mode: "coding",
    label: "Coding",
    description:
      "Implementation and debugging. Compressed persona, project memory, precise tone.",
    defaultTaskKind: "coding",
    context: {
      includeFullPersona: false,
      memoryTypePriority: ["project", "procedural", "semantic", "relationship"],
      maxMemories: 15,
      styleOverrides: {
        verbosity: "adaptive",
        metaphorTolerance: "low",
        technicalDepth: "high",
      },
    },
    tools: {
      allowedTools: ["*"],
      disallowedTools: [],
      bashAllowed: true,
      bashRequiresApproval: false,
      writesRequireApproval: false,
    },
    autoEnter: true,
    exitRequiresConfirmation: false,
  },

  research: {
    mode: "research",
    label: "Research",
    description:
      "Investigation and analysis. Thorough, cited, with semantic memory priority.",
    defaultTaskKind: "research",
    context: {
      includeFullPersona: false,
      memoryTypePriority: ["semantic", "episodic", "project"],
      maxMemories: 20,
      styleOverrides: {
        verbosity: "verbose",
        metaphorTolerance: "moderate",
        technicalDepth: "high",
      },
    },
    tools: {
      allowedTools: ["*"],
      disallowedTools: [],
      bashAllowed: true,
      bashRequiresApproval: true,
      writesRequireApproval: true,
    },
    autoEnter: true,
    exitRequiresConfirmation: false,
  },

  design: {
    mode: "design",
    label: "Design",
    description:
      "Architecture and design thinking. Project and relationship memory, balanced tone.",
    defaultTaskKind: "design",
    context: {
      includeFullPersona: false,
      memoryTypePriority: ["project", "relationship", "semantic"],
      maxMemories: 15,
      styleOverrides: {
        verbosity: "adaptive",
        metaphorTolerance: "moderate",
        technicalDepth: "moderate",
      },
    },
    tools: {
      allowedTools: ["*"],
      disallowedTools: [],
      bashAllowed: true,
      bashRequiresApproval: true,
      writesRequireApproval: true,
    },
    autoEnter: true,
    exitRequiresConfirmation: false,
  },

  creative: {
    mode: "creative",
    label: "Creative",
    description:
      "Writing and brainstorming. Full persona, episodic memory, rich language.",
    defaultTaskKind: "creative",
    context: {
      includeFullPersona: true,
      memoryTypePriority: ["relationship", "episodic", "reflective"],
      maxMemories: 10,
      styleOverrides: {
        verbosity: "adaptive",
        metaphorTolerance: "high",
        technicalDepth: "moderate",
      },
    },
    tools: {
      allowedTools: ["*"],
      disallowedTools: [],
      bashAllowed: true,
      bashRequiresApproval: true,
      writesRequireApproval: true,
    },
    autoEnter: true,
    exitRequiresConfirmation: false,
  },

  reflection: {
    mode: "reflection",
    label: "Reflection",
    description:
      "Memory maintenance and introspection. Reflective memory, detailed, precise.",
    defaultTaskKind: "reflection",
    context: {
      includeFullPersona: false,
      memoryTypePriority: ["reflective", "episodic", "semantic"],
      maxMemories: 20,
      styleOverrides: {
        verbosity: "verbose",
        metaphorTolerance: "low",
        technicalDepth: "high",
      },
    },
    tools: {
      allowedTools: ["Read", "Write", "Edit", "Grep", "Glob", "memory"],
      disallowedTools: ["Bash"],
      bashAllowed: false,
      bashRequiresApproval: true,
      writesRequireApproval: false,
    },
    autoEnter: true,
    exitRequiresConfirmation: false,
  },

  "free-play": {
    mode: "free-play",
    label: "Free Play",
    description:
      "Unrestricted mode. All tools, full persona, no extra constraints.",
    defaultTaskKind: "casual",
    context: {
      includeFullPersona: true,
      memoryTypePriority: [
        "relationship",
        "semantic",
        "episodic",
        "project",
        "procedural",
        "reflective",
      ],
      maxMemories: 25,
    },
    tools: {
      allowedTools: ["*"],
      disallowedTools: [],
      bashAllowed: true,
      bashRequiresApproval: false,
      writesRequireApproval: false,
    },
    autoEnter: false, // Must be explicitly entered
    exitRequiresConfirmation: true,
  },
};

// ============================================================================
// Mode Manager
// ============================================================================

/**
 * Current mode state.
 */
export interface ModeState {
  /** The currently active mode */
  activeMode: OperationMode;
  /** The previous mode (for exit transitions) */
  previousMode: OperationMode | null;
  /** When the mode was entered */
  enteredAt: string;
  /** Why the mode was entered (auto, manual, etc.) */
  enterReason: "auto" | "manual" | "system";
  /** Custom mode definitions added at runtime */
  customModes: Map<string, ModeDefinition>;
}

/**
 * Create the initial mode state.
 */
export function createInitialModeState(): ModeState {
  return {
    activeMode: "chat",
    previousMode: null,
    enteredAt: new Date().toISOString(),
    enterReason: "system",
    customModes: new Map(),
  };
}

/**
 * Get a mode definition (built-in or custom).
 */
export function getModeDefinition(
  mode: OperationMode | string,
): ModeDefinition | undefined {
  if (mode in BUILTIN_MODES) {
    return BUILTIN_MODES[mode as OperationMode];
  }
  // Check custom modes — but we need a state to look them up from
  return undefined;
}

/**
 * Get a mode definition from state (including custom modes).
 */
export function getModeDefinitionFromState(
  mode: OperationMode | string,
  state: ModeState,
): ModeDefinition | undefined {
  if (mode in BUILTIN_MODES) {
    return BUILTIN_MODES[mode as OperationMode];
  }
  return state.customModes.get(mode);
}

/**
 * Enter a new mode.
 */
export function enterMode(
  state: ModeState,
  newMode: OperationMode,
  reason: "auto" | "manual" | "system" = "manual",
): ModeState {
  const definition = getModeDefinitionFromState(newMode, state);
  if (!definition) {
    throw new Error(`Unknown mode: ${newMode}`);
  }

  return {
    ...state,
    activeMode: newMode,
    previousMode: state.activeMode,
    enteredAt: new Date().toISOString(),
    enterReason: reason,
    customModes: state.customModes,
  };
}

/**
 * Exit the current mode, returning to the previous mode or default.
 */
export function exitMode(state: ModeState): ModeState {
  const fallbackMode: OperationMode = state.previousMode ?? "chat";
  return {
    ...state,
    activeMode: fallbackMode,
    previousMode: state.activeMode,
    enteredAt: new Date().toISOString(),
    enterReason: "manual",
    customModes: state.customModes,
  };
}

/**
 * Map a task kind to the best default operation mode.
 */
export function taskKindToMode(taskKind: TaskKind): OperationMode {
  switch (taskKind) {
    case "casual":
      return "chat";
    case "coding":
      return "coding";
    case "research":
      return "research";
    case "design":
      return "design";
    case "creative":
      return "creative";
    case "reflection":
      return "reflection";
    case "governance":
      return "coding"; // Governance is closest to coding for now
  }
}

/**
 * Check if a tool is allowed in the current mode.
 */
export function isToolAllowed(
  toolName: string,
  mode: OperationMode,
  state: ModeState,
): boolean {
  const definition = getModeDefinitionFromState(mode, state);
  if (!definition) return true; // Default to allowed if mode not found

  const { allowedTools, disallowedTools } = definition.tools;

  // Check disallowed first
  if (disallowedTools.includes(toolName)) return false;
  if (disallowedTools.includes("*")) return false;

  // Check allowed
  if (allowedTools.includes("*")) return true;
  if (allowedTools.includes(toolName)) return true;

  return false;
}

/**
 * Register a custom mode definition.
 */
export function registerCustomMode(
  state: ModeState,
  definition: ModeDefinition,
): ModeState {
  const customModes = new Map(state.customModes);
  customModes.set(definition.mode, definition);
  return { ...state, customModes };
}
