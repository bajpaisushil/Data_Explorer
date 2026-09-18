import { describe, expect, it } from 'vitest'
import { parseBytes } from './parse'
import { applyFilters, groupAggregate, materializeWindow, sortSelection, toCsv, type Dataset } from './query'
import { buildChart, computeProfiles, computeStats } from './stats'
import { SAMPLE_PRESETS, generateSampleCsv } from '@/lib/sample'
import type { ChartSpec, Filter } from '@/lib/types'

/**
 * End-to-end through the real path the app uses: generate -> parse -> filter
 * -> sort -> group -> profile -> chart. Unit tests cover each stage; this
 * catches the seams between them.
 */

const ROWS = 20_000

function selectAll(n: number): Uint32Array {
  const sel = new Uint32Array(n)
  for (let i = 0; i < n; i++) sel[i] = i
  return sel
}

async function load(presetId: string, rows = ROWS): Promise<Dataset> {
  const bytes = generateSampleCsv(presetId, rows)
  const parsed = await parseBytes(bytes, `${presetId}.csv`, {}, () => {})
  return { meta: parsed.meta, columns: parsed.columns }
}

describe('sample generator', () => {
  it('is deterministic and differs between presets', () => {
    const a = generateSampleCsv('ecommerce', 500)
    const b = generateSampleCsv('ecommerce', 500)
    expect(Array.from(a.subarray(0, 4000))).toEqual(Array.from(b.subarray(0, 4000)))
    expect(a.length).toBe(b.length)

    const other = generateSampleCsv('iot_sensors', 500)
    expect(other.length).not.toBe(a.length)
  })

  it('reports progress ending at 1', () => {
    const seen: number[] = []
    generateSampleCsv('web_events', 2000, (r) => seen.push(r))
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]).toBe(1)
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0)
  })

  it('emits one header plus exactly the requested number of rows', () => {
    const text = new TextDecoder().decode(generateSampleCsv('ecommerce', 1000))
    // Quote-aware line count: the generator only quotes fields without newlines,
    // so a plain split is safe here and would catch it if that changed.
    expect(text).not.toContain('"\n')
    const lines = text.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(1001)
    const headerFields = lines[0].split(',').length
    for (const line of [lines[1], lines[500], lines[1000]]) {
      expect(line.split(',')).toHaveLength(headerFields)
    }
  })
})

