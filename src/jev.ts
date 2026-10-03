/**
 * Client for the TypeSafe System One (Jev) endpoint.
 *
 * A routing request is one `choice` question over the candidate labels. System
 * One answers in a single forward pass and emits no output tokens, so the cost
 * of asking is the input size alone and the latency is one forward pass.
 *
 * The response reducer is deliberately tolerant. Endpoints in this family
 * return `probabilities` over the supplied labels, a chosen `choice`, or a
 * bare `level`, and callers should not care which. Anything that cannot be
 * reduced to a candidate index raises `JevError` with code `malformed`, which
 * the router treats exactly like a network failure.
 *
 * @module dsh-plugin-jev-router/jev
 */

import { clamp01 } from './text.js'

/** Default endpoint used when neither config nor `JEV_API_URL` is set. */
export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/** Failure classes the router distinguishes only for the receipt. */
export type JevErrorCode = 'missing-key' | 'network' | 'timeout' | 'http' | 'malformed'

/** Any failure that should send the router to the default candidate. */
export class JevError extends Error {
  readonly code: JevErrorCode
  readonly status?: number

  constructor(code: JevErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'JevError'
    this.code = code
    this.status = status
  }
}

/** Everything needed to talk to the endpoint. */
export interface JevClientOptions {
  endpoint: string
  apiKey: string
  timeoutMs: number
}

/** One routing question. */
export interface JevChoiceRequest {
  /** The turn summary the decision is made from. */
  state: string
  /** The question framing the decision. */
  question: string
  /** Candidate labels, in candidate order. */
  options: string[]
}

/** A reduced choice answer. */
export interface JevChoiceAnswer {
  /** Index into the option list. */
  choice: number
  /** Probability per option, or null when the endpoint reported only a pick. */
  distribution: number[] | null
  /** Calibrated confidence in [0, 1]. */
  confidence: number
}

/** A client the router can ask. Lets tests and embedders supply their own. */
export interface JevClientLike {
  ask(request: JevChoiceRequest): Promise<JevChoiceAnswer>
}

/** First finite number among the candidates. */
function firstNumber(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  }
  return undefined
}

/**
 * Read a candidate answer object out of an unknown payload.
 * Wrappers such as `{ answer: { ... } }` and `{ data: { ... } }` are unwrapped
 * so a transport that adds an envelope still works.
 */
function unwrap(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const root = payload as Record<string, unknown>
  for (const key of ['answer', 'data', 'result', 'response', 'output']) {
    const inner = root[key]
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const record = inner as Record<string, unknown>
      if ('choice' in record || 'option' in record || 'level' in record
        || 'probabilities' in record || 'distribution' in record) {
        return record
      }
    }
  }
  return root
}

/** Renormalise a weight vector so it sums to one. */
function normalise(weights: number[]): number[] {
  const cleaned = weights.map(weight => (Number.isFinite(weight) && weight > 0 ? weight : 0))
  const total = cleaned.reduce((a, b) => a + b, 0)
  if (total <= 0) return cleaned.map(() => 0)
  return cleaned.map(weight => weight / total)
}

/** Read a distribution over the options out of an unknown value. */
function reduceDistribution(value: unknown, options: string[]): number[] | null {
  if (Array.isArray(value) && value.length === options.length) {
    if (value.every(item => typeof item === 'number' && Number.isFinite(item))) {
      return normalise(value as number[])
    }
    return null
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    // Keyed by label, which is how a choice question is normally echoed back.
    const byLabel = options.map(label => {
      const weight = record[label]
      return typeof weight === 'number' && Number.isFinite(weight) ? weight : Number.NaN
    })
    if (byLabel.every(Number.isFinite)) return normalise(byLabel)
    // Keyed by option index as a string.
    const byIndex = options.map((_, index) => {
      const weight = record[String(index)]
      return typeof weight === 'number' && Number.isFinite(weight) ? weight : Number.NaN
    })
    if (byIndex.every(Number.isFinite)) return normalise(byIndex)
  }
  return null
}

