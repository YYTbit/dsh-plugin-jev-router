/**
 * The routing core.
 *
 * One turn is routed by the first rule that applies:
 *
 *   1. escalation   a pattern matched, so the turn is known hard and Jev is
 *                   not asked. The default candidate's model at its highest
 *                   configured effort takes it, and the hold is re-armed.
 *   2. fast path    the turn is short, opens with a read-only verb and asks
 *                   for no reasoning, so the cheapest candidate takes it.
 *   3. sticky       a previous expensive route is still held, so the same
 *                   candidate is served without asking Jev again.
 *   4. Jev          one choice question over the candidate labels. A
 *                   confidence at or above the gate takes the answer.
 *   5. fallback     a low-confidence answer, a network failure, a missing key
 *                   or a timeout sends the turn to the default candidate.
 *
 * Every path returns a candidate. Nothing in this module throws on behalf of a
 * turn, because a router that can break a turn is worse than no router.
 *
 * @module dsh-plugin-jev-router/router
 */

import { boundSummary, isTrivial, matchPatterns, resolveConfig } from './config.js'
import { JevError, JevHttpClient } from './jev.js'
import type { JevChoiceAnswer, JevClientLike } from './jev.js'
import { buildReceipt, computeMetrics, ReceiptLog } from './receipts.js'
import { buildJevState, summaryText } from './summary.js'
import { oneLine } from './text.js'
import type { Candidate, Receipt, RouteDecision, RouteMetrics, RouteReason, TurnSummary } from './types.js'
import type { ResolvedConfig, RouterConfig } from './config.js'

/** Receipts kept in memory for the live session metrics. */
const HISTORY_LIMIT = 10000

/** A decision before the session bookkeeping is applied. */
interface RawDecision {
  candidate: Candidate
  reason: RouteReason
  confidence: number | null
  distribution: number[] | null
  escalations: string[]
  latencyMs: number
  error: string | null
}

/** Config plus an optional client, accepted by both entry points. */
export interface RouterOptions extends RouterConfig {
  /** Client override. Defaults to the HTTP client built from the config. */
  client?: JevClientLike
}

/**
 * Route one turn with no session state.
 *
 * This is the stateless core: it applies the escalation patterns, the trivial
 * fast path, the Jev question and the confidence gate, and returns the
 * decision. Sticky holds, receipts and metrics live on `JevRouter`.
 */
export async function routeTurn(
  summary: TurnSummary | string,
  candidates: RouterConfig['candidates'],
  options: RouterOptions = {},
): Promise<RouteDecision> {
  const { client, ...config } = options
  const router = new JevRouter({ ...config, candidates }, client)
  return router.routeTurn(summary)
}

/**
 * A stateful router for one session.
 *
 * Holds the sticky candidate, writes receipts and accumulates the live
 * metrics that the plugin reports.
 */
export class JevRouter {
  readonly config: ResolvedConfig
  private readonly client: JevClientLike
  private readonly log: ReceiptLog | null
  private readonly history: Receipt[] = []
  private turn = 0
  private stickyIndex: number | null = null
  private stickyRemaining = 0
  private last: RouteDecision | null = null

  constructor(config: RouterOptions = {}, client?: JevClientLike) {
    this.config = resolveConfig(config)
    this.client = client ?? config.client ?? new JevHttpClient({
      endpoint: this.config.endpoint,
      apiKey: this.config.apiKey,
      timeoutMs: this.config.timeoutMs,
    })
    this.log = this.config.receiptPath.length > 0 ? new ReceiptLog(this.config.receiptPath) : null
  }

  /** Candidate table in configured order. */
  get candidates(): Candidate[] {
    return this.config.candidates
  }

  /** The last decision, or null before the first turn. */
  current(): RouteDecision | null {
    return this.last
  }

  /** Turns left in the sticky hold. */
  stickyTurnsRemaining(): number {
    return this.stickyRemaining
  }

  /** Live metrics over the turns this router has routed. */
  stats(): RouteMetrics {
    return computeMetrics(this.history)
  }

  /** Receipts for the turns this router has routed, in order. */
  receipts(): Receipt[] {
    return [...this.history]
  }

