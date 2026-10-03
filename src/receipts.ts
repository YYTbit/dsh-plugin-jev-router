/**
 * Routing receipts.
 *
 * A receipt records the summary hash, the chosen candidate, the full
 * distribution Jev returned, the confidence, the route reason and the cost
 * estimate for one turn. Storing the distribution is the point: a different
 * cost preference can be re-applied over the same recorded decisions with no
 * model call at all, which is what `jev-route replay` does.
 *
 * Receipts never contain the turn text itself, only its hash and its size, so
 * a log can be shared for analysis without exposing the conversation.
 *
 * @module dsh-plugin-jev-router/receipts
 */

import { appendFile, readFile } from 'node:fs/promises'
import { byteLength, hashText } from './text.js'
import { ROUTE_REASONS } from './types.js'
import type {
  Preference,
  Receipt,
  ReplayChange,
  ReplayResult,
  RouteDecision,
  RouteMetrics,
  RouteReason,
  TurnSummary,
} from './types.js'

/** Append-only JSONL receipt writer. */
export class ReceiptLog {
  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  /** Append one receipt. Returns an error message instead of throwing. */
  async append(receipt: Receipt): Promise<string | null> {
    try {
      await appendFile(this.path, `${JSON.stringify(receipt)}\n`, 'utf8')
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
}

/** Build the receipt for one decision. */
export function buildReceipt(
  decision: RouteDecision,
  summary: TurnSummary,
  defaultLabel: string,
  tokens: { in: number; out: number },
): Receipt {
  const text = summary.digest ? `${summary.request}\n${summary.digest}` : summary.request
  return {
    ts: new Date().toISOString(),
    turn: decision.turn,
    hash: hashText(text),
    bytes: byteLength(text),
    reason: decision.reason,
    chosen: decision.candidate.label,
    chosenIndex: decision.candidate.index,
    confidence: decision.confidence,
    distribution: decision.distribution,
    candidates: decision.candidates.map(candidate => ({
      label: candidate.label,
      costPerMTokIn: candidate.costPerMTokIn,
      costPerMTokOut: candidate.costPerMTokOut,
      effectiveCost: candidate.effectiveCost,
    })),
    defaultLabel,
    tokens,
    latencyMs: decision.latencyMs,
    cost: decision.cost,
    baselineCost: decision.baselineCost,
    escalations: decision.escalations,
    error: decision.error,
  }
}

/** Read a JSONL receipt file, skipping lines that do not parse. */
export async function readReceipts(path: string): Promise<{ receipts: Receipt[]; skipped: number }> {
  const raw = await readFile(path, 'utf8')
  const receipts: Receipt[] = []
  let skipped = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed) as Receipt
      if (parsed && typeof parsed === 'object' && typeof parsed.reason === 'string') {
        receipts.push(parsed)
      } else {
        skipped += 1
      }
    } catch {
      skipped += 1
    }
  }
  return { receipts, skipped }
}

/** Empty reason counters. */
function emptyCounts(): Record<RouteReason, number> {
  const counts = {} as Record<RouteReason, number>
  for (const reason of ROUTE_REASONS) counts[reason] = 0
  return counts
}

/** Aggregate counts, cost and latency over a set of receipts. */
export function computeMetrics(receipts: Receipt[]): RouteMetrics {
  const byReason = emptyCounts()
  let cost = 0
  let baselineCost = 0
  let latency = 0
  let confidenceSum = 0
  let confidenceCount = 0

  for (const receipt of receipts) {
    if (byReason[receipt.reason] === undefined) byReason[receipt.reason] = 0
    byReason[receipt.reason] += 1
    if (Number.isFinite(receipt.cost)) cost += receipt.cost
    if (Number.isFinite(receipt.baselineCost)) baselineCost += receipt.baselineCost
    if (Number.isFinite(receipt.latencyMs)) latency += receipt.latencyMs
    if (receipt.confidence !== null && Number.isFinite(receipt.confidence)) {
      confidenceSum += receipt.confidence
      confidenceCount += 1
    }
  }

  const turns = receipts.length
  const savedCost = baselineCost - cost
  return {
    turns,
    byReason,
    fallbackRate: turns > 0 ? byReason.fallback / turns : 0,
    cost,
    baselineCost,
    savedCost,
    savedPct: baselineCost > 0 ? (savedCost / baselineCost) * 100 : 0,
    meanLatencyMs: turns > 0 ? latency / turns : 0,
    meanConfidence: confidenceCount > 0 ? confidenceSum / confidenceCount : null,
  }
}

/**
 * Re-apply a cost preference over recorded distributions.
 *
 * Every replayable turn carries the probability Jev assigned to each candidate
 * and the per-turn cost of each candidate, so the replayed choice is
 *
 *   argmax over i of  p(i) - lambda * (cost(i) / cost(max))
 *
 * with lambda 0 for `quality` and the configured cost aversion for `cheap`.
 * Both terms are dimensionless and live in [0, 1], so the weight states
 * directly how many units of probability one unit of relative cost is worth.
 * Turns that never asked Jev carry no distribution and keep their choice.
 */
export function replayReceipts(
  receipts: Receipt[],
  preference: Preference,
  lambda: number,
): ReplayResult {
  const weight = preference === 'quality' ? 0 : lambda
  const changes: ReplayChange[] = []
  let replayed = 0
  let unchanged = 0
  let cost = 0
  let recordedCost = 0

  for (const receipt of receipts) {
    const candidates = Array.isArray(receipt.candidates) ? receipt.candidates : []
    const distribution = receipt.distribution
    const recordedCostForTurn = Number.isFinite(receipt.cost)
      ? receipt.cost
      : (candidates[receipt.chosenIndex]?.effectiveCost ?? 0)
    recordedCost += recordedCostForTurn

    const replayable = distribution !== null
      && Array.isArray(distribution)
      && distribution.length === candidates.length
      && candidates.length > 0

    if (!replayable) {
      unchanged += 1
      cost += recordedCostForTurn
      continue
    }

    replayed += 1
    const maxCost = Math.max(...candidates.map(candidate => candidate.effectiveCost), 0)
    let bestIndex = 0
    let bestScore = Number.NEGATIVE_INFINITY
    for (let i = 0; i < candidates.length; i += 1) {
      const share = maxCost > 0 ? candidates[i].effectiveCost / maxCost : 0
      const score = distribution[i] - weight * share
      if (score > bestScore) {
        bestScore = score
        bestIndex = i
      }
    }

    cost += candidates[bestIndex].effectiveCost
    if (bestIndex === receipt.chosenIndex) {
      unchanged += 1
      continue
    }

    changes.push({
      turn: receipt.turn,
      from: receipt.chosen,
      to: candidates[bestIndex].label,
      fromCost: recordedCostForTurn,
      toCost: candidates[bestIndex].effectiveCost,
      delta: candidates[bestIndex].effectiveCost - recordedCostForTurn,
    })
  }

  const deltaCost = cost - recordedCost
  return {
    preference,
    lambda: weight,
    turns: receipts.length,
    replayed,
    unchanged,
    changes,
    cost,
    recordedCost,
    deltaCost,
    deltaPct: recordedCost > 0 ? (deltaCost / recordedCost) * 100 : 0,
  }
}
