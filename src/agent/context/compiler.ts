/**
 * Context Compiler — assembles the prompt context for each turn.
 *
 * The context compiler sits between the agent turn loop and the model call.
 * It decides:
 * 1. What identity slice to load (EIM → full persona or compressed)
 * 2. What memories to retrieve (typed memory with task-aware priority)
 * 3. How to allocate the context budget across identity, memories, and tools
 *
 * The compiler is the bridge between the structured identity system (EIM),
 * the typed memory taxonomy, and the actual prompt that the model sees.
 */

import type { EIMPromptFragments } from "../eim/compiler";
import {
  compileEIMPromptFragments,
  renderCompressedPersona,
} from "../eim/compiler";
import type { EIMConfig, EIMContextSlice, TaskKind } from "../eim/types";
import { compileEIMContext } from "../eim/types";
import type { MemoryType } from "../memory/taxonomy";
import { TASK_MEMORY_PRIORITY } from "../memory/taxonomy";

// ============================================================================
// Context Budget
// ============================================================================

/**
 * Token budget allocation for the context window.
 *
 * The total context window is divided into sections. The compiler
 * allocates tokens to each and enforces limits.
 */
export interface ContextBudget {
  /** Total context window size in tokens */
  totalTokens: number;
  /** Maximum tokens for identity (persona + EIM directives) */
  identityBudget: number;
  /** Maximum tokens for retrieved memories */
  memoryBudget: number;
  /** Maximum tokens for conversation history */
  conversationBudget: number;
  /** Maximum tokens for tool definitions and results */
  toolBudget: number;
  /** Reserved tokens for system overhead (formatting, instructions) */
  systemOverhead: number;
}

/**
 * Default budget allocation as percentages of total context.
 */
const DEFAULT_BUDGET_RATIOS = {
  identity: 0.15, // 15% for identity
  memory: 0.2, // 20% for retrieved memories
  conversation: 0.35, // 35% for conversation history
  tool: 0.15, // 15% for tools
  systemOverhead: 0.05, // 5% for system overhead
} as const;

/**
 * Calculate context budget from total window size.
 */
export function calculateBudget(totalTokens: number): ContextBudget {
  return {
    totalTokens,
    identityBudget: Math.floor(totalTokens * DEFAULT_BUDGET_RATIOS.identity),
    memoryBudget: Math.floor(totalTokens * DEFAULT_BUDGET_RATIOS.memory),
    conversationBudget: Math.floor(
      totalTokens * DEFAULT_BUDGET_RATIOS.conversation,
    ),
    toolBudget: Math.floor(totalTokens * DEFAULT_BUDGET_RATIOS.tool),
    systemOverhead: Math.floor(
      totalTokens * DEFAULT_BUDGET_RATIOS.systemOverhead,
    ),
  };
}

// ============================================================================
// Compiled Context
// ============================================================================

/**
 * A memory retrieval request from the context compiler.
 * Tells the runtime what memories to fetch before assembling the prompt.
 */
export interface MemoryRetrievalRequest {
  /** Memory types to prioritize, in order */
  typePriority: MemoryType[];
  /** Maximum tokens to allocate for retrieved memories */
  maxTokens: number;
  /** Maximum number of memory files to retrieve */
  maxFiles: number;
  /** Specific memory paths to include (if known) */
  includePaths?: string[];
  /** Memory paths to exclude */
  excludePaths?: string[];
}

/**
 * The fully compiled context for a turn.
 * This is the output of the context compiler — all the pieces
 * needed to assemble the system prompt.
 */
export interface CompiledContext {
  /** The task kind this context was compiled for */
  taskKind: TaskKind;
  /** The active mode (if any) */
  activeMode?: string;
  /** Budget allocation */
  budget: ContextBudget;
  /** Whether to include the full prose persona */
  includeFullPersona: boolean;
  /** EIM prompt fragments (style, boundaries, continuity) */
  eimFragments: EIMPromptFragments;
  /** Compressed persona (used when includeFullPersona is false) */
  compressedPersona?: string;
  /** Memory retrieval request */
  memoryRetrieval: MemoryRetrievalRequest;
}

// ============================================================================
// Task Classification
// ============================================================================

/**
 * Classify the current task kind from the user's message.
 *
 * This is a simple heuristic — the full implementation will use
 * the LLM-based classifier from Phase 8 (multi-model orchestration).
 */
