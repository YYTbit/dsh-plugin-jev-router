#!/usr/bin/env node
/**
 * jev-route -- routing CLI for dsh-plugin-jev-router.
 *
 * Usage:
 *   jev-route route <summary>              Route one turn summary
 *   jev-route receipts <path>              Summarise a receipts log
 *   jev-route replay <path> --prefer ...   Re-score recorded distributions
 *   jev-route doctor                       Check endpoint, key and candidates
 *
 * Global flags:
 *   --config <path>   JSON configuration, same fields as the plugin config
 *   --json            Emit the result as JSON
 *
 * @module dsh-plugin-jev-router/cli
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveConfig } from './config.js'
import type { ResolvedConfig, RouterConfig } from './config.js'
import { probeEndpoint } from './jev.js'
import { computeMetrics, readReceipts, replayReceipts } from './receipts.js'
import { JevRouter } from './router.js'
import { formatUsd, pad } from './text.js'
import { ROUTE_REASONS } from './types.js'
import type { Preference, Receipt, RouteDecision } from './types.js'

/** Parsed command line. */
interface Args {
  command: string
  positional: string[]
  flags: Record<string, string | boolean>
}

/** Split argv into a command, positional arguments and flags. */
function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next
      i += 1
    } else {
      flags[body] = true
    }
  }
  const command = positional.shift() ?? ''
  return { command, positional, flags }
}

