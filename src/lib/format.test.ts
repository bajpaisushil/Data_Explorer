import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatCell,
  formatCompact,
  formatCount,
  formatDate,
  formatDuration,
  formatNumber,
  formatPercent,
  kindShort,
  pluralize,
  seriesVar,
  seriesVars,
  slugify,
  truncateMiddle,
} from './format'

describe('formatNumber', () => {
  it('groups thousands and caps fraction digits', () => {
    expect(formatNumber(1234567.891)).toBe('1,234,567.891')
    expect(formatNumber(0.5, { maxFrac: 1 })).toBe('0.5')
  })

  it('falls back to exponential outside the readable band', () => {
    expect(formatNumber(1e-5)).toBe('1.0000e-5')
    expect(formatNumber(1e16)).toBe('1.0000e+16')
    // The boundaries themselves stay in decimal notation.
    expect(formatNumber(1e-4)).toBe('0.0001')
    expect(formatNumber(-1234.5)).toBe('-1,234.5')
  })

  it('treats zero as decimal, not exponential', () => {
    expect(formatNumber(0)).toBe('0')
  })

  it('returns empty for non-finite input', () => {
    expect(formatNumber(NaN)).toBe('')
    expect(formatNumber(Infinity)).toBe('')
  })
})

describe('formatCount / formatCompact / formatPercent', () => {
  it('formats counts and compacts large numbers', () => {
    expect(formatCount(1234567)).toBe('1,234,567')
    expect(formatCompact(1200)).toBe('1.2K')
    expect(formatCompact(1_200_000)).toBe('1.2M')
    expect(formatCompact(1_200_000_000)).toBe('1.2B')
    expect(formatPercent(0.125)).toBe('12.5%')
  })
})

describe('formatBytes', () => {
  it('switches units at the binary boundaries', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1,023 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  it('rejects negative and non-finite sizes', () => {
    expect(formatBytes(-1)).toBe('')
    expect(formatBytes(NaN)).toBe('')
  })
})

describe('formatDuration', () => {
  it('scales from sub-millisecond to minutes', () => {
    expect(formatDuration(0.4)).toBe('<1 ms')
    expect(formatDuration(840)).toBe('840 ms')
    expect(formatDuration(1400)).toBe('1.4 s')
    expect(formatDuration(65_000)).toBe('1m 5s')
  })
})

describe('formatDate', () => {
  it('is UTC-stable regardless of the host timezone', () => {
    // 23:30 UTC would be the *next* day in some zones and the previous in
    // others; a data tool must not disagree with itself across machines.
    const ms = Date.UTC(2024, 2, 15, 23, 30, 0)
    expect(formatDate(ms)).toBe('2024-03-15 23:30:00')
    expect(formatDate(ms, 'date')).toBe('2024-03-15')
    expect(formatDate(ms, 'time')).toBe('23:30:00')
  })

  it('drops the time component on an exact UTC midnight', () => {
    expect(formatDate(Date.UTC(2024, 0, 1))).toBe('2024-01-01')
  })

  it('handles pre-epoch dates', () => {
    expect(formatDate(Date.UTC(1969, 6, 20))).toBe('1969-07-20')
  })

  it('returns empty for NaN', () => {
    expect(formatDate(NaN)).toBe('')
  })
})

describe('formatCell', () => {
  it('renders null as empty so the grid can draw its own affordance', () => {
    expect(formatCell(null, 'string')).toBe('')
    expect(formatCell(null, 'int')).toBe('')
  })

  it('formats by column kind', () => {
    expect(formatCell(1234, 'int')).toBe('1,234')
    expect(formatCell(1234.5678, 'float')).toBe('1,234.5678')
    expect(formatCell(true, 'bool')).toBe('true')
    expect(formatCell('hello', 'string')).toBe('hello')
    expect(formatCell(Date.UTC(2024, 0, 1), 'date')).toBe('2024-01-01')
  })

  it('treats NaN in a quantitative column as null', () => {
    expect(formatCell(NaN, 'float')).toBe('')
    expect(formatCell(NaN, 'int')).toBe('')
  })
})

describe('seriesVar', () => {
  it('assigns the eight slots in fixed order', () => {
    expect(seriesVar(0)).toBe('var(--series-1)')
    expect(seriesVar(7)).toBe('var(--series-8)')
  })

  it('never cycles past slot 8 — a ninth hue would break the palette', () => {
    expect(seriesVar(8)).toBe('var(--ink-3)')
    expect(seriesVar(99)).toBe('var(--ink-3)')
    expect(seriesVar(-1)).toBe('var(--ink-3)')
  })

  it('returns neutrals beyond eight in seriesVars', () => {
    const vars = seriesVars(10)
    expect(vars).toHaveLength(10)
    expect(vars[7]).toBe('var(--series-8)')
    expect(vars[8]).toBe('var(--ink-3)')
  })
})

describe('truncateMiddle', () => {
  it('never exceeds max', () => {
    for (const max of [1, 2, 3, 5, 8, 12]) {
      expect(truncateMiddle('abcdefghijklmnopqrstuvwxyz', max).length).toBeLessThanOrEqual(max)
    }
  })

  it('keeps head and tail', () => {
    expect(truncateMiddle('abcdefghij', 7)).toBe('abc…hij')
    expect(truncateMiddle('short', 10)).toBe('short')
  })
})

describe('slugify', () => {
  it('collapses punctuation and strips accents', () => {
    expect(slugify('Order Date (UTC)')).toBe('order_date_utc')
    expect(slugify('  café—naïve  ')).toBe('cafe_naive')
    expect(slugify('%%%')).toBe('column')
  })
})

describe('kindShort / pluralize', () => {
  it('labels every kind', () => {
    expect(kindShort('int')).toBe('123')
    expect(kindShort('date')).toBe('cal')
    expect(pluralize(1, 'row')).toBe('row')
    expect(pluralize(2, 'row')).toBe('rows')
    expect(pluralize(0, 'match', 'matches')).toBe('matches')
  })
})
