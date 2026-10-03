/**
 * Configuration, defaults and pattern compilation for the router.
 *
 * The built-in patterns exist so the router does something useful before any
 * tuning. They are additive: `escalateOn` and `trivialPatterns` append to the
 * defaults, and `useDefaultPatterns: false` drops the defaults entirely.
 *
 * @module dsh-plugin-jev-router/config
 */

import { DEFAULT_ENDPOINT } from './jev.js'
import { byteLength, clamp01, truncateBytes } from './text.js'
import type { Candidate, CandidateSpec } from './types.js'

/** Default number of input tokens one turn is assumed to send. */
export const DEFAULT_TOKENS_IN = 12000

/** Default number of output tokens one turn is assumed to produce. */
export const DEFAULT_TOKENS_OUT = 800

/**
 * Built-in escalation patterns.
 *
 * Each one is a shape that cannot be answered from the turn text alone: a
 * stack trace needs the code path read, a race condition needs interleaving
 * reasoning, a migration needs the call graph. Routing these to Jev would only
 * add latency to a decision that is already made.
 */
export const DEFAULT_ESCALATE_PATTERNS: readonly string[] = [
  'Traceback \\(most recent call last\\)',
  'File "[^"]+", line \\d+',
  '\\bat\\s+[\\w.$<>\\[\\]]+\\s*\\([^)]*:\\d+\\)',
  '\\b(?:stack trace|stacktrace|traceback)\\b',
  '\\bAssertionError\\b|\\bassertion failed\\b',
  '\\b(?:\\d+\\s+)?(?:tests?|specs?|checks?|assertions?)\\s+(?:failed|failing)\\b|\\bFAILED\\b',
  '\\bwhy (?:does|do|is|are|did|would|can)\\b',
  '\\brace condition\\b|\\bdata race\\b',
  '\\bflaky\\b|\\bintermittent(?:ly)?\\b|\\bnon-?deterministic\\b',
  '\\bdeadlock\\b|\\bsegfault\\b|\\bsegmentation fault\\b',
  '\\bmigrat(?:e|es|ed|ing|ion)\\b',
  '\\brefactor(?:ing)?\\s+(?:across|throughout)\\b',
  '\\b(?:reproduce|repro)\\b[^.]{0,40}\\b(?:inconsistently|sometimes|occasionally)\\b',
]

/**
 * Built-in trivial patterns.
 *
 * These all start a turn with a read-only verb, so they can only fire when the
 * request itself opens with one. The byte guard in the fast path keeps a long
 * turn from sneaking through on a matching first word.
 */
export const DEFAULT_TRIVIAL_PATTERNS: readonly string[] = [
  '^\\s*(?:cat|bat|ls|ll|pwd|head|tail|show|read|view|print|open|grep|rg|wc|stat|file|tree|which|type|env|echo|du|df)\\b',
  '^\\s*(?:git (?:status|diff|log|show|branch|remote)|npm (?:ls|list|view)|pip (?:show|list|freeze))\\b',
]

/**
 * Markers that block the fast path even when a trivial pattern matches.
 *
 * "Read the failing test output and explain why the assertion fails" opens
 * with a read-only verb and would otherwise be treated as mechanical. The
 * request is asking for reasoning, so the guard keeps it in the Jev path.
 */
export const REASONING_MARKERS: readonly string[] = [
  'explain',
  'why',
  'debug',
  'design',
  'analyz',
  'analys',
  'compare',
  'evaluat',
  'review',
  'optimiz',
  'optimis',
  'improve',
  'investigat',
  'diagnos',
  'profil',
  'benchmark',
  'architect',
]

/** Instruction sent as the Jev question when `question` is not configured. */
export const DEFAULT_QUESTION =
  'Pick the candidate that can complete this turn correctly at the lowest cost. '
  + 'Prefer a cheap candidate for mechanical edits, renames, formatting and single-file lookups. '
  + 'Prefer an expensive candidate for design work, cross-file reasoning and debugging from partial evidence.'

