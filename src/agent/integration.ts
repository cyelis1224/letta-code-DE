/**
 * Integration — wires the Lantern Shell modules into the agent runtime.
 *
 * This module provides:
 * - Prompt augmentation with context compiler output
 * - Turn-level hooks for memory pipeline and mode tracking
 * - Tool call wrappers for event logging and governance
 * - Memory tool integration with the lifecycle pipeline
 */

import type { ContextBudget } from "./context/compiler";
import { calculateBudget, classifyTask } from "./context/compiler";
import { compileEIMPromptFragments } from "./eim/compiler";
import type { EIMConfig, TaskKind } from "./eim/types";
import { compileEIMContext, DEFAULT_EIM_CONFIG } from "./eim/types";
import {
  createMemoryReadEvent,
  createMemoryWriteEvent,
  createModeChangeEvent,
  createToolCallEvent,
} from "./events/instrumentation";
import type { AgentEvent } from "./events/types";
import { hasPermission, logAuditEvent } from "./governance/rbac";
import type { MemoryEntry } from "./memory/continuity-schema";
import { type PipelineResult, processCandidate } from "./memory/pipeline";
import {
  retrieveMemoriesForTurn,
  type StorageResult,
  storePipelineResults,
} from "./memory/storage";
import { routeModel } from "./models/router";
import {
  createInitialModeState,
  enterMode,
  exitMode,
  isToolAllowed,
  type ModeState,
  type OperationMode,
  taskKindToMode,
} from "./modes/types";

// ============================================================================
// Agent Runtime State
// ============================================================================

/**
 * Extended agent state for Lantern Shell.
 */
export interface LanternRuntimeState {
  /** EIM configuration */
  eimConfig: EIMConfig;
  /** Current operation mode */
  modeState: ModeState;
  /** Current task kind (from last classification) */
  currentTaskKind: TaskKind;
  /** Memory pipeline results from last turn */
  lastPipelineResults: PipelineResult[];
  /** Turn counter */
  turnCount: number;
  /** Whether context has been compiled for this turn */
  contextCompiled: boolean;
  /** Model selection result from last pre-turn hook (informational) */
  modelSelection?: {
    model: string;
    reason: string;
  };
  /** Context budget allocation from last pre-turn hook (informational) */
  contextBudget?: ContextBudget;
  /** Events collected during this turn (flushed to audit log on end_turn) */
  turnEvents: AgentEvent[];
  /** Turns since last reflection cycle (for throttling) */
  turnsSinceLastReflection?: number;
}

/**
 * Create initial runtime state.
 */
export function createInitialRuntimeState(
  eimConfig?: Partial<EIMConfig>,
): LanternRuntimeState {
  return {
    eimConfig: { ...DEFAULT_EIM_CONFIG, ...eimConfig },
    modeState: createInitialModeState(),
    currentTaskKind: "casual",
    lastPipelineResults: [],
    turnCount: 0,
    contextCompiled: false,
    turnEvents: [],
  };
}

// ============================================================================
// Turn Hooks
// ============================================================================

/**
 * Pre-turn hook result.
 */
export interface PreTurnHookResult {
  /** Compiled context sections to inject */
  contextSections: {
    identity: string;
    memoryHint: string;
    /** Retrieved memories formatted for injection */
    retrievedMemories?: string;
  };
  /** Task kind classification */
  taskKind: TaskKind;
  /** Selected operation mode */
  mode: OperationMode;
  /** Model selection result */
  modelSelection: {
    model: string;
    reason: string;
  };
  /** Retrieved memories (raw entries) */
  memories?: MemoryEntry[];
}

/**
 * Run pre-turn hook: classify task, compile context, select mode/model.
 */