/** Resolve a reported pick to an option index, or -1. */
function reducePick(value: unknown, options: string[]): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < options.length) {
    return value
  }
  if (typeof value === 'string') {
    const needle = value.trim()
    const exact = options.findIndex(option => option === needle)
    if (exact >= 0) return exact
    const lowered = needle.toLowerCase()
    const insensitive = options.findIndex(option => option.toLowerCase() === lowered)
    if (insensitive >= 0) return insensitive
    // A label may come back trimmed of its effort suffix.
    const prefix = options.findIndex(option => option.toLowerCase().startsWith(lowered))
    if (prefix >= 0) return prefix
    const echoed = options.findIndex(option => lowered.startsWith(option.toLowerCase()))
    if (echoed >= 0) return echoed
    if (/^\d+$/.test(needle)) {
      const index = Number(needle)
      if (index >= 0 && index < options.length) return index
    }
  }
  return -1
}

/** Index of the largest value, or -1 for an empty or all-zero vector. */
function argmax(values: number[]): number {
  let best = -1
  let bestValue = 0
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] > bestValue) {
      bestValue = values[i]
      best = i
    }
  }
  return best
}

/**
 * Reduce an unknown response body to a choice answer.
 * Throws `JevError` with code `malformed` when no option can be identified.
 */
export function reduceChoice(payload: unknown, options: string[]): JevChoiceAnswer {
  const record = unwrap(payload)
  if (!record) throw new JevError('malformed', 'Jev response was not an object')

  const rawDistribution = record.probabilities ?? record.probs ?? record.distribution ?? record.weights
  const distribution = reduceDistribution(rawDistribution, options)

  const rawPick = record.choice ?? record.option ?? record.level ?? record.label
    ?? record.selected ?? record.index
  let choice = reducePick(rawPick, options)

  if (choice < 0 && distribution) choice = argmax(distribution)
  if (choice < 0) throw new JevError('malformed', 'Jev response named no option')

  const reported = firstNumber(record.confidence, record.probability, record.prob, record.p)
  const peak = distribution ? distribution[choice] : undefined
  const confidence = clamp01(reported ?? peak ?? 1)

  return { choice, distribution, confidence }
}

/**
 * Ask Jev one choice question.
 *
 * The request body matches the family wire format: `state` carries the turn
 * summary, `question` carries the routing instruction, `type` is `choice` and
 * `options` carries the candidate labels in candidate order. A choice question
 * uses `options`; `levels` belongs to a score question and is not sent here.
 *
 * Throws `JevError` on any failure. Callers route to their default candidate
 * rather than propagating, because a routing decision must never fail a turn.
 */
export async function askChoice(
  client: JevClientOptions,
  request: JevChoiceRequest,
): Promise<JevChoiceAnswer> {
  if (!client.apiKey) {
    throw new JevError('missing-key', 'JEV_API_KEY is not set')
  }
  if (request.options.length === 0) {
    throw new JevError('malformed', 'a choice question needs at least one option')
  }

  const body = {
    state: request.state,
    question: request.question,
    type: 'choice',
    options: request.options,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), client.timeoutMs)

  let response: Response
  try {
    response = await fetch(client.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${client.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (controller.signal.aborted) {
      throw new JevError('timeout', `Jev request exceeded ${client.timeoutMs} ms`)
    }
    throw new JevError('network', `Jev request failed: ${message}`)
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    throw new JevError('http', `Jev returned HTTP ${response.status}`, response.status)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new JevError('malformed', 'Jev response was not valid JSON')
  }

  return reduceChoice(payload, request.options)
}

/** A `JevClientLike` backed by the HTTP endpoint. */
export class JevHttpClient implements JevClientLike {
  private readonly options: JevClientOptions

  constructor(options: JevClientOptions) {
    this.options = options
  }

  ask(request: JevChoiceRequest): Promise<JevChoiceAnswer> {
    return askChoice(this.options, request)
  }
}

/**
 * Reachability probe for `doctor`. Any HTTP status counts as reachable, since
 * a 401 or 405 still proves the host answered.
 */
export async function probeEndpoint(
  endpoint: string,
  timeoutMs = 5000,
): Promise<{ reachable: boolean; status?: number; detail: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpoint, { method: 'HEAD', signal: controller.signal })
    return { reachable: true, status: response.status, detail: `HTTP ${response.status}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (controller.signal.aborted) return { reachable: false, detail: `timeout after ${timeoutMs} ms` }
    return { reachable: false, detail: message }
  } finally {
    clearTimeout(timer)
  }
}
