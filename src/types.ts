/**
 * Shared types for the Jev router plugin.
 *
 * A route is a choice between (model, reasoning effort) pairs. Everything the
 * router needs to justify a choice travels in the receipt, including the full
 * distribution over candidates, so a recorded run can be re-scored under a
 * different cost preference without calling Jev again.
 *
 * @module dsh-plugin-jev-router/types
 */

/** A routing target as written in config. */
export interface CandidateSpec {
  /** Model identifier understood by the harness. */
  model: string
  /** Reasoning effort level understood by the harness. */
  effort: string
  /** Cost per million input tokens in USD. Default: 0. */
  costPerMTokIn?: number
  /** Cost per million output tokens in USD. Default: 0. */
  costPerMTokOut?: number
}

/** A routing target with a derived label, cost estimate and rank. */
export interface Candidate {
  model: string
  effort: string
  costPerMTokIn: number
  costPerMTokOut: number
  /** `model@effort`, the label sent to Jev and written to receipts. */
  label: string
  /** Position in the configured candidate list. */
  index: number
  /** Estimated cost of one turn at the configured token profile, in USD. */
  effectiveCost: number
  /** 0 for the cheapest candidate. Ties break in configuration order. */
  rank: number
}

/** What the router knows about one turn. */
export interface TurnSummary {
  /** The user request for this turn. */
  request: string
  /** Short digest of recent tool activity, including command output. */
  digest?: string
}

/** Why a candidate was chosen. */
export type RouteReason = 'fast-path' | 'escalation' | 'sticky' | 'jev' | 'fallback'

/** Every route reason, in report order. */
export const ROUTE_REASONS = ['fast-path', 'escalation', 'sticky', 'jev', 'fallback'] as const

/** The outcome of routing one turn. */
export interface RouteDecision {
  /** 1-based turn counter within the routing session. */
  turn: number
  candidate: Candidate
  reason: RouteReason
  /** Calibrated confidence reported by Jev, or null when Jev was not asked. */
  confidence: number | null
  /** Probability per candidate in configured order, or null when Jev was not asked. */
  distribution: number[] | null
  /** Candidate table the decision was made over. */
  candidates: Candidate[]
  /** Turns left in the sticky hold after this decision. */
  stickyRemaining: number
  /** Pattern sources that triggered escalation. */
  escalations: string[]
  /** Jev round trip in milliseconds, 0 when Jev was not asked. */
  latencyMs: number
  /** Estimated cost of this turn in USD. */
  cost: number
  /** Estimated cost of this turn on the default candidate, in USD. */
  baselineCost: number
  /** Why Jev was not used, or why the confidence gate rejected its answer. */
  error: string | null
}

/** A candidate as recorded in a receipt. */
export interface ReceiptCandidate {
  label: string
  costPerMTokIn: number
  costPerMTokOut: number
  /** Estimated cost of one turn on this candidate in USD. */
  effectiveCost: number
}

/** One recorded routing decision. */
export interface Receipt {
  /** ISO timestamp written when the decision was made. */
  ts: string
  turn: number
  /** First 16 hex characters of the SHA-256 of the summary. */
  hash: string
  /** UTF-8 size of the summary that was routed. */
  bytes: number
  reason: RouteReason
  /** Label of the chosen candidate. */
  chosen: string
  /** Index of the chosen candidate in `candidates`. */
  chosenIndex: number
  /** Jev confidence, or null when Jev was not asked. */
  confidence: number | null
  /** Probability per candidate, or null when Jev was not asked. */
  distribution: number[] | null
  candidates: ReceiptCandidate[]
  /** Label of the configured default candidate, the cost baseline. */
  defaultLabel: string
  /** Token profile the cost estimate used. */
  tokens: { in: number; out: number }
  latencyMs: number
  /** Estimated cost of the chosen candidate for this turn, in USD. */
  cost: number
  /** Estimated cost of the default candidate for this turn, in USD. */
  baselineCost: number
  /** Pattern sources that triggered escalation. */
  escalations: string[]
  error: string | null
}

/** Aggregate routing metrics over a set of receipts. */
export interface RouteMetrics {
  turns: number
  byReason: Record<RouteReason, number>
  /** Share of turns that fell back to the default candidate. */
  fallbackRate: number
  /** Estimated cost of the routed turns in USD. */
  cost: number
  /** Estimated cost of the same turns on the default candidate, in USD. */
  baselineCost: number
  savedCost: number
  savedPct: number
  meanLatencyMs: number
  /** Mean Jev confidence over the turns that asked Jev, or null. */
  meanConfidence: number | null
}

/** Cost preference applied when replaying recorded distributions. */
export type Preference = 'cheap' | 'quality'

/** One decision that a replay pass would change. */
export interface ReplayChange {
  turn: number
  from: string
  to: string
  fromCost: number
  toCost: number
  delta: number
}

/** Result of a replay pass over recorded distributions. */
export interface ReplayResult {
  preference: Preference
  /** Cost weight used by the replay utility. */
  lambda: number
  turns: number
  /** Turns that carried a distribution and could be re-scored. */
  replayed: number
  unchanged: number
  changes: ReplayChange[]
  /** Cost of the replayed choices in USD. */
  cost: number
  /** Cost of the choices that were actually taken in USD. */
  recordedCost: number
  deltaCost: number
  deltaPct: number
}