export function preTurnHook(
  userMessage: string,
  state: LanternRuntimeState,
  options?: {
    activeMode?: OperationMode;
    preferredModel?: string;
    agentId?: string;
    conversationId?: string;
  },
): PreTurnHookResult {
  // 1. Classify task
  const taskKind = classifyTask(userMessage);
  state.currentTaskKind = taskKind;

  // 2. Determine operation mode
  let mode: OperationMode;
  const previousMode = state.modeState.activeMode;
  if (options?.activeMode) {
    mode = options.activeMode;
    state.modeState = enterMode(state.modeState, mode, "manual");
  } else {
    mode = taskKindToMode(taskKind);
    if (state.modeState.activeMode !== mode) {
      state.modeState = enterMode(state.modeState, mode, "auto");
    }
  }

  // Emit mode_change event if mode transitioned
  if (previousMode !== state.modeState.activeMode && options?.agentId) {
    const event = createModeChangeEvent(
      options.agentId,
      previousMode,
      state.modeState.activeMode,
      { conversationId: options.conversationId },
    );
    state.turnEvents.push(event);
  }

  // 3. Compile EIM context
  const eimSlice = compileEIMContext(
    state.eimConfig,
    taskKind,
    options?.activeMode,
  );

  // 4. Render EIM fragments
  const eimFragments = compileEIMPromptFragments(eimSlice);

  // 5. Select model
  const modelResult = routeModel(taskKind, {
    mode,
    preferredModel: options?.preferredModel,
  });

  // Store model selection on state (informational)
  state.modelSelection = {
    model: modelResult.model.id,
    reason: modelResult.reason,
  };

  // 6. Compute context budget (informational)
  state.contextBudget = calculateBudget(
    modelResult.model.capabilities.contextWindow,
  );

  // 7. Retrieve relevant memories from continuity core
  let memories: MemoryEntry[] | undefined;
  let retrievedMemories: string | undefined;
  if (options?.agentId) {
    try {
      memories = retrieveMemoriesForTurn(taskKind, options.agentId, {
        limit: 5,
      });
      if (memories.length > 0) {
        retrievedMemories = memories
          .map(
            (m) =>
              `[${m.frontmatter.type}] ${m.content} (${m.frontmatter.importance}, accessed ${m.frontmatter.accessCount}x)`,
          )
          .join("\n");
      }
    } catch {
      // Retrieval is best-effort
    }
  }

  // 8. Build context sections
  const contextSections = {
    identity: [
      eimFragments.styleDirective,
      eimFragments.boundariesDirective,
      eimFragments.continuityDirective,
    ]
      .filter(Boolean)
      .join("\n\n"),
    memoryHint: eimFragments.memoryRetrievalHint ?? "",
    retrievedMemories,
  };

  state.contextCompiled = true;
  state.turnCount++;

  return {
    contextSections,
    taskKind,
    mode,
    modelSelection: {
      model: modelResult.model.id,
      reason: modelResult.reason,
    },
    memories,
  };
}

/**
 * Post-turn hook result.
 */
export interface PostTurnHookResult {
  /** Memory candidates extracted (if any) */
  pipelineResults: PipelineResult[];
  /** Whether any candidates were queued for review */
  hasQueuedCandidates: boolean;
  /** Storage result (if persistence enabled) */
  storageResult?: StorageResult;
  /** Reflection result (if persistence enabled) */
  reflectionResult?: import("./memory/reflection").ReflectionResult;
}

/**
 * Run post-turn hook: extract memory candidates, run through pipeline, persist.
 */
export async function postTurnHook(
  conversationContext: {
    conversationId?: string;
    turnNumber: number;
    assistantMessage?: string;
    userMessage?: string;
    agentId?: string;
  },
  state: LanternRuntimeState,
  options?: {
    /** Enable persistence to continuity core */
    persist?: boolean;
  },
): Promise<PostTurnHookResult> {
  const candidates: PipelineResult[] = [];

  // Extract potential memory from assistant message (reflections, observations)
  if (conversationContext.assistantMessage) {
    const result = processCandidate(
      { content: conversationContext.assistantMessage },
      {
        conversationId: conversationContext.conversationId,
        turnNumber: conversationContext.turnNumber,
      },
    );
    if (result.decision !== "rejected") {
      candidates.push(result);
    }
  }

  // Extract potential memory from user message (preferences, facts)
  if (conversationContext.userMessage) {
    const result = processCandidate(
      { content: conversationContext.userMessage },
      {
        conversationId: conversationContext.conversationId,
        turnNumber: conversationContext.turnNumber,
      },
    );
    if (result.decision !== "rejected") {
      candidates.push(result);
    }
  }

  state.lastPipelineResults = candidates;

  // Persist to continuity core if enabled
  let storageResult: StorageResult | undefined;
  if (
    options?.persist &&
    candidates.length > 0 &&
    conversationContext.agentId
  ) {
    storageResult = storePipelineResults(
      candidates,
      undefined, // use default config
      conversationContext.agentId,
      conversationContext.conversationId,
      conversationContext.turnNumber,
    );
  }

  // Run reflection cycle after persistence
  let reflectionResult:
    | import("./memory/reflection").ReflectionResult
    | undefined;
  if (options?.persist && conversationContext.agentId) {
    const { runReflectionCycle } = await import("./memory/reflection");
    reflectionResult = runReflectionCycle({
      turnEvents: state.turnEvents,
      agentId: conversationContext.agentId,
      conversationId: conversationContext.conversationId,
      turnsSinceLastReflection: state.turnsSinceLastReflection ?? 0,
    });
    if (reflectionResult.ran) {
      state.turnsSinceLastReflection = 0;
    } else {
      state.turnsSinceLastReflection =
        (state.turnsSinceLastReflection ?? 0) + 1;
    }
  }

  return {
    pipelineResults: candidates,
    hasQueuedCandidates: candidates.some((c) => c.decision === "queued"),
    storageResult,
    reflectionResult,
  };
}