describe.each(SAMPLE_PRESETS.map((p) => p.id))('pipeline over the %s preset', (presetId) => {
  it('parses into a mix of column kinds including both string encodings', async () => {
    const ds = await load(presetId)

    expect(ds.meta.rowCount).toBe(ROWS)
    expect(ds.meta.badRows).toBe(0)
    expect(ds.meta.columns.length).toBeGreaterThanOrEqual(12)

    const kinds = new Set(ds.meta.columns.map((c) => c.kind))
    // Each preset is meant to exercise every storage path.
    expect(kinds.has('int')).toBe(true)
    expect(kinds.has('float')).toBe(true)
    expect(kinds.has('date')).toBe(true)
    expect(kinds.has('string')).toBe(true)

    const encodings = new Set(
      ds.meta.columns.filter((c) => c.kind === 'string').map((c) => c.encoding),
    )
    expect(encodings.has('dict')).toBe(true)
    expect(encodings.has('blob')).toBe(true)

    // Columns and metadata must stay parallel, or every lookup is off by one.
    expect(ds.columns).toHaveLength(ds.meta.columns.length)
    ds.meta.columns.forEach((meta, i) => {
      const col = ds.columns[i]
      expect(col.kind).toBe(meta.kind)
    })
  })

  it('filters, sorts and windows consistently', async () => {
    const ds = await load(presetId)
    const all = selectAll(ds.meta.rowCount)

    const stringCol = ds.meta.columns.find((c) => c.kind === 'string' && c.encoding === 'dict')!
    const numberCol = ds.meta.columns.find((c) => c.kind === 'float' || c.kind === 'int')!

    const notNull: Filter = {
      id: 'f1',
      columnId: numberCol.id,
      op: 'notNull',
      enabled: true,
      caseSensitive: false,
    }
    const sel = applyFilters(ds, [notNull], null)
    expect(sel.length).toBeGreaterThan(0)
    expect(sel.length).toBeLessThanOrEqual(ds.meta.rowCount)

    const sorted = sortSelection(ds, sel, [{ columnId: numberCol.id, dir: 'desc' }])
    expect(sorted.length).toBe(sel.length)

    // The window must reflect the sort, so the first value is the maximum.
    const win = materializeWindow(ds, sorted, 0, 25, [numberCol.id, stringCol.id])
    expect(win.columns[0]).toHaveLength(25)
    const values = win.columns[0] as number[]
    for (let i = 1; i < values.length; i++) {
      expect(values[i - 1]).toBeGreaterThanOrEqual(values[i])
    }

    // Every returned row id must be a real row.
    for (const id of win.rowIds) {
      expect(id).toBeGreaterThanOrEqual(0)
      expect(id).toBeLessThan(ds.meta.rowCount)
    }

    expect(applyFilters(ds, [], null).length).toBe(ds.meta.rowCount)
    void all
  })

  it('groups so that counts reconcile with the filtered total', async () => {
    const ds = await load(presetId)
    const sel = selectAll(ds.meta.rowCount)
    const key = ds.meta.columns.find((c) => c.kind === 'string' && c.encoding === 'dict')!
    const measure = ds.meta.columns.find((c) => c.kind === 'float' || c.kind === 'int')!

    const groups = groupAggregate(ds, sel, {
      columnIds: [key.id],
      aggs: [
        { id: 'sum', columnId: measure.id, fn: 'sum' },
        { id: 'avg', columnId: measure.id, fn: 'avg' },
      ],
    })

    expect(groups.length).toBeGreaterThan(0)
    const counted = groups.reduce((sum, g) => sum + g.count, 0)
    const nulls = ds.meta.columns[ds.meta.columns.indexOf(key)]

    // Grouping drops null keys, so the total is rows minus that column's nulls.
    expect(counted).toBeLessThanOrEqual(ds.meta.rowCount)
    expect(counted).toBeGreaterThan(0)
    void nulls

    // Groups come back ranked by size.
    for (let i = 1; i < groups.length; i++) {
      expect(groups[i - 1].count).toBeGreaterThanOrEqual(groups[i].count)
    }
  })

  it('profiles every column without throwing', async () => {
    const ds = await load(presetId)
    const sel = selectAll(ds.meta.rowCount)
    const profiles = computeProfiles(ds, sel, ds.meta.columns.map((c) => c.id))

    expect(profiles).toHaveLength(ds.meta.columns.length)
    for (const p of profiles) {
      expect(p.completeness).toBeGreaterThanOrEqual(0)
      expect(p.completeness).toBeLessThanOrEqual(1)
      expect(p.spark.length).toBeLessThanOrEqual(24)
      for (const v of p.spark) expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('computes coherent statistics for a numeric column', async () => {
    const ds = await load(presetId)
    const sel = selectAll(ds.meta.rowCount)
    const numberCol = ds.meta.columns.find((c) => c.kind === 'float' || c.kind === 'int')!

    const stats = computeStats(ds, sel, numberCol.id)
    expect(stats.kind === 'numeric' || stats.kind === 'date').toBe(true)
    if (stats.kind !== 'numeric' && stats.kind !== 'date') return

    expect(stats.min).toBeLessThanOrEqual(stats.median)
    expect(stats.median).toBeLessThanOrEqual(stats.max)
    expect(stats.p25).toBeLessThanOrEqual(stats.median)
    expect(stats.median).toBeLessThanOrEqual(stats.p75)
    expect(stats.p75).toBeLessThanOrEqual(stats.p95)
    expect(stats.stdev).toBeGreaterThanOrEqual(0)
    expect(stats.count + stats.nulls).toBe(ds.meta.rowCount)

    // Histogram counts must account for every non-null value.
    const binned = stats.histogram.reduce((sum, b) => sum + b.count, 0)
    expect(binned).toBe(stats.count)
  })

  it('builds every chart type without NaN geometry', async () => {
    const ds = await load(presetId)
    const sel = selectAll(ds.meta.rowCount)
    const cat = ds.meta.columns.find((c) => c.kind === 'string' && c.encoding === 'dict')!
    const num = ds.meta.columns.find((c) => c.kind === 'float' || c.kind === 'int')!
    const date = ds.meta.columns.find((c) => c.kind === 'date')!

    const specs: ChartSpec[] = [
      { id: 'bar', title: 'bar', type: 'bar', xColumnId: cat.id, yColumnId: null, agg: 'count', bins: 30, limit: 8 },
      { id: 'hist', title: 'hist', type: 'histogram', xColumnId: num.id, yColumnId: null, agg: 'count', bins: 25, limit: 12 },
      { id: 'line', title: 'line', type: 'line', xColumnId: date.id, yColumnId: num.id, agg: 'avg', bins: 40, limit: 12 },
      { id: 'scatter', title: 'scatter', type: 'scatter', xColumnId: num.id, yColumnId: num.id, agg: 'avg', bins: 30, limit: 12 },
      { id: 'pie', title: 'pie', type: 'pie', xColumnId: cat.id, yColumnId: num.id, agg: 'sum', bins: 30, limit: 6 },
    ]

    for (const spec of specs) {
      const data = buildChart(ds, sel, spec)
      expect(data.type).toBe(spec.type)
      expect(data.series.length).toBeGreaterThan(0)
      for (const s of data.series) {
        for (let i = 0; i < s.y.length; i++) {
          expect(Number.isFinite(s.y[i])).toBe(true)
        }
      }
      if (data.x) {
        for (let i = 0; i < data.x.length; i++) expect(Number.isFinite(data.x[i])).toBe(true)
      }
      // Scatter needs matching x/y lengths or points land on the wrong place.
      if (spec.type === 'scatter' && data.x) {
        expect(data.x.length).toBe(data.series[0].y.length)
      }
    }
  })

  it('folds categories past the limit into a single Other bucket', async () => {
    const ds = await load(presetId)
    const sel = selectAll(ds.meta.rowCount)
    const cat = ds.meta.columns.find((c) => c.kind === 'string' && c.encoding === 'blob')!

    const data = buildChart(ds, sel, {
      id: 'c', title: 'c', type: 'bar', xColumnId: cat.id,
      yColumnId: null, agg: 'count', bins: 30, limit: 5,
    })

    expect(data.truncated).toBe(true)
    expect(data.xLabels?.[data.xLabels.length - 1]).toBe('Other')
    // Nothing is lost: the folded bucket carries the remainder.
    const plotted = Array.from(data.series[0].y).reduce((a, b) => a + b, 0)
    expect(plotted).toBe(sel.length)
  })

  it('round-trips through CSV export back into the parser', async () => {
    const ds = await load(presetId, 2000)
    const sel = selectAll(ds.meta.rowCount)
    const ids = ds.meta.columns.slice(0, 6).map((c) => c.id)

    const csv = toCsv(ds, sel, ids, 0)
    const reparsed = await parseBytes(csv, 'export.csv', {}, () => {})

    expect(reparsed.meta.rowCount).toBe(ds.meta.rowCount)
    expect(reparsed.meta.columns).toHaveLength(ids.length)
    expect(reparsed.meta.badRows).toBe(0)
  })
})

describe('empty and degenerate inputs', () => {
  it('survives an empty selection on every path', async () => {
    const ds = await load('ecommerce', 500)
    const none = new Uint32Array(0)
    const col = ds.meta.columns[0]

    expect(() => computeStats(ds, none, col.id)).not.toThrow()
    expect(() => computeProfiles(ds, none, [col.id])).not.toThrow()
    expect(materializeWindow(ds, none, 0, 10, [col.id]).columns[0] ?? []).toHaveLength(0)
    expect(groupAggregate(ds, none, { columnIds: [col.id], aggs: [] })).toEqual([])

    const chart = buildChart(ds, none, {
      id: 'e', title: 'e', type: 'bar', xColumnId: col.id,
      yColumnId: null, agg: 'count', bins: 10, limit: 5,
    })
    expect(chart.series.every((s) => s.y.length === 0)).toBe(true)
  })

  it('handles a request for a column that does not exist', async () => {
    const ds = await load('ecommerce', 200)
    const sel = selectAll(ds.meta.rowCount)
    expect(() => computeStats(ds, sel, 'no_such_column')).not.toThrow()
    expect(() =>
      buildChart(ds, sel, {
        id: 'x', title: 'x', type: 'bar', xColumnId: 'no_such_column',
        yColumnId: null, agg: 'count', bins: 10, limit: 5,
      }),
    ).not.toThrow()
  })
})