/** Read a JSON configuration file. */
async function loadConfig(path: string | undefined): Promise<RouterConfig> {
  if (!path) return {}
  const raw = await readFile(resolve(path), 'utf8')
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`)
  }
  return parsed as RouterConfig
}

/** Flag value as a string, or undefined. */
function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key]
  return typeof value === 'string' ? value : undefined
}

/** Print the candidate table. */
function printCandidates(config: ResolvedConfig, mark: number): void {
  for (const candidate of config.candidates) {
    const pointer = candidate.index === mark ? '>' : ' '
    console.log(
      `${pointer} [${pad(String(candidate.index), 2)}] ${pad(candidate.label, 24)}`
      + ` rank ${pad(String(candidate.rank), 2)} ${pad(formatUsd(candidate.effectiveCost), 9)}/turn`
      + `  $${candidate.costPerMTokIn}/M in  $${candidate.costPerMTokOut}/M out`,
    )
  }
}

/** Print one routing decision. */
function printDecision(decision: RouteDecision, config: ResolvedConfig): void {
  console.log(`Reason           ${decision.reason}`)
  console.log(`Chosen           ${decision.candidate.label}`)
  console.log(`Confidence       ${decision.confidence === null ? '-' : decision.confidence.toFixed(3)}`)
  console.log(`Sticky remaining ${decision.stickyRemaining} turn(s)`)
  console.log(`Latency          ${decision.latencyMs} ms`)
  console.log(`Cost             ${formatUsd(decision.cost)}   (default baseline ${formatUsd(decision.baselineCost)})`)
  if (decision.escalations.length > 0) {
    console.log(`Escalations      ${decision.escalations.join(', ')}`)
  }
  if (decision.error) {
    console.log(`Note             ${decision.error}`)
  }
  console.log('')
  console.log('Distribution')
  for (const candidate of decision.candidates) {
    const probability = decision.distribution ? decision.distribution[candidate.index] : null
    const text = probability === null || probability === undefined ? '     -' : probability.toFixed(3)
    const pointer = candidate.index === decision.candidate.index ? '>' : ' '
    console.log(
      `${pointer} [${pad(String(candidate.index), 2)}] ${pad(candidate.label, 24)} p=${text}`
      + `  ${pad(formatUsd(candidate.effectiveCost), 9)}/turn  rank ${candidate.rank}`,
    )
  }
}

/** Render the metrics block shared by `receipts` and `route --json`. */
function printMetrics(receipts: Receipt[], skipped: number, source: string): void {
  const metrics = computeMetrics(receipts)
  console.log(`Source           ${source}`)
  console.log(`Turns            ${metrics.turns}`)
  if (skipped > 0) console.log(`Skipped lines    ${skipped}`)
  console.log('')
  console.log('By reason')
  for (const reason of ROUTE_REASONS) {
    const count = metrics.byReason[reason] ?? 0
    const share = metrics.turns > 0 ? (count / metrics.turns) * 100 : 0
    console.log(`  ${pad(reason, 12)} ${pad(String(count), 6)} ${share.toFixed(1)}%`)
  }
  console.log('')
  console.log(`Fallback rate    ${(metrics.fallbackRate * 100).toFixed(1)}%`)
  console.log(`Mean confidence  ${metrics.meanConfidence === null ? '-' : metrics.meanConfidence.toFixed(3)}`)
  console.log(`Mean latency     ${metrics.meanLatencyMs.toFixed(1)} ms`)
  console.log(`Cost             ${formatUsd(metrics.cost)}`)
  console.log(`Baseline         ${formatUsd(metrics.baselineCost)}`)
  console.log(`Saved            ${formatUsd(metrics.savedCost)}  ${metrics.savedPct.toFixed(1)}%`)
}

/** `jev-route route <summary>` */
async function commandRoute(args: Args, config: RouterConfig): Promise<void> {
  const summary = args.positional.join(' ').trim()
  if (summary.length === 0) {
    console.error('Usage: jev-route route <summary>')
    process.exit(1)
  }
  const router = new JevRouter(config)
  const decision = await router.routeTurn(summary)
  if (args.flags.json === true) {
    console.log(JSON.stringify({
      turn: decision.turn,
      label: decision.candidate.label,
      model: decision.candidate.model,
      effort: decision.candidate.effort,
      reason: decision.reason,
      confidence: decision.confidence,
      distribution: decision.distribution,
      candidates: decision.candidates.map(candidate => candidate.label),
      stickyRemaining: decision.stickyRemaining,
      latencyMs: decision.latencyMs,
      cost: decision.cost,
      baselineCost: decision.baselineCost,
      error: decision.error,
    }, null, 2))
    return
  }
  printDecision(decision, router.config)
}

/** `jev-route receipts <path>` */
async function commandReceipts(args: Args): Promise<void> {
  const path = args.positional[0]
  if (!path) {
    console.error('Usage: jev-route receipts <path>')
    process.exit(1)
  }
  const { receipts, skipped } = await readReceipts(resolve(path))
  if (args.flags.json === true) {
    console.log(JSON.stringify({ ...computeMetrics(receipts), skipped }, null, 2))
    return
  }
  printMetrics(receipts, skipped, resolve(path))
}

/** `jev-route replay <path> --prefer cheap|quality` */
async function commandReplay(args: Args, config: RouterConfig): Promise<void> {
  const path = args.positional[0]
  if (!path) {
    console.error('Usage: jev-route replay <path> --prefer cheap|quality')
    process.exit(1)
  }
  const preference = (flagString(args.flags, 'prefer') ?? 'quality') as Preference
  if (preference !== 'cheap' && preference !== 'quality') {
    console.error(`--prefer must be cheap or quality, got ${String(preference)}`)
    process.exit(1)
  }
  const resolved = resolveConfig(config)
  const lambdaFlag = flagString(args.flags, 'lambda')
  const lambda = lambdaFlag === undefined ? resolved.replayCostAversion : Number(lambdaFlag)
  if (!Number.isFinite(lambda) || lambda < 0) {
    console.error('--lambda must be a non-negative number')
    process.exit(1)
  }
  const limitFlag = flagString(args.flags, 'limit')
  const limit = limitFlag === undefined ? 20 : Math.max(0, Number(limitFlag))

  const { receipts } = await readReceipts(resolve(path))
  const result = replayReceipts(receipts, preference, lambda)

  if (args.flags.json === true) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Preference       ${result.preference} (lambda ${result.lambda})`)
  console.log(`Turns            ${result.turns}`)
  console.log(`Replayable       ${result.replayed}`)
  console.log(`Unchanged        ${result.unchanged}`)
  console.log(`Changed          ${result.changes.length}`)
  console.log('')
  if (result.changes.length > 0) {
    console.log(`${pad('turn', 6)} ${pad('from', 24)} ${pad('to', 24)} ${pad('delta', 10)}`)
    for (const change of result.changes.slice(0, limit)) {
      console.log(
        `${pad(String(change.turn), 6)} ${pad(change.from, 24)} ${pad(change.to, 24)}`
        + ` ${pad(formatUsd(change.delta), 10)}`,
      )
    }
    if (result.changes.length > limit) {
      console.log(`... ${result.changes.length - limit} more`)
    }
    console.log('')
  }
  console.log(`Cost             ${formatUsd(result.cost)}`)
  console.log(`Recorded         ${formatUsd(result.recordedCost)}`)
  console.log(`Delta            ${formatUsd(result.deltaCost)}  ${result.deltaPct.toFixed(1)}%`)
}