// ============================================================================
// Tool Call Wrappers
// ============================================================================

/**
 * Check if a tool call is allowed given current state.
 */
export function checkToolPermission(
  toolName: string,
  state: LanternRuntimeState,
): { allowed: boolean; reason: string } {
  const mode = state.modeState.activeMode;

  // Check mode-level tool access
  if (!isToolAllowed(toolName, mode, state.modeState)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" not available in ${mode} mode`,
    };
  }

  // Check governance permission
  const permCheck = hasPermission("user", "tool_execute", { tool: toolName });
  if (!permCheck.allowed) {
    // Log the denial
    logAuditEvent({
      action: "tool_execute",
      actor: "user",
      target: toolName,
      result: "denied",
      requiredLevel: permCheck.requiredLevel,
      reason: permCheck.reason,
      severity: "warning",
    });

    return {
      allowed: false,
      reason: `Permission denied: ${permCheck.reason}`,
    };
  }

  return { allowed: true, reason: "Allowed" };
}

/**
 * Log a tool call event.
 */
export function logToolCall(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  durationMs: number,
  agentId: string,
  conversationId?: string,
): AgentEvent {
  const event = createToolCallEvent(
    agentId,
    toolName,
    args,
    result,
    durationMs,
    { conversationId },
  );

  // Also log to audit
  logAuditEvent({
    action: "tool_execute",
    actor: "user",
    target: toolName,
    result: "allowed",
    requiredLevel: "none",
    reason: `Tool call completed in ${durationMs}ms`,
    severity: "info",
    metadata: { eventId: event.id },
  });

  return event;
}

/**
 * Log a memory write event.
 */
export function logMemoryWrite(
  agentId: string,
  path: string,
  operation: "create" | "update" | "delete",
  before?: string,
  after?: string,
  conversationId?: string,
): AgentEvent {
  const event = createMemoryWriteEvent(
    agentId,
    path,
    operation,
    before,
    after,
    { conversationId },
  );

  // Also log to audit
  logAuditEvent({
    action: "memory_write",
    actor: "user",
    target: path,
    result: "allowed",
    requiredLevel: "none",
    reason: `Memory ${operation} on ${path}`,
    severity: "info",
    metadata: { eventId: event.id },
  });

  return event;
}

/**
 * Log a memory read event.
 */
export function logMemoryRead(
  agentId: string,
  path: string,
  conversationId?: string,
): AgentEvent {
  return createMemoryReadEvent(agentId, path, { conversationId });
}

// ============================================================================
// Prompt Augmentation
// ============================================================================

/**
 * Augment a base system prompt with Lantern Shell context.
 */
