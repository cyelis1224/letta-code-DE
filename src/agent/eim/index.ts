/**
 * EIM module — Emulated Identity Model for structured agent identity.
 *
 * The EIM provides queryable, composable identity fields alongside the
 * prose persona. The context compiler selectively loads EIM fields based
 * on the current task and mode, instead of always loading the full persona.
 *
 * Storage: EIM config is serialized as YAML frontmatter in `system/eim.md`
 * in the memory filesystem. The prose persona remains in `system/persona.md`.
 */

export type { EIMPromptFragments } from "./compiler";
export {
  compileEIMPromptFragments,
  renderBoundariesDirective,
  renderCompressedPersona,
  renderContinuityDirective,
  renderMemoryRetrievalHint,
  renderStyleDirective,
} from "./compiler";
export { deserializeEIMConfig, serializeEIMConfig } from "./serializer";
export type {
  ContinuityPriority,
  EIMBoundaries,
  EIMConfig,
  EIMContextSlice,
  EIMModeOverride,
  EIMRole,
  EIMStyle,
  TaskKind,
} from "./types";
export {
  compileEIMContext,
  DEFAULT_CONTINUITY_PRIORITIES,
  DEFAULT_EIM_BOUNDARIES,
  DEFAULT_EIM_CONFIG,
  DEFAULT_EIM_STYLE,
} from "./types";
