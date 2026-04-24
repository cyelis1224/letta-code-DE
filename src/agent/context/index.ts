/**
 * Context module — the context compiler for the agent runtime.
 *
 * The context compiler sits between the agent turn loop and the model call.
 * It decides what identity, memories, and constraints to load for each turn.
 */

export type {
  CompileContextOptions,
  CompiledContext,
  ContextBudget,
  MemoryRetrievalRequest,
} from "./compiler";

export {
  assembleContextSections,
  calculateBudget,
  classifyTask,
  compileContext,
} from "./compiler";
