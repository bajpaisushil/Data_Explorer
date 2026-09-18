/**
 * Display formatting. Called once per visible cell, so every formatter is
 * cheap and every Intl instance is built once and reused — constructing an
 * Intl.NumberFormat inside a render loop is the classic way to make a fast
 * grid slow.
 */

import type { CellValue, ColumnKind } from '@/lib/types'

const LOCALE = 'en-US'

const intCache = new Map<number, Intl.NumberFormat>()

function grouped(maxFrac: number): Intl.NumberFormat {
  let fmt = intCache.get(maxFrac)
  if (!fmt) {
    fmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: maxFrac })
    intCache.set(maxFrac, fmt)
  }
  return fmt
}

const COUNT = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 })
const COMPACT = new Intl.NumberFormat(LOCALE, {
  notation: 'compact',
  maximumFractionDigits: 1,
})

/* ---------------------------------------------------------------- numbers */

export function formatNumber(v: number, opts?: { maxFrac?: number; compact?: boolean }): string {
  if (!Number.isFinite(v)) return ''
  if (opts?.compact) return COMPACT.format(v)

  const abs = Math.abs(v)
  // Outside this band, grouped decimal notation stops being readable.
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e15)) return v.toExponential(4)

  return grouped(opts?.maxFrac ?? 6).format(v)
}

export function formatCount(v: number): string {
  if (!Number.isFinite(v)) return ''
  return COUNT.format(v)
}

export function formatCompact(v: number): string {
  if (!Number.isFinite(v)) return ''
  return COMPACT.format(v)
}

export function formatPercent(v: number, frac = 1): string {
  if (!Number.isFinite(v)) return ''
  return `${grouped(frac).format(v * 100)}%`
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function formatBytes(v: number): string {
  if (!Number.isFinite(v) || v < 0) return ''
  let n = v
  let unit = 0
  while (n >= 1024 && unit < BYTE_UNITS.length - 1) {
    n /= 1024
    unit++
  }
  const frac = unit === 0 ? 0 : n < 10 ? 1 : n < 100 ? 1 : 0
  return `${grouped(frac).format(n)} ${BYTE_UNITS[unit]}`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${grouped(1).format(ms / 1000)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

/* ------------------------------------------------------------------ dates */

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/**
 * Always UTC and always sortable. A data tool that silently shifts timestamps
 * into the viewer's timezone makes two people reading the same file disagree
 * about what it says.
 */
export function formatDate(ms: number, precision: 'auto' | 'date' | 'datetime' | 'time' = 'auto'): string {
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`

  if (precision === 'date') return date
  if (precision === 'time') return time
  if (precision === 'datetime') return `${date} ${time}`

  // 'auto': drop the time when the value lands exactly on a UTC midnight.
  const inDay = ((ms % 86_400_000) + 86_400_000) % 86_400_000
  return inDay === 0 ? date : `${date} ${time}`
}

/* ------------------------------------------------------------------ cells */

export function formatCell(v: CellValue, kind: ColumnKind, _dateFormat?: string): string {
  if (v === null) return ''
  switch (kind) {
    case 'date':
      return typeof v === 'number' ? formatDate(v) : String(v)
    case 'int':
      return typeof v === 'number' ? (Number.isFinite(v) ? COUNT.format(v) : '') : String(v)
    case 'float':
      return typeof v === 'number' ? formatNumber(v) : String(v)
    case 'bool':
      return typeof v === 'boolean' ? String(v) : v === 1 ? 'true' : v === 0 ? 'false' : String(v)
    default:
      return String(v)
  }
}

/* ------------------------------------------------------------------ kinds */

const KIND_LABEL: Record<ColumnKind, string> = {
  int: 'Integer',
  float: 'Decimal',
  string: 'Text',
  date: 'Date',
  bool: 'Boolean',
}

const KIND_SHORT: Record<ColumnKind, string> = {
  int: '123',
  float: '1.0',
  string: 'abc',
  date: 'cal',
  bool: 'T/F',
}

const KIND_VAR: Record<ColumnKind, string> = {
  int: 'var(--kind-number)',
  float: 'var(--kind-number)',
  string: 'var(--kind-string)',
  date: 'var(--kind-date)',
  bool: 'var(--kind-bool)',
}

export function kindLabel(kind: ColumnKind): string {
  return KIND_LABEL[kind] ?? 'Text'
}

export function kindShort(kind: ColumnKind): string {
  return KIND_SHORT[kind] ?? 'abc'
}

export function kindColorVar(kind: ColumnKind): string {
  return KIND_VAR[kind] ?? 'var(--kind-string)'
}

/* ----------------------------------------------------------------- series */

/**
 * Categorical slots are assigned in fixed order and never cycled — a ninth
 * generated hue would break the palette's colour-vision guarantees, so
 * anything past slot 8 gets the neutral "Other" ink instead.
 */
export function seriesVar(index: number): string {
  if (index < 0 || index >= 8) return 'var(--ink-3)'
  return `var(--series-${index + 1})`
}

export function seriesVars(count: number): string[] {
  const out: string[] = []
  for (let i = 0; i < count; i++) out.push(seriesVar(i))
  return out
}

/* ------------------------------------------------------------------ text */

export function truncateMiddle(s: string, max: number): string {
  if (max <= 0) return ''
  if (s.length <= max) return s
  if (max <= 1) return '…'
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return tail === 0 ? `${s.slice(0, head)}…` : `${s.slice(0, head)}…${s.slice(s.length - tail)}`
}

export function slugify(s: string): string {
  const base = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return base || 'column'
}

export function pluralize(n: number, one: string, many?: string): string {
  return n === 1 ? one : (many ?? `${one}s`)
}
