/**
 * Memory Lifecycle Pipeline — async post-turn memory processing.
 *
 * The pipeline runs after each turn (in reflection hooks) and:
 * 1. Extracts memory candidates from the conversation
 * 2. Classifies each candidate (type, sensitivity, importance)
 * 3. Scores candidates for storage worthiness
 * 4. Routes to review queue or auto-approves
 * 5. Detects contradictions with existing memories
 *
 * This module provides the core pipeline logic. The actual integration
 * with the agent turn loop happens in Phase 4 (context compiler).
 */

import type { ClassificationResult, MemoryCandidate } from "./classifier";
import { heuristicClassifyMemory } from "./classifier";
import type { MemorySensitivity, MemoryType } from "./taxonomy";

// ============================================================================
// Memory Candidate (extended for pipeline)
// ============================================================================

/**
 * A memory candidate with pipeline-specific metadata.
 */
export interface PipelineCandidate extends MemoryCandidate {
  /** Unique ID for tracking through the pipeline */
  id: string;
  /** When this candidate was created */
  createdAt: string;
  /** Source of the candidate (conversation turn, reflection, etc.) */
  source: "conversation" | "reflection" | "manual" | "import";
  /** Conversation ID where this candidate originated */
  conversationId?: string;
  /** Turn number where this candidate originated */
  turnNumber?: number;
}

// ============================================================================
// Scoring
// ============================================================================

/**
 * Factors that affect a candidate's storage score.
 */
export interface ScoringFactors {
  /** Is this information new or already known? (0-1) */
  novelty: number;
  /** Is this information actionable or useful? (0-1) */
  utility: number;
  /** How confident is the classification? (0-1) */
  classificationConfidence: number;
  /** Does this contradict existing memories? (0-1) */
  contradictionRisk: number;
  /** Is this time-sensitive or likely to become stale? (0-1) */
  stalenessRisk: number;
}

/**
 * The result of scoring a memory candidate.
 */
export interface ScoringResult {
  /** Overall score (0-1) — higher is more likely to be stored */
  score: number;
  /** Breakdown of scoring factors */
  factors: ScoringFactors;
  /** Whether this candidate should be auto-approved */
  autoApprove: boolean;
  /** Reason for the scoring decision */
  reason: string;
}

/**
 * Thresholds for auto-approval.
 */
const AUTO_APPROVE_THRESHOLDS = {
  /** Minimum score for auto-approval */
  minScore: 0.6,
  /** Maximum sensitivity for auto-approval (public only) */
  maxSensitivity: "public" as MemorySensitivity,
  /** Minimum classification confidence for auto-approval */
  minConfidence: 0.7,
  /** Maximum contradiction risk for auto-approval */
  maxContradictionRisk: 0.3,
};

/**
 * Score a memory candidate for storage worthiness.
 */
