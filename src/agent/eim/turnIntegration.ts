/**
 * EIM Turn Integration — bridges the EIM pipeline to the turn loop.
 *
 * This module provides the thin adapter that takes a user message,
 * runs it through the EIM context compilation pipeline, and produces
 * a system-reminder block that can be prepended to the user message
 * before it's sent to the Letta API.
 *
 * It also resolves the operation mode for the current task and includes
 * mode-specific tool access directives in the injected context.
 *
 * This follows the same pattern as the reminder injection in
 * `src/reminders/engine.ts` — EIM directives travel as a
 * `<system-reminder>` block in the user message, not as a
 * modification to the server-side system prompt.
 */

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../../constants";
import { classifyTask } from "../context/compiler";
import {
  getModeDefinitionFromState,
  type ModeState,
  type OperationMode,
  taskKindToMode,
} from "../modes/types";
import { compileEIMPromptFragments } from "./compiler";
import type { EIMConfig, TaskKind } from "./types";
import { compileEIMContext, DEFAULT_EIM_CONFIG } from "./types";

// ============================================================================
// Turn Context Compilation
// ============================================================================

/**
 * Options for compiling EIM turn context.
 */
export interface CompileEIMTurnContextOptions {
  /** The EIM configuration. If not provided, uses DEFAULT_EIM_CONFIG. */
  eimConfig?: EIMConfig;
  /** Override the task kind (skip heuristic classification). */
  taskKindOverride?: TaskKind;
  /** Active mode name (for mode-specific overrides). */
  activeMode?: string;
  /** Current mode state (for mode resolution and tool access directives). */
  modeState?: ModeState;
}

/**
 * Result of compiling EIM turn context, including mode resolution.
 */
export interface CompileEIMTurnContextResult {
  /** The system-reminder string to prepend, or null if nothing to inject. */
  eimContext: string | null;
  /** The resolved task kind. */
  taskKind: TaskKind;
  /** The resolved operation mode. */
  resolvedMode: OperationMode;
  /** EIM-resolved memory type priority for retrieval (overrides taxonomy defaults). */
  memoryTypePriority: string[];
}

/**
 * Render a tool access directive from a mode definition.
 */
function renderToolAccessDirective(
  mode: OperationMode,
  modeState: ModeState,
): string {
  const definition = getModeDefinitionFromState(mode, modeState);
  if (!definition) return "";

  const { tools } = definition;
  const lines: string[] = [];

  if (
    tools.disallowedTools.length > 0 &&
    !tools.disallowedTools.includes("*")
  ) {
    lines.push(`Restricted tools: ${tools.disallowedTools.join(", ")}`);
  } else if (tools.disallowedTools.includes("*")) {
    lines.push("All tools restricted in this mode");
  }

  if (tools.allowedTools.length > 0 && !tools.allowedTools.includes("*")) {
    lines.push(`Available tools: ${tools.allowedTools.join(", ")}`);
  }

  lines.push(
    tools.bashAllowed
      ? tools.bashRequiresApproval
        ? "Bash: allowed (requires approval)"
        : "Bash: allowed (auto-approved)"
      : "Bash: disallowed",
  );

  lines.push(
    tools.writesRequireApproval
      ? "File writes: require approval"
      : "File writes: auto-approved",
  );

  return lines.join("\n");
}

/**
 * Compile EIM context for a turn and return a system-reminder string.
 *
 * This is the main entry point for the turn integration. It:
 * 1. Classifies the task kind from the user message
 * 2. Resolves the operation mode for the task
 * 3. Compiles the EIM context slice
 * 4. Renders EIM prompt fragments
 * 5. Appends mode-specific tool access directives
 * 6. Wraps everything in a `<system-reminder>` block
 *
 * Returns a result with `eimContext: null` if:
 * - The compiled fragments are all empty
 * - The task kind is "casual" and no mode override is active
 *   (casual tasks get full persona, so EIM directives are redundant)
 *
 * @param userMessage - The user's message text (for task classification)
 * @param options - Compilation options
 * @returns A result with the system-reminder string and mode info
 */
export function compileEIMTurnContext(
  userMessage: string,
  options?: CompileEIMTurnContextOptions,
): CompileEIMTurnContextResult {
  const config = options?.eimConfig ?? DEFAULT_EIM_CONFIG;
  const taskKind: TaskKind =
    options?.taskKindOverride ?? classifyTask(userMessage);

  // Resolve operation mode from task kind
  const resolvedMode = taskKindToMode(taskKind);

  // Compile EIM context slice
  const eimSlice = compileEIMContext(config, taskKind, options?.activeMode);

  // Render EIM prompt fragments
  const fragments = compileEIMPromptFragments(eimSlice);

  // Collect non-empty fragments
  const parts: string[] = [];

  if (fragments.styleDirective.trim()) {
    parts.push(fragments.styleDirective);
  }

  if (fragments.boundariesDirective.trim()) {
    parts.push(fragments.boundariesDirective);
  }

  if (fragments.continuityDirective.trim()) {
    parts.push(fragments.continuityDirective);
  }

  if (fragments.memoryRetrievalHint.trim()) {
    parts.push(fragments.memoryRetrievalHint);
  }

  // Add mode-specific tool access directive when mode state is available
  if (options?.modeState) {
    const toolDirective = renderToolAccessDirective(
      resolvedMode,
      options.modeState,
    );
    if (toolDirective.trim()) {
      parts.push(`## Tool Access (${resolvedMode} mode)\n${toolDirective}`);
    }
  }

  // No useful directives — skip injection
  if (parts.length === 0) {
    return {
      eimContext: null,
      taskKind,
      resolvedMode,
      memoryTypePriority: eimSlice.memoryTypePriority,
    };
  }

  // Wrap in system-reminder tags
  const body = parts.join("\n\n");
  return {
    eimContext: `${SYSTEM_REMINDER_OPEN}\n${body}\n${SYSTEM_REMINDER_CLOSE}`,
    taskKind,
    resolvedMode,
    memoryTypePriority: eimSlice.memoryTypePriority,
  };
}

// ============================================================================
// Message Content Injection
// ============================================================================

/**
 * EIM context as a content part for injection.
 */
export interface EIMContextPart {
  type: "text";
  text: string;
}

/**
 * Prepend EIM context to a message's content.
 *
 * Follows the same pattern as `prependReminderPartsToContent` —
 * the EIM block is added as the first content part so the model
 * sees it before the actual user message.
 *
 * @param content - The original message content (string or array of parts)
 * @param eimContext - The EIM system-reminder string
 * @returns The modified content with EIM context prepended
 */
export function prependEIMContext(
  content: MessageCreate["content"],
  eimContext: string,
): MessageCreate["content"] {
  if (!eimContext) {
    return content;
  }

  const eimPart: EIMContextPart = { type: "text", text: eimContext };

  if (typeof content === "string") {
    return [
      eimPart,
      { type: "text", text: content },
    ] as MessageCreate["content"];
  }

  if (Array.isArray(content)) {
    return [eimPart, ...content] as MessageCreate["content"];
  }

  return content;
}

// ============================================================================
// Task Classification (re-export for convenience)
// ============================================================================

export { classifyTask } from "../context/compiler";
export type { ModeState, OperationMode } from "../modes/types";
export type { TaskKind } from "./types";