/** `jev-route doctor` */
async function commandDoctor(args: Args, config: RouterConfig): Promise<void> {
  const resolved = resolveConfig(config)
  const keyVariable = config.apiKey ? 'config' : 'JEV_API_KEY'
  const probe = await probeEndpoint(resolved.endpoint, Math.max(resolved.timeoutMs, 5000))

  console.log(`Endpoint         ${resolved.endpoint}`)
  console.log(`API key          ${resolved.apiKey ? `present (${keyVariable}, ${resolved.apiKey.length} chars)` : 'missing'}`)
  console.log(`Reachability     ${probe.reachable ? `reachable (${probe.detail})` : `unreachable (${probe.detail})`}`)
  console.log(`Mode             ${resolved.apiKey ? 'live' : 'fallback only'}`)
  console.log(`Timeout          ${resolved.timeoutMs} ms`)
  console.log(`Summary cap      ${resolved.maxSummaryBytes} bytes`)
  console.log(`Token profile    ${resolved.tokensInPerTurn} in / ${resolved.tokensOutPerTurn} out per turn`)
  console.log(`minConfidence    ${resolved.minConfidence}`)
  console.log(`stickyTurns      ${resolved.stickyTurns}`)
  console.log(`Default          ${resolved.defaultCandidate.label} (rank ${resolved.defaultCandidate.rank})`)
  console.log(`Escalation       ${resolved.escalationCandidate.label}`)
  console.log(`Receipts         ${resolved.receiptPath || 'disabled'}`)
  console.log('')
  console.log('Candidates')
  printCandidates(resolved, resolved.defaultCandidate.index)
  console.log('')
  console.log('Patterns')
  console.log(`  escalation     ${resolved.escalateOn.length}`)
  console.log(`  trivial        ${resolved.trivialPatterns.length}`)
  console.log(`  trivial cap    ${resolved.trivialMaxBytes} bytes`)

  if (resolved.warnings.length > 0) {
    console.log('')
    console.log('Warnings')
    for (const warning of resolved.warnings) console.log(`  ${warning}`)
  }

  if (args.flags.json === true) {
    console.log('')
    console.log(JSON.stringify({
      endpoint: resolved.endpoint,
      hasKey: resolved.apiKey.length > 0,
      reachable: probe.reachable,
      probe: probe.detail,
      defaultCandidate: resolved.defaultCandidate.label,
      escalationCandidate: resolved.escalationCandidate.label,
      candidates: resolved.candidates,
      warnings: resolved.warnings,
    }, null, 2))
  }

  if (!resolved.apiKey || !probe.reachable) process.exitCode = 1
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const config = await loadConfig(flagString(args.flags, 'config'))

  switch (args.command) {
    case 'route':
      await commandRoute(args, config)
      break
    case 'receipts':
      await commandReceipts(args)
      break
    case 'replay':
      await commandReplay(args, config)
      break
    case 'doctor':
      await commandDoctor(args, config)
      break
    default:
      console.log(`Usage: jev-route <command> [args]

Commands:
  route <summary>              Route one turn summary and print the decision
  receipts <path>              Summarise a receipts JSONL file
  replay <path> --prefer ...   Re-score recorded distributions with no Jev calls
  doctor                       Check endpoint, key, candidates and patterns

Flags:
  --config <path>              JSON configuration
  --prefer cheap|quality       Replay cost preference (default: quality)
  --lambda <n>                 Replay cost weight (default: config replayCostAversion)
  --limit <n>                  Rows printed by replay (default: 20)
  --json                       Emit JSON`)
  }
}

main().catch(error => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