/**
 * Built-in candidate table.
 *
 * The rates are published list prices used as an example. Replace them with the
 * rates actually billed for the models you route between.
 */
export const DEFAULT_CANDIDATES: readonly CandidateSpec[] = [
  { model: 'deepseek-v4-fast', effort: 'low', costPerMTokIn: 0.07, costPerMTokOut: 0.14 },
  { model: 'deepseek-v4', effort: 'low', costPerMTokIn: 0.28, costPerMTokOut: 0.42 },
  { model: 'deepseek-v4', effort: 'high', costPerMTokIn: 0.28, costPerMTokOut: 0.42 },
  { model: 'deepseek-reasoner', effort: 'high', costPerMTokIn: 0.55, costPerMTokOut: 2.19 },
]

/** Everything the router and the plugin can be configured with. */
export interface RouterConfig {
  /** Routing targets. Default: the built-in example table. */
  candidates?: CandidateSpec[]
  /**
   * Candidate that receives low-confidence turns and Jev failures. Accepts a
   * `model@effort` label, a bare model name, or a list index. Default: the
   * most expensive candidate, so a turn the router cannot decide is served by
   * the most capable option in the table.
   */
  defaultCandidate?: string | number
  /** Confidence at or above which a Jev choice is taken. Default: 0.5. */
  minConfidence?: number
  /** Turns a chosen candidate stays pinned after an expensive route. Default: 1. */
  stickyTurns?: number
  /** Extra escalation patterns, appended to the built-in defaults. */
  escalateOn?: string[]
  /** Extra trivial-turn patterns, appended to the built-in defaults. */
  trivialPatterns?: string[]
  /** Set false to route with only the patterns given in config. Default: true. */
  useDefaultPatterns?: boolean
  /** Byte cap for the trivial fast path. Default: 240. */
  trivialMaxBytes?: number
  /** Byte cap on the summary sent to Jev. Default: 4000. */
  maxSummaryBytes?: number
  /** Jev endpoint. Default: `JEV_API_URL` then `https://api.typesafe.ai/v1/systemone`. */
  endpoint?: string
  /** Jev API key. Default: `JEV_API_KEY`. */
  apiKey?: string
  /** Per-request timeout in milliseconds. Default: 2500. */
  timeoutMs?: number
  /** Jev question framing the routing decision. Default: the built-in question. */
  question?: string
  /** Input tokens assumed per turn when estimating cost. Default: 12000. */
  tokensInPerTurn?: number
  /** Output tokens assumed per turn when estimating cost. Default: 800. */
  tokensOutPerTurn?: number
  /** JSONL receipt path. Default: `JEV_ROUTER_RECEIPTS`. Disabled when empty. */
  receiptPath?: string
  /** Inject the current route into the system prompt. Default: false. */
  promptSection?: boolean
  /** Cost weight used by `replay --prefer cheap`. Default: 2. */
  replayCostAversion?: number
}

/** Config with every default applied and every derived field computed. */
export interface ResolvedConfig {
  candidates: Candidate[]
  /** Index of the cheapest candidate. */
  cheapIndex: number
  /** Index of the most expensive candidate. */
  expensiveIndex: number
  defaultCandidate: Candidate
  /**
   * Candidate that receives escalation turns. The default candidate's model at
   * its highest configured effort, which is the default candidate itself when
   * the table holds one entry for that model.
   */
  escalationCandidate: Candidate
  escalateOn: RegExp[]
  trivialPatterns: RegExp[]
  trivialMaxBytes: number
  maxSummaryBytes: number
  minConfidence: number
  stickyTurns: number
  endpoint: string
  apiKey: string
  timeoutMs: number
  question: string
  tokensInPerTurn: number
  tokensOutPerTurn: number
  receiptPath: string
  promptSection: boolean
  replayCostAversion: number
  /** Problems found while resolving, reported by `doctor` and the plugin log. */
  warnings: string[]
}