export function classifyTask(userMessage: string): TaskKind {
  const lower = userMessage.toLowerCase();

  // Coding patterns
  if (
    /\b(code|implement|debug|fix|build|compile|run|test|refactor)\b/.test(
      lower,
    ) ||
    /\b(function|class|method|variable|type|interface)\b/.test(lower) ||
    /\b(bug|error|crash|stack\s+trace|exception)\b/.test(lower) ||
    /\b(git|commit|branch|merge|pull\s+request)\b/.test(lower)
  ) {
    return "coding";
  }

  // Research patterns
  if (
    /\b(research|investigate|analyze|compare|evaluate|find\s+out)\b/.test(
      lower,
    ) ||
    /\b(what\s+is|how\s+does|why\s+does|explain\s+how)\b/.test(lower)
  ) {
    return "research";
  }

  // Design patterns
  if (
    /\b(design|architecture|layout|ux|ui|wireframe|mockup)\b/.test(lower) ||
    /\b(user\s+experience|interface|prototype)\b/.test(lower)
  ) {
    return "design";
  }

  // Creative patterns
  if (
    /\b(write|draft|compose|brainstorm|story|poem|creative)\b/.test(lower) ||
    /\b(idea|imagine|fiction|narrative)\b/.test(lower)
  ) {
    return "creative";
  }

  // Governance patterns (check before reflection — "audit log" shouldn't be reflection)
  if (
    /\b(permissions?|settings?|config|audit|governance|policy)\b/.test(lower) ||
    /\b(allow|deny|approve|reject)\b/.test(lower) ||
    /\breview\s+(permissions?|settings?|config|audit|policy|access)\b/.test(
      lower,
    )
  ) {
    return "governance";
  }

  // Reflection patterns
  if (
    /\b(reflect|consolidate|summarize|what\s+have\s+we)\b/.test(lower) ||
    /\b(memory|memories|remember|forget)\b/.test(lower) ||
    /\breview\s+(memories?|memory)\b/.test(lower)
  ) {
    return "reflection";
  }

  // Default to casual for greetings, short messages, etc.
  return "casual";
}

// ============================================================================
// Context Compilation
// ============================================================================

/**
 * Options for compiling the context.
 */
export interface CompileContextOptions {
  /** The EIM configuration */
  eimConfig: EIMConfig;
  /** The user's message (for task classification) */
  userMessage: string;
  /** The active mode (if any) */
  activeMode?: string;
  /** Total context window size in tokens */
  contextWindowSize?: number;
  /** Override the task kind (skip heuristic classification) */
  taskKindOverride?: TaskKind;
  /** Specific memory paths to include */
  includeMemoryPaths?: string[];
}

/**
 * Compile the context for a turn.
 *
 * This is the main entry point for the context compiler. It:
 * 1. Classifies the task kind from the user's message
 * 2. Compiles the EIM context slice
 * 3. Renders EIM prompt fragments
 * 4. Calculates the context budget
 * 5. Builds a memory retrieval request
 *
 * The returned CompiledContext contains everything needed to
 * assemble the system prompt for the model.
 */
export function compileContext(
  options: CompileContextOptions,
): CompiledContext {
  const {
    eimConfig,
    userMessage,
    activeMode,
    contextWindowSize = 128000,
    taskKindOverride,
    includeMemoryPaths,
  } = options;

  // 1. Classify task
  const taskKind: TaskKind = taskKindOverride ?? classifyTask(userMessage);

  // 2. Compile EIM context slice
  const eimSlice: EIMContextSlice = compileEIMContext(
    eimConfig,
    taskKind,
    activeMode,
  );

  // 3. Render EIM prompt fragments
  const eimFragments = compileEIMPromptFragments(eimSlice);

  // 4. Calculate budget
  const budget = calculateBudget(contextWindowSize);

  // 5. Build compressed persona (if needed)
  const compressedPersona = eimSlice.includeFullPersona
    ? undefined
    : renderCompressedPersona(
        eimConfig.name,
        eimConfig.role.label,
        eimSlice.style,
      );

  // 6. Determine memory type priority
  const typePriority = eimSlice.memoryTypePriority as MemoryType[];

  // 7. Build memory retrieval request
  const memoryRetrieval: MemoryRetrievalRequest = {
    typePriority,
    maxTokens: budget.memoryBudget,
    maxFiles: Math.max(5, Math.floor(budget.memoryBudget / 500)), // ~500 tokens per file
    includePaths: includeMemoryPaths,
    excludePaths: [],
  };

  return {
    taskKind,
    activeMode,
    budget,
    includeFullPersona: eimSlice.includeFullPersona,
    eimFragments,
    compressedPersona,
    memoryRetrieval,
  };
}

// ============================================================================
// Prompt Assembly
// ============================================================================

/**
 * Assemble the system prompt from a compiled context.
 *
 * This function takes the CompiledContext and produces the actual
 * system prompt string that gets sent to the model.
 *
 * Note: The persona content and conversation history are injected
 * separately by the runtime — this function produces the
 * *supplemental* prompt sections.
 */
export function assembleContextSections(context: CompiledContext): {
  /** Identity section (style + boundaries + continuity) */
  identitySection: string;
  /** Memory retrieval hint section */
  memoryHintSection: string;
  /** Task kind hint (for debugging/logging) */
  taskHint: string;
} {
  const { eimFragments, includeFullPersona, compressedPersona } = context;

  // Identity section
  const identityParts: string[] = [];

  if (!includeFullPersona && compressedPersona) {
    identityParts.push(compressedPersona);
  }

  identityParts.push(eimFragments.styleDirective);
  identityParts.push(eimFragments.boundariesDirective);

  if (eimFragments.continuityDirective) {
    identityParts.push(eimFragments.continuityDirective);
  }

  // Memory hint section
  const memoryHintParts: string[] = [];
  if (eimFragments.memoryRetrievalHint) {
    memoryHintParts.push(eimFragments.memoryRetrievalHint);
  }

  return {
    identitySection: identityParts.join("\n\n"),
    memoryHintSection: memoryHintParts.join("\n"),
    taskHint: `Task: ${context.taskKind}${context.activeMode ? ` (mode: ${context.activeMode})` : ""}`,
  };
}
