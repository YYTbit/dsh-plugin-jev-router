/**
 * Turn summaries.
 *
 * The router decides from a summary, never from a full conversation. A summary
 * is the user request plus a short digest of recent tool activity, which is
 * what makes a stack trace or a failing test visible to the escalation
 * patterns without shipping the whole context window to Jev.
 *
 * @module dsh-plugin-jev-router/summary
 */

import { byteLength, oneLine, truncateBytes } from './text.js'
import type { Candidate, TurnSummary } from './types.js'

/** Bytes of each tool observation kept in a digest. */
export const DIGEST_ENTRY_BYTES = 240

/** Number of trailing tool observations folded into a digest. */
export const DIGEST_ENTRIES = 4

/** Extract text from a message content value of unknown shape. */
function partText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part)
        continue
      }
      if (part && typeof part === 'object') {
        const record = part as Record<string, unknown>
        const text = record.text ?? record.content ?? record.output
        if (typeof text === 'string') parts.push(text)
      }
    }
    return parts.join('\n')
  }
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content)
    } catch {
      return ''
    }
  }
  return ''
}

/** First value that is a non-empty string. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

/** Last user message text in a message list. */
function lastUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || typeof message !== 'object') continue
    const record = message as Record<string, unknown>
    if (record.role !== undefined && record.role !== 'user') continue
    const text = partText(record.content)
    if (text.trim().length > 0) return text
  }
  return undefined
}

/** Digest of the trailing tool activity in a message list. */
function toolDigest(messages: unknown, toolCalls: unknown): string | undefined {
  const entries: string[] = []
  if (Array.isArray(messages)) {
    const recent = messages.slice(-DIGEST_ENTRIES * 2)
    for (const message of recent) {
      if (!message || typeof message !== 'object') continue
      const record = message as Record<string, unknown>
      const role = typeof record.role === 'string' ? record.role : ''
      if (role !== 'tool' && role !== 'assistant' && record.tool_calls === undefined) continue
      const text = oneLine(partText(record.content) || partText(record.tool_calls))
      if (text.length === 0) continue
      entries.push(`${role || 'call'}: ${truncateBytes(text, DIGEST_ENTRY_BYTES)}`)
    }
  }
  if (entries.length === 0 && toolCalls !== undefined) {
    const text = oneLine(partText(toolCalls))
    if (text.length > 0) entries.push(truncateBytes(text, DIGEST_ENTRY_BYTES))
  }
  if (entries.length === 0) return undefined
  return entries.slice(-DIGEST_ENTRIES).join(' | ')
}

/**
 * Reduce whatever a dispatch layer hands over to a turn summary.
 *
 * Accepts a plain string, a summary that already has the right shape, or a
 * turn object with `request`/`prompt`/`messages`/`toolCalls` fields. Unknown
 * shapes produce an empty request rather than an error, because the router
 * must always be able to answer with a candidate.
 */
export function summarizeTurn(turn: unknown, maxBytes = 4000): TurnSummary {
  if (typeof turn === 'string') {
    return { request: truncateBytes(oneLine(turn), maxBytes) }
  }
  if (!turn || typeof turn !== 'object') {
    return { request: '' }
  }
  const record = turn as Record<string, unknown>

  const request = firstString(
    record.request,
    record.prompt,
    record.userMessage,
    record.input,
    typeof record.message === 'string' ? record.message : undefined,
  ) ?? lastUserText(record.messages) ?? ''

  const digest = firstString(record.digest, record.toolDigest, record.toolSummary, record.trace)
    ?? toolDigest(record.messages, record.toolCalls)

  const boundedRequest = truncateBytes(oneLine(request), maxBytes)
  const summary: TurnSummary = { request: boundedRequest }
  if (digest) {
    const remaining = maxBytes - byteLength(boundedRequest)
    if (remaining > 0) summary.digest = truncateBytes(oneLine(digest), remaining)
  }
  return summary
}

/** Flatten a summary into the single block of text the router matches on. */
export function summaryText(summary: TurnSummary): string {
  return summary.digest ? `${summary.request}\n${summary.digest}` : summary.request
}

/**
 * Build the Jev state block.
 *
 * The candidate table travels with the question so the answer can be read
 * without a second lookup, and so a receipt reader can see exactly what the
 * model was choosing between.
 */
export function buildJevState(state: string, candidates: Candidate[]): string {
  const options = candidates
    .map(candidate => `[${candidate.index}] ${candidate.label}  $${candidate.costPerMTokIn}/M in  $${candidate.costPerMTokOut}/M out`)
    .join('\n')
  return `${state}\n\nOptions:\n${options}`
}