export function augmentSystemPrompt(
  basePrompt: string,
  contextSections: PreTurnHookResult["contextSections"],
): string {
  const sections: string[] = [];

  // Add identity section if present
  if (contextSections.identity.trim()) {
    sections.push(contextSections.identity);
  }

  // Add memory hint if present
  if (contextSections.memoryHint.trim()) {
    sections.push(contextSections.memoryHint);
  }

  if (sections.length === 0) {
    return basePrompt;
  }

  // Append to base prompt
  return `${basePrompt.trimEnd()}\n\n---\n\n## Lantern Shell Context\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Mode Management
// ============================================================================

/**
 * Enter a specific operation mode.
 */
export function setOperationMode(
  mode: OperationMode,
  state: LanternRuntimeState,
  reason: "manual" | "auto" = "manual",
): { success: boolean; previousMode: OperationMode } {
  const previousMode = state.modeState.activeMode;
  state.modeState = enterMode(state.modeState, mode, reason);
  return { success: true, previousMode };
}

/**
 * Exit current mode (return to previous or default).
 */
export function clearOperationMode(state: LanternRuntimeState): OperationMode {
  state.modeState = exitMode(state.modeState);
  return state.modeState.activeMode;
}

/**
 * Get current mode.
 */
export function getCurrentMode(state: LanternRuntimeState): OperationMode {
  return state.modeState.activeMode;
}

// ============================================================================
// Event Collection
// ============================================================================

/**
 * Collect an event into the turn's event buffer.
 * Events are flushed to the audit log on end_turn.
 */
export function collectEvent(
  state: LanternRuntimeState,
  event: AgentEvent,
): void {
  state.turnEvents.push(event);
}

/**
 * Flush collected turn events to the audit log and clear the buffer.
 * Called after end_turn. Returns the number of events flushed.
 */
export function flushTurnEvents(state: LanternRuntimeState): number {
  const count = state.turnEvents.length;
  // Events are already created with proper timestamps — the audit log
  // is in-memory, so we just log a summary audit entry for the batch.
  if (count > 0) {
    logAuditEvent({
      action: "tool_execute",
      actor: "system",
      target: "lantern_shell",
      result: "allowed",
      requiredLevel: "none",
      reason: `Flushed ${count} Lantern Shell events from turn ${state.turnCount}`,
      severity: "info",
      metadata: {
        eventCount: count,
        eventTypes: state.turnEvents.map((e) => e.type),
      },
    });
    state.turnEvents = [];
  }
  return count;
}

// ============================================================================
// Status Reporting
// ============================================================================

/**
 * Get a human-readable status summary of the Lantern Shell state.
 * Used by the /lantern command.
 */
export function getLanternStatus(state: LanternRuntimeState): string {
  const lines: string[] = [];

  lines.push("Lantern Shell Status");
  lines.push("====================");
  lines.push("");
  lines.push(`Mode:          ${state.modeState.activeMode}`);
  lines.push(`Mode reason:   ${state.modeState.enterReason}`);
  lines.push(`Previous mode: ${state.modeState.previousMode ?? "(none)"}`);
  lines.push(`Task kind:     ${state.currentTaskKind}`);
  lines.push(`Turn count:    ${state.turnCount}`);
  lines.push(
    `Context:       ${state.contextCompiled ? "compiled" : "not compiled"}`,
  );

  if (state.modelSelection) {
    lines.push(`Model:         ${state.modelSelection.model}`);
    lines.push(`Model reason:  ${state.modelSelection.reason}`);
  } else {
    lines.push("Model:         (not yet selected)");
  }

  if (state.contextBudget) {
    lines.push(
      `Budget total:  ${state.contextBudget.totalTokens.toLocaleString()} tokens`,
    );
    lines.push(
      `  identity:    ${state.contextBudget.identityBudget.toLocaleString()}`,
    );
    lines.push(
      `  memory:      ${state.contextBudget.memoryBudget.toLocaleString()}`,
    );
    lines.push(
      `  conversation:${state.contextBudget.conversationBudget.toLocaleString()}`,
    );
    lines.push(
      `  tools:       ${state.contextBudget.toolBudget.toLocaleString()}`,
    );
  } else {
    lines.push("Budget:        (not yet computed)");
  }

  const pipelineCount = state.lastPipelineResults.length;
  if (pipelineCount > 0) {
    const queued = state.lastPipelineResults.filter(
      (r) => r.decision === "queued",
    ).length;
    const approved = state.lastPipelineResults.filter(
      (r) => r.decision === "approved",
    ).length;
    lines.push(
      `Pipeline:      ${pipelineCount} candidates (${approved} approved, ${queued} queued)`,
    );
  } else {
    lines.push("Pipeline:      no candidates from last turn");
  }

  lines.push(`Events:        ${state.turnEvents.length} collected this turn`);

  return lines.join("\n");
}
