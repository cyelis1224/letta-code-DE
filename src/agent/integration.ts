/**
 * Integration — wires the Lantern Shell modules into the agent runtime.
 *
 * This module provides:
 * - Prompt augmentation with context compiler output
 * - Turn-level hooks for memory pipeline and mode tracking
 * - Tool call wrappers for event logging and governance
 * - Memory tool integration with the lifecycle pipeline
 */

import { classifyTask } from "./context/compiler";
import { compileEIMPromptFragments } from "./eim/compiler";
import type { EIMConfig, TaskKind } from "./eim/types";
import { compileEIMContext, DEFAULT_EIM_CONFIG } from "./eim/types";
import {
  createMemoryReadEvent,
  createMemoryWriteEvent,
  createToolCallEvent,
} from "./events/instrumentation";
import type { AgentEvent } from "./events/types";
import {
  type ActionCategory,
  hasPermission,
  logAuditEvent,
} from "./governance/rbac";
import { type PipelineResult, processCandidate } from "./memory/pipeline";
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
  },
): PreTurnHookResult {
  // 1. Classify task
  const taskKind = classifyTask(userMessage);
  state.currentTaskKind = taskKind;

  // 2. Determine operation mode
  let mode: OperationMode;
  if (options?.activeMode) {
    mode = options.activeMode;
    state.modeState = enterMode(state.modeState, mode, "manual");
  } else {
    mode = taskKindToMode(taskKind);
    if (state.modeState.activeMode !== mode) {
      state.modeState = enterMode(state.modeState, mode, "auto");
    }
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

  // 6. Build context sections
  const contextSections = {
    identity: [
      eimFragments.styleDirective,
      eimFragments.boundariesDirective,
      eimFragments.continuityDirective,
    ]
      .filter(Boolean)
      .join("\n\n"),
    memoryHint: eimFragments.memoryRetrievalHint ?? "",
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
}

/**
 * Run post-turn hook: extract memory candidates, run through pipeline.
 */
export function postTurnHook(
  conversationContext: {
    conversationId?: string;
    turnNumber: number;
    assistantMessage?: string;
    userMessage?: string;
  },
  state: LanternRuntimeState,
): PostTurnHookResult {
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

  return {
    pipelineResults: candidates,
    hasQueuedCandidates: candidates.some((c) => c.decision === "queued"),
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
