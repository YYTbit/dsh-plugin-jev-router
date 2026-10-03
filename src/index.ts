/**
 * Jev Router Plugin for DeepSeek Harness.
 *
 * Routes every turn to a (model, reasoning effort) pair chosen by one Jev
 * choice question, so easy turns stop burning the expensive model and hard
 * turns stop being under-served by a rule that cannot tell them apart.
 *
 * @module dsh-plugin-jev-router
 */

import type { RouterConfig } from './config.js'
import { JevRouter } from './router.js'
import { summarizeTurn } from './summary.js'
import type { TurnSummary } from './types.js'

export const name = 'jev-router'
export const inject: string[] = []

/** Plugin configuration. Identical to the router configuration. */
export interface Config extends RouterConfig {}

/**
 * Host hook slots the router probes for a pre-dispatch entry point, in order.
 *
 * The harness surface this plugin was written against exposes
 * `ctx.systemPrompt` and `ctx.shellEnv` but no model-selection hook, so the
 * router is registered on the first slot that accepts it and the chosen slot
 * name is reported through the plugin log. When the harness publishes an
 * official pre-dispatch hook, add it to this list and it takes precedence by
 * position.
 */
const DISPATCH_SLOTS: ReadonlyArray<readonly [string, string]> = [
  ['dispatch', 'before'],
  ['model', 'beforeDispatch'],
  ['turn', 'before'],
]

/** A dispatch handler: turn in, routed candidate out. */
export type DispatchHandler = (turn: unknown) => Promise<{
  model: string
  effort: string
  label: string
  reason: string
  confidence: number | null
}>

/** Where the router managed to register itself. */
export interface HookBinding {
  /** `service.method` of the slot that accepted the handler, or null. */
  slot: string | null
  /** Detach function when the slot returned one. */
  dispose: (() => void) | null
}

/**
 * Register the router on the first dispatch slot that accepts it.
 * Never throws. A null slot means the host has no pre-dispatch hook and the
 * dispatch layer should call `ctx.jevRouter.routeTurn` directly.
 */
export function registerDispatchHook(ctx: any, handler: DispatchHandler): HookBinding {
  for (const [service, method] of DISPATCH_SLOTS) {
    const target = ctx?.[service]
    const register = target?.[method]
    if (typeof register !== 'function') continue
    try {
      const dispose = register.call(target, { name: 'jev-router', handler })
      return { slot: `${service}.${method}`, dispose: typeof dispose === 'function' ? dispose : null }
    } catch {
      /* the slot refused the handler, so the next one is tried */
    }
  }
  return { slot: null, dispose: null }
}

export function apply(ctx: any, config: Config = {}): void {
  const settings: Config = config ?? {}
  const router = new JevRouter(settings)
  const resolved = router.config

  for (const warning of resolved.warnings) {
    ctx?.logger?.warn?.(`jev-router: ${warning}`)
  }

  // Expose the router so a dispatch layer can call it directly. This is the
  // documented integration point and the one the README tells embedders to
  // use when their harness has no pre-dispatch hook to register on.
  try {
    ctx.jevRouter = router
  } catch {
    /* a frozen context still leaves the CLI and the exports usable */
  }

  // Report the route for the current turn to the shell, so commands the agent
  // runs can see which candidate is serving the turn.
  if (ctx.shellEnv?.register) {
    ctx.shellEnv.register({
      name: 'jev-router',
      variables: {
        'DSH_JEV_ROUTER_MODEL': { description: 'Model selected for the current turn' },
        'DSH_JEV_ROUTER_EFFORT': { description: 'Reasoning effort selected for the current turn' },
        'DSH_JEV_ROUTER_REASON': { description: 'Rule that selected the current candidate' },
        'DSH_JEV_ROUTER_RECEIPTS': { description: 'Path to the routing receipts log' },
      },
      resolve() {
        const decision = router.current()
        return {
          'DSH_JEV_ROUTER_MODEL': decision?.candidate.model ?? '',
          'DSH_JEV_ROUTER_EFFORT': decision?.candidate.effort ?? '',
          'DSH_JEV_ROUTER_REASON': decision?.reason ?? '',
          'DSH_JEV_ROUTER_RECEIPTS': resolved.receiptPath,
        }
      },
    })
  }

  // Opt-in, because a section that changes on every turn rewrites the cached
  // prefix of the system prompt and costs more than it explains.
  if (resolved.promptSection && ctx.systemPrompt?.section) {
    ctx.systemPrompt.section({
      name: 'jev-router:route',
      order: 150,
      text: async () => router.policyText(),
    })
  }

  const handler: DispatchHandler = async (turn: unknown) => {
    const summary: TurnSummary = summarizeTurn(turn, resolved.maxSummaryBytes)
    const decision = await router.routeTurn(summary)
    return {
      model: decision.candidate.model,
      effort: decision.candidate.effort,
      label: decision.candidate.label,
      reason: decision.reason,
      confidence: decision.confidence,
    }
  }

  const binding = registerDispatchHook(ctx, handler)
  if (binding.slot) {
    ctx?.logger?.info?.(`jev-router: dispatch hook registered on ${binding.slot}`)
  } else {
    ctx?.logger?.info?.('jev-router: no dispatch hook found, call ctx.jevRouter.routeTurn from the dispatch layer')
  }
}

export { JevRouter, routeTurn } from './router.js'
export type { RouterOptions } from './router.js'
export { resolveConfig, matchPatterns, isTrivial, DEFAULT_CANDIDATES, DEFAULT_ESCALATE_PATTERNS, DEFAULT_TRIVIAL_PATTERNS, REASONING_MARKERS } from './config.js'
export type { ResolvedConfig, RouterConfig } from './config.js'
export { askChoice, reduceChoice, probeEndpoint, JevError, DEFAULT_ENDPOINT } from './jev.js'
export type { JevChoiceAnswer, JevChoiceRequest, JevClientLike, JevClientOptions, JevErrorCode } from './jev.js'
export { buildReceipt, computeMetrics, readReceipts, replayReceipts, ReceiptLog } from './receipts.js'
export { summarizeTurn, summaryText, buildJevState } from './summary.js'
export { hashText, byteLength, truncateBytes, oneLine, clamp01, formatUsd } from './text.js'
export type {
  Candidate,
  CandidateSpec,
  Preference,
  Receipt,
  ReplayChange,
  ReplayResult,
  RouteDecision,
  RouteMetrics,
  RouteReason,
  TurnSummary,
} from './types.js'
export { ROUTE_REASONS } from './types.js'

export default { name, inject, apply }