export function scoreCandidate(
  candidate: PipelineCandidate,
  classification: ClassificationResult,
  existingMemories?: string[],
): ScoringResult {
  const factors: ScoringFactors = {
    novelty: 0.5, // Default: unknown
    utility: 0.5,
    classificationConfidence: classification.confidence,
    contradictionRisk: 0,
    stalenessRisk: 0.3,
  };

  // Novelty: check if similar content exists
  if (existingMemories && existingMemories.length > 0) {
    const contentLower = candidate.content.toLowerCase();
    let maxSimilarity = 0;
    for (const existing of existingMemories) {
      const existingLower = existing.toLowerCase();
      // Simple word overlap similarity
      const contentWords = new Set(contentLower.split(/\s+/));
      const existingWords = new Set(existingLower.split(/\s+/));
      const intersection = [...contentWords].filter((w) =>
        existingWords.has(w),
      ).length;
      const union = new Set([...contentWords, ...existingWords]).size;
      const similarity = union > 0 ? intersection / union : 0;
      maxSimilarity = Math.max(maxSimilarity, similarity);
    }
    factors.novelty = 1 - maxSimilarity;
    factors.contradictionRisk = maxSimilarity > 0.7 ? 0.5 : 0;
  } else {
    factors.novelty = 1; // All new when no existing memories
  }

  // Utility: based on memory type
  const utilityByType: Partial<Record<MemoryType, number>> = {
    relationship: 0.9, // High utility for rapport
    procedural: 0.85, // High utility for workflows
    project: 0.8, // High utility for project state
    semantic: 0.7, // Medium utility for facts
    reflective: 0.75, // Good utility for self-improvement
    episodic: 0.5, // Lower utility for one-time events
  };
  factors.utility = utilityByType[classification.type] ?? 0.5;

  // Staleness risk: based on memory type
  const stalenessByType: Partial<Record<MemoryType, number>> = {
    episodic: 0.7, // Events become stale quickly
    project: 0.4, // Project state changes
    semantic: 0.2, // Facts stay relevant
    procedural: 0.2, // Procedures stay relevant
    relationship: 0.3, // Relationships evolve slowly
    reflective: 0.1, // Insights stay relevant
  };
  factors.stalenessRisk = stalenessByType[classification.type] ?? 0.3;

  // Calculate overall score (weighted average)
  const weights = {
    novelty: 0.2,
    utility: 0.3,
    classificationConfidence: 0.25,
    contradictionRisk: -0.15, // Negative weight
    stalenessRisk: -0.1, // Negative weight
  };

  let score = 0;
  score += factors.novelty * weights.novelty;
  score += factors.utility * weights.utility;
  score += factors.classificationConfidence * weights.classificationConfidence;
  score += factors.contradictionRisk * weights.contradictionRisk;
  score += factors.stalenessRisk * weights.stalenessRisk;

  // Normalize to 0-1
  score = Math.max(0, Math.min(1, score));

  // Determine auto-approval
  const autoApprove =
    score >= AUTO_APPROVE_THRESHOLDS.minScore &&
    classification.sensitivity === AUTO_APPROVE_THRESHOLDS.maxSensitivity &&
    classification.confidence >= AUTO_APPROVE_THRESHOLDS.minConfidence &&
    factors.contradictionRisk <= AUTO_APPROVE_THRESHOLDS.maxContradictionRisk;

  const reason = autoApprove
    ? "High confidence public memory with good novelty and utility"
    : score < AUTO_APPROVE_THRESHOLDS.minScore
      ? `Score ${score.toFixed(2)} below threshold ${AUTO_APPROVE_THRESHOLDS.minScore}`
      : classification.sensitivity !== "public"
        ? `Sensitivity ${classification.sensitivity} requires review`
        : classification.confidence < AUTO_APPROVE_THRESHOLDS.minConfidence
          ? `Low classification confidence (${classification.confidence.toFixed(2)})`
          : `Contradiction risk ${factors.contradictionRisk.toFixed(2)} exceeds threshold`;

  return { score, factors, autoApprove, reason };
}

// ============================================================================
// Pipeline Result
// ============================================================================

/**
 * The result of processing a single candidate through the pipeline.
 */
export interface PipelineResult {
  /** The original candidate */
  candidate: PipelineCandidate;
  /** The classification result */
  classification: ClassificationResult;
  /** The scoring result */
  scoring: ScoringResult;
  /** The final decision */
  decision: "approved" | "rejected" | "queued" | "conflict";
  /** If queued, the queue entry ID */
  queueEntryId?: string;
  /** If conflict, the conflicting memory path(s) */
  conflictingMemories?: string[];
  /** Reason for the decision */
  reason: string;
}

// ============================================================================
// Pipeline Execution
// ============================================================================

/**
 * Options for running the pipeline.
 */
export interface PipelineOptions {
  /** Existing memory content to check for contradictions */
  existingMemories?: string[];
  /** Whether to use LLM classification (slower but more accurate) */
  useLLMClassification?: boolean;
  /** Conversation ID for tracking */
  conversationId?: string;
  /** Turn number for tracking */
  turnNumber?: number;
}

let candidateIdCounter = 0;

/**
 * Generate a unique candidate ID.
 */
function generateCandidateId(): string {
  candidateIdCounter++;
  return `mem-candidate-${Date.now()}-${candidateIdCounter}`;
}

/**
 * Process a single memory candidate through the pipeline.
 */
