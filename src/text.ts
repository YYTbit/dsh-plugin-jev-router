/**
 * Text helpers shared by summaries, receipts and the CLI.
 *
 * Every size in this plugin is a UTF-8 byte count, never a character count,
 * because the number the router budgets is the byte length of the turn summary
 * it sends to Jev.
 *
 * @module dsh-plugin-jev-router/text
 */

import { createHash } from 'node:crypto'

/** UTF-8 byte length of a string. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** First 16 hex characters of the SHA-256 of a string. */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Truncate to at most `max` UTF-8 bytes without splitting a codepoint.
 * Walks codepoints because slicing a Buffer can leave a broken character.
 */
export function truncateBytes(text: string, max: number): string {
  if (max <= 0) return ''
  if (byteLength(text) <= max) return text
  let used = 0
  let out = ''
  for (const ch of text) {
    const size = byteLength(ch)
    if (used + size > max) break
    out += ch
    used += size
  }
  return out
}

/** Collapse all whitespace runs so a string renders on one line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Clamp a number into [0, 1], mapping NaN to 0. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

/**
 * Format a USD amount with enough digits to stay meaningful.
 * Per-turn costs are fractions of a cent, so small values keep four to six.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0'
  const abs = Math.abs(value)
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
  return `$${value.toFixed(digits)}`
}

/** Right-pad a string to a fixed width, truncating when it does not fit. */
export function pad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width)
  return text + ' '.repeat(width - text.length)
}