  /**
   * Route one turn.
   *
   * Accepts a summary or a raw string. Never rejects: a failure inside the
   * client becomes a fallback decision with the error recorded.
   */
  async routeTurn(input: TurnSummary | string): Promise<RouteDecision> {
    const config = this.config
    const summary = typeof input === 'string' ? { request: input } : input
    const text = boundSummary(oneLine(summaryText(summary)), config)

    this.turn += 1
    const escalated = matchPatterns(text, config.escalateOn)

    let raw: RawDecision
    if (escalated.length > 0) {
      raw = {
        candidate: config.escalationCandidate,
        reason: 'escalation',
        confidence: null,
        distribution: null,
        escalations: escalated,
        latencyMs: 0,
        error: null,
      }
    } else if (isTrivial(text, config)) {
      raw = {
        candidate: config.candidates[config.cheapIndex],
        reason: 'fast-path',
        confidence: null,
        distribution: null,
        escalations: [],
        latencyMs: 0,
        error: null,
      }
    } else if (this.stickyRemaining > 0 && this.stickyIndex !== null) {
      raw = {
        candidate: config.candidates[this.stickyIndex],
        reason: 'sticky',
        confidence: null,
        distribution: null,
        escalations: [],
        latencyMs: 0,
        error: null,
      }
    } else {
      raw = await this.ask(text)
    }

    this.advanceSticky(raw)

    const decision: RouteDecision = {
      turn: this.turn,
      candidate: raw.candidate,
      reason: raw.reason,
      confidence: raw.confidence,
      distribution: raw.distribution,
      candidates: config.candidates,
      stickyRemaining: this.stickyRemaining,
      escalations: raw.escalations,
      latencyMs: raw.latencyMs,
      cost: raw.candidate.effectiveCost,
      baselineCost: config.defaultCandidate.effectiveCost,
      error: raw.error,
    }

    this.last = decision

    const receipt = buildReceipt(decision, summary, config.defaultCandidate.label, {
      in: config.tokensInPerTurn,
      out: config.tokensOutPerTurn,
    })
    this.history.push(receipt)
    if (this.history.length > HISTORY_LIMIT) this.history.shift()

    if (this.log) {
      const failure = await this.log.append(receipt)
      if (failure) decision.error = decision.error ?? `receipt not written: ${failure}`
    }

    return decision
  }

  /** Ask Jev one choice question and apply the confidence gate. */
  private async ask(text: string): Promise<RawDecision> {
    const config = this.config

    // A single candidate has nothing to decide, and Jev would only be asked to
    // confirm it, so the turn routes without a request.
    if (config.candidates.length < 2) {
      return {
        candidate: config.candidates[config.cheapIndex],
        reason: 'jev',
        confidence: 1,
        distribution: [1],
        escalations: [],
        latencyMs: 0,
        error: null,
      }
    }

    const started = Date.now()
    let answer: JevChoiceAnswer
    try {
      answer = await this.client.ask({
        state: buildJevState(text, config.candidates),
        question: config.question,
        options: config.candidates.map(candidate => candidate.label),
      })
    } catch (error) {
      const latencyMs = Date.now() - started
      const detail = error instanceof JevError
        ? `${error.code}: ${error.message}`
        : error instanceof Error ? error.message : String(error)
      return {
        candidate: config.defaultCandidate,
        reason: 'fallback',
        confidence: null,
        distribution: null,
        escalations: [],
        latencyMs,
        error: detail,
      }
    }

    const latencyMs = Date.now() - started
    if (answer.confidence < config.minConfidence) {
      return {
        candidate: config.defaultCandidate,
        reason: 'fallback',
        confidence: answer.confidence,
        distribution: answer.distribution,
        escalations: [],
        latencyMs,
        error: `confidence ${answer.confidence.toFixed(2)} below minConfidence ${config.minConfidence}`,
      }
    }

    return {
      candidate: config.candidates[answer.choice],
      reason: 'jev',
      confidence: answer.confidence,
      distribution: answer.distribution,
      escalations: [],
      latencyMs,
      error: null,
    }
  }

  /**
   * Move the sticky hold forward.
   *
   * An escalation or a Jev decision above the cheapest candidate arms the
   * hold for `stickyTurns` turns. A decision on the cheapest candidate
   * releases it, because the session has moved down.
   *
   * The fast path and the fallback leave the hold untouched. A read-only turn
   * says nothing about how hard the surrounding work is, and a fallback says
   * nothing about the turn at all, so neither should pin the next turn. That
   * also keeps a degraded Jev endpoint visible in the receipts as a run of
   * fallbacks with their error text, instead of one fallback hidden behind a
   * hold.
   */
  private advanceSticky(raw: RawDecision): void {
    const config = this.config

    if (raw.reason === 'sticky') {
      this.stickyRemaining = Math.max(0, this.stickyRemaining - 1)
      if (this.stickyRemaining === 0) this.stickyIndex = null
      return
    }
    if (raw.reason === 'fast-path' || raw.reason === 'fallback') return

    if (raw.candidate.rank > 0 && config.stickyTurns > 0) {
      this.stickyIndex = raw.candidate.index
      this.stickyRemaining = config.stickyTurns
      return
    }
    this.stickyIndex = null
    this.stickyRemaining = 0
  }

  /** Drop the hold without waiting for it to expire. */
  releaseSticky(): void {
    this.stickyIndex = null
    this.stickyRemaining = 0
  }

  /** Compact routing policy text for the system prompt. */
  policyText(): string {
    const decision = this.last
    if (!decision) return ''
    return [
      '# Model routing',
      '',
      'Each turn of this session is routed to a model and reasoning effort pair.',
      `Current turn: ${decision.candidate.label} (${decision.reason}).`,
    ].join('\n')
  }
}
