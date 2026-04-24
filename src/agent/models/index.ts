/**
 * Models module — multi-model orchestration for the agent runtime.
 *
 * Provides model capabilities, routing, and fallback chains.
 */

export type {
  ModelCapabilities,
  ModelEntry,
  ModelSelection,
  TaskRequirements,
} from "./capabilities";

export {
  getAllModels,
  getDefaultModels,
  getFallbackChain,
  getModel,
  inferCapabilities,
  initializeDefaultModels,
  registerModel,
  selectModel,
} from "./capabilities";

export type {
  ModelHealth,
  RoutingPreferences,
} from "./router";

export {
  getHealthyModels,
  getModelChain,
  getModelHealth,
  getRequirementsForMode,
  getRequirementsForTask,
  isModelHealthy,
  modelSupports,
  routeModel,
  updateModelHealth,
} from "./router";