export function processCandidate(
  candidate: MemoryCandidate,
  options: PipelineOptions = {},
): PipelineResult {
  // Create pipeline candidate with metadata
  const pipelineCandidate: PipelineCandidate = {
    ...candidate,
    id: generateCandidateId(),
    createdAt: new Date().toISOString(),
    source: options.conversationId ? "conversation" : "reflection",
    conversationId: options.conversationId,
    turnNumber: options.turnNumber,
  };

  // Classify the candidate
  const classification = options.useLLMClassification
    ? heuristicClassifyMemory(candidate) // TODO: add LLM classification
    : heuristicClassifyMemory(candidate);

  // Score the candidate
  const scoring = scoreCandidate(
    pipelineCandidate,
    classification,
    options.existingMemories,
  );

  // Make decision
  let decision: PipelineResult["decision"];
  let reason: string;
  let queueEntryId: string | undefined;
  let conflictingMemories: string[] | undefined;

  if (scoring.factors.contradictionRisk > 0.7) {
    decision = "conflict";
    reason = "High contradiction risk with existing memories";
    // TODO: identify specific conflicting memories
  } else if (scoring.autoApprove) {
    decision = "approved";
    reason = scoring.reason;
  } else if (scoring.score < 0.3) {
    decision = "rejected";
    reason = `Score ${scoring.score.toFixed(2)} too low for storage`;
  } else {
    decision = "queued";
    reason = scoring.reason;
    queueEntryId = `queue-${pipelineCandidate.id}`;
  }

  return {
    candidate: pipelineCandidate,
    classification,
    scoring,
    decision,
    queueEntryId,
    conflictingMemories,
    reason,
  };
}

/**
 * Process multiple candidates in batch.
 */
export function processCandidates(
  candidates: MemoryCandidate[],
  options: PipelineOptions = {},
): PipelineResult[] {
  return candidates.map((c) => processCandidate(c, options));
}

// ============================================================================
// Review Queue
// ============================================================================

/**
 * An entry in the review queue.
 */
export interface ReviewQueueEntry {
  /** Queue entry ID */
  id: string;
  /** The pipeline result that created this entry */
  result: PipelineResult;
  /** When this was added to the queue */
  queuedAt: string;
  /** Current status */
  status: "pending" | "approved" | "rejected" | "deferred";
  /** User who reviewed (if reviewed) */
  reviewedBy?: string;
  /** When reviewed */
  reviewedAt?: string;
  /** Review notes */
  reviewNotes?: string;
}

/**
 * In-memory review queue (for now — Phase 9 will add persistence).
 */
const reviewQueue: Map<string, ReviewQueueEntry> = new Map();

/**
 * Add a result to the review queue.
 */
export function enqueueForReview(result: PipelineResult): ReviewQueueEntry {
  const entry: ReviewQueueEntry = {
    id: result.queueEntryId ?? `queue-${result.candidate.id}`,
    result,
    queuedAt: new Date().toISOString(),
    status: "pending",
  };
  reviewQueue.set(entry.id, entry);
  return entry;
}

/**
 * Get all pending queue entries.
 */
export function getPendingReviews(): ReviewQueueEntry[] {
  return [...reviewQueue.values()].filter((e) => e.status === "pending");
}

/**
 * Get a specific queue entry.
 */
export function getQueueEntry(id: string): ReviewQueueEntry | undefined {
  return reviewQueue.get(id);
}

/**
 * Approve a queue entry.
 */
export function approveQueueEntry(
  id: string,
  reviewedBy?: string,
  notes?: string,
): ReviewQueueEntry | undefined {
  const entry = reviewQueue.get(id);
  if (!entry) return undefined;
  entry.status = "approved";
  entry.reviewedBy = reviewedBy;
  entry.reviewedAt = new Date().toISOString();
  entry.reviewNotes = notes;
  return entry;
}

/**
 * Reject a queue entry.
 */
export function rejectQueueEntry(
  id: string,
  reviewedBy?: string,
  notes?: string,
): ReviewQueueEntry | undefined {
  const entry = reviewQueue.get(id);
  if (!entry) return undefined;
  entry.status = "rejected";
  entry.reviewedBy = reviewedBy;
  entry.reviewedAt = new Date().toISOString();
  entry.reviewNotes = notes;
  return entry;
}

/**
 * Get queue statistics.
 */
export function getQueueStats(): {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
} {
  const entries = [...reviewQueue.values()];
  return {
    total: entries.length,
    pending: entries.filter((e) => e.status === "pending").length,
    approved: entries.filter((e) => e.status === "approved").length,
    rejected: entries.filter((e) => e.status === "rejected").length,
  };
}
