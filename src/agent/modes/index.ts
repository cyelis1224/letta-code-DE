/**
 * Modes module — operation modes for the agent runtime.
 *
 * Operation modes control context assembly, tool access, and permissions.
 * They are distinct from permission modes (which control approval gating).
 */

export type {
  ModeContextConfig,
  ModeDefinition,
  ModeState,
  OperationMode,
  ToolAccessConfig,
} from "./types";

export {
  BUILTIN_MODES,
  createInitialModeState,
  enterMode,
  exitMode,
  getModeDefinition,
  getModeDefinitionFromState,
  isOperationMode,
  isToolAllowed,
  OPERATION_MODES,
  registerCustomMode,
  taskKindToMode,
} from "./types";