/** Estimated cost of one turn on a token profile, in USD. */
export function turnCost(
  costPerMTokIn: number,
  costPerMTokOut: number,
  tokensIn: number,
  tokensOut: number,
): number {
  return (costPerMTokIn * tokensIn + costPerMTokOut * tokensOut) / 1_000_000
}

/** Read a finite number from the environment. */
function envNumber(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** Read a JSON candidate table from the environment. */
function envCandidates(): CandidateSpec[] | undefined {
  const raw = process.env.JEV_ROUTER_CANDIDATES
  if (raw === undefined || raw.trim() === '') return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed as CandidateSpec[]
  } catch {
    /* an unparseable table is reported through the built-in fallback warning */
  }
  return undefined
}

/** Compile pattern sources, skipping any that do not compile. */
function compilePatterns(sources: readonly string[], label: string, warnings: string[]): RegExp[] {
  const compiled: RegExp[] = []
  for (const source of sources) {
    try {
      compiled.push(new RegExp(source, 'i'))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      warnings.push(`${label} pattern ${JSON.stringify(source)} does not compile and was skipped: ${detail}`)
    }
  }
  return compiled
}

/** Match a text against compiled patterns, returning the sources that hit. */
export function matchPatterns(text: string, patterns: readonly RegExp[]): string[] {
  const hits: string[] = []
  for (const pattern of patterns) {
    if (pattern.test(text)) hits.push(pattern.source)
  }
  return hits
}

/** Resolve a configured default candidate reference to an index, or -1. */
function pickCandidate(reference: string | number | undefined, candidates: Candidate[]): number {
  if (typeof reference === 'number') {
    return Number.isInteger(reference) && reference >= 0 && reference < candidates.length ? reference : -1
  }
  if (typeof reference === 'string' && reference.length > 0) {
    const byLabel = candidates.findIndex(candidate => candidate.label === reference)
    if (byLabel >= 0) return byLabel
    const byModel = candidates.findIndex(candidate => candidate.model === reference)
    if (byModel >= 0) return byModel
  }
  return -1
}

/** Take a finite, non-negative number, or zero. */
function nonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Take a positive number or fall back, recording the fallback. */
function positive(value: number | undefined, fallback: number, label: string, warnings: string[]): number {
  if (value === undefined) return fallback
  if (Number.isFinite(value) && value > 0) return value
  warnings.push(`${label} must be a positive number, using ${fallback}`)
  return fallback
}

/**
 * Apply defaults, derive labels, ranks and cost estimates, and compile
 * patterns. Never throws: anything unusable becomes a warning plus a fallback,
 * because a misconfigured router must still be able to pass a turn through.
 */
export function resolveConfig(config: RouterConfig = {}): ResolvedConfig {
  const warnings: string[] = []

  const tokensInPerTurn = positive(config.tokensInPerTurn, DEFAULT_TOKENS_IN, 'tokensInPerTurn', warnings)
  const tokensOutPerTurn = positive(config.tokensOutPerTurn, DEFAULT_TOKENS_OUT, 'tokensOutPerTurn', warnings)

  const configured = config.candidates ?? envCandidates()
  if (!configured || configured.length === 0) {
    warnings.push(`no candidates configured, using the ${DEFAULT_CANDIDATES.length}-entry built-in example table`)
  }
  const specs = configured && configured.length > 0 ? configured : [...DEFAULT_CANDIDATES]

  const candidates: Candidate[] = specs.map((spec, index) => {
    const model = typeof spec.model === 'string' && spec.model.length > 0 ? spec.model : `model-${index}`
    const effort = typeof spec.effort === 'string' && spec.effort.length > 0 ? spec.effort : 'high'
    if (model !== spec.model) warnings.push(`candidate ${index} has no model, labelled ${model}`)
    const costPerMTokIn = nonNegative(spec.costPerMTokIn)
    const costPerMTokOut = nonNegative(spec.costPerMTokOut)
    return {
      model,
      effort,
      costPerMTokIn,
      costPerMTokOut,
      label: `${model}@${effort}`,
      index,
      effectiveCost: turnCost(costPerMTokIn, costPerMTokOut, tokensInPerTurn, tokensOutPerTurn),
      rank: index,
    }
  })

  const seen = new Map<string, number>()
  for (const candidate of candidates) {
    const previous = seen.get(candidate.label)
    if (previous !== undefined) {
      warnings.push(`candidates ${previous} and ${candidate.index} share the label ${candidate.label}`)
    } else {
      seen.set(candidate.label, candidate.index)
    }
  }

  // Rank by turn cost, breaking ties in configuration order so listing the
  // cheap effort before the expensive one gives the expected ordering.
  const order = candidates.map(candidate => candidate.index).sort((a, b) => {
    const delta = candidates[a].effectiveCost - candidates[b].effectiveCost
    return delta !== 0 ? delta : a - b
  })
  order.forEach((index, rank) => {
    candidates[index].rank = rank
  })
  const cheapIndex = order[0]
  const expensiveIndex = order[order.length - 1]

  let defaultIndex = pickCandidate(config.defaultCandidate, candidates)
  if (defaultIndex < 0) {
    if (config.defaultCandidate !== undefined) {
      warnings.push(`defaultCandidate ${JSON.stringify(config.defaultCandidate)} matched no candidate`)
    }
    defaultIndex = order[order.length - 1]
  }
  const defaultCandidate = candidates[defaultIndex]

  // Escalation goes to the default model at its highest configured effort.
  let escalationCandidate = defaultCandidate
  for (const candidate of candidates) {
    if (candidate.model !== defaultCandidate.model) continue
    if (candidate.effectiveCost > escalationCandidate.effectiveCost) escalationCandidate = candidate
  }

  const useDefaults = config.useDefaultPatterns !== false
  const escalateOn = compilePatterns(
    [...(useDefaults ? DEFAULT_ESCALATE_PATTERNS : []), ...(config.escalateOn ?? [])],
    'escalateOn',
    warnings,
  )
  const trivialPatterns = compilePatterns(
    [...(useDefaults ? DEFAULT_TRIVIAL_PATTERNS : []), ...(config.trivialPatterns ?? [])],
    'trivialPatterns',
    warnings,
  )

  const receiptPath = config.receiptPath ?? process.env.JEV_ROUTER_RECEIPTS ?? ''
  const endpoint = config.endpoint ?? process.env.JEV_API_URL ?? DEFAULT_ENDPOINT
  const apiKey = config.apiKey ?? process.env.JEV_API_KEY ?? ''

  return {
    candidates,
    cheapIndex,
    expensiveIndex,
    defaultCandidate,
    escalationCandidate,
    escalateOn,
    trivialPatterns,
    trivialMaxBytes: positive(config.trivialMaxBytes, 240, 'trivialMaxBytes', warnings),
    maxSummaryBytes: positive(config.maxSummaryBytes, 4000, 'maxSummaryBytes', warnings),
    minConfidence: clamp01(config.minConfidence ?? 0.5),
    stickyTurns: Math.max(0, Math.floor(config.stickyTurns ?? 1)),
    endpoint,
    apiKey,
    timeoutMs: positive(config.timeoutMs, 2500, 'timeoutMs', warnings),
    question: config.question ?? DEFAULT_QUESTION,
    tokensInPerTurn,
    tokensOutPerTurn,
    receiptPath,
    promptSection: config.promptSection === true,
    replayCostAversion: positive(config.replayCostAversion, 2, 'replayCostAversion', warnings),
    warnings,
  }
}

/** True when the text is short, opens with a read-only verb and asks for no reasoning. */
export function isTrivial(text: string, config: ResolvedConfig): boolean {
  if (byteLength(text) > config.trivialMaxBytes) return false
  const lowered = text.toLowerCase()
  for (const marker of REASONING_MARKERS) {
    if (lowered.includes(marker)) return false
  }
  return matchPatterns(text, config.trivialPatterns).length > 0
}

/** Bound a summary to the configured byte budget. */
export function boundSummary(text: string, config: ResolvedConfig): string {
  return truncateBytes(text, config.maxSummaryBytes)
}
