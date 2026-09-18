/**
 * Column profiling, summary statistics and chart aggregation.
 *
 * Everything here runs against the *current selection* — the filtered row set —
 * so a profile always describes what the user is actually looking at rather
 * than the file they happened to open.
 */

import { columnIndexOf, readString, type Dataset } from './query'
import {
  type AggFn,
  type BoolStats,
  type CategoricalStats,
  type ChartData,
  type ChartSeries,
  type ChartSpec,
  type ColumnData,
  type ColumnProfile,
  type ColumnStats,
  type HistogramBin,
  type QuantitativeStats,
  type ValueCount,
} from '@/lib/types'

/** Above this many values, order statistics run on a strided sample. */
const SAMPLE_CEILING = 2_000_000
const DISTINCT_CAP = 100_000
const SPARK_BINS = 24
/** Above this many categories a sparkline is noise, so it is not worth building. */
const SPARK_MAX_CATEGORIES = 100

/* ------------------------------------------------------------ bin helpers */

const NICE_STEPS = [1, 2, 2.5, 5, 10]

export function niceBins(
  min: number,
  max: number,
  target: number,
): { start: number; width: number; count: number } {
  const want = Math.max(1, Math.min(200, Math.round(target) || 30))

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { start: 0, width: 1, count: 1 }
  }
  if (min === max) {
    // A single value still deserves a bin it sits inside.
    return { start: min - 0.5, width: 1, count: 1 }
  }
  if (min > max) {
    const t = min
    min = max
    max = t
  }

  const raw = (max - min) / want
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)))
  let width = magnitude * NICE_STEPS[NICE_STEPS.length - 1]
  for (const step of NICE_STEPS) {
    const candidate = magnitude * step
    if (candidate >= raw) {
      width = candidate
      break
    }
  }

  const start = Math.floor(min / width) * width
  const count = Math.max(1, Math.min(400, Math.ceil((max - start) / width) || 1))
  return { start, width, count }
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const DATE_UNITS = [SECOND, 10 * SECOND, MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR, 6 * HOUR, DAY, 7 * DAY, 30 * DAY, 91 * DAY, 365 * DAY]

/** Calendar-ish bins on UTC boundaries, so a "day" starts where users expect. */
function dateBins(min: number, max: number, target: number): { start: number; width: number; count: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return { start: min - DAY / 2, width: DAY, count: 1 }
  }
  const span = max - min
  let width = DATE_UNITS[DATE_UNITS.length - 1]
  let best = Infinity
  for (const unit of DATE_UNITS) {
    const score = Math.abs(span / unit - target)
    if (score < best) {
      best = score
      width = unit
    }
  }
  const start = Math.floor(min / width) * width
  const count = Math.max(1, Math.min(400, Math.ceil((max - start) / width) || 1))
  return { start, width, count }
}

export function quantileSorted(sorted: Float64Array, q: number): number {
  const n = sorted.length
  if (n === 0) return NaN
  if (n === 1) return sorted[0]
  const pos = (n - 1) * Math.max(0, Math.min(1, q))
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/* ------------------------------------------------------- value collection */

/** Non-null numeric values for the selection, strided when very large. */
function collectNumeric(col: ColumnData, sel: Uint32Array): Float64Array {
  if (col.kind === 'string' || col.kind === 'bool') return new Float64Array(0)
  const src = col.values
  const stride = sel.length > SAMPLE_CEILING ? Math.ceil(sel.length / SAMPLE_CEILING) : 1
  const capacity = Math.ceil(sel.length / stride)
  const out = new Float64Array(capacity)
  let n = 0
  for (let i = 0; i < sel.length; i += stride) {
    const v = src[sel[i]]
    if (v === v) out[n++] = v
  }
  return out.subarray(0, n)
}

/* ------------------------------------------------------------------ stats */

function quantitativeStats(
  col: ColumnData,
  sel: Uint32Array,
  isDate: boolean,
  bins: number,
): QuantitativeStats {
  const empty: QuantitativeStats = {
    kind: isDate ? 'date' : 'numeric',
    count: 0, nulls: 0, distinct: 0,
    min: NaN, max: NaN, mean: NaN, median: NaN,
    p25: NaN, p75: NaN, p95: NaN, stdev: NaN, sum: 0,
    histogram: [], outlierCount: 0,
  }
  if (col.kind === 'string' || col.kind === 'bool') return empty

  const src = col.values
  let count = 0
  let nulls = 0
  let min = Infinity
  let max = -Infinity
  let sum = 0
  // Welford — the naive sqrt(E[x²] - E[x]²) loses precision badly on large
  // values with small variance, which is exactly what timestamps look like.
  let mean = 0
  let m2 = 0
  const distinct = new Set<number>()
  let distinctOverflow = false

  for (let i = 0; i < sel.length; i++) {
    const v = src[sel[i]]
    if (v !== v) {
      nulls++
      continue
    }
    count++
    sum += v
    if (v < min) min = v
    if (v > max) max = v
    const delta = v - mean
    mean += delta / count
    m2 += delta * (v - mean)
    if (!distinctOverflow) {
      distinct.add(v)
      if (distinct.size > DISTINCT_CAP) distinctOverflow = true
    }
  }

  if (count === 0) return { ...empty, nulls }

  const sorted = collectNumeric(col, sel)
  sorted.sort()

  const median = quantileSorted(sorted, 0.5)
  const p25 = quantileSorted(sorted, 0.25)
  const p75 = quantileSorted(sorted, 0.75)
  const p95 = quantileSorted(sorted, 0.95)
  const iqr = p75 - p25
  const lo = p25 - 1.5 * iqr
  const hi = p75 + 1.5 * iqr

  let outlierCount = 0
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] < lo || sorted[i] > hi) outlierCount++
  }
  // Scale back up when the order statistics ran on a sample.
  if (sorted.length && sorted.length < count) {
    outlierCount = Math.round((outlierCount / sorted.length) * count)
  }

  return {
    kind: isDate ? 'date' : 'numeric',
    count,
    nulls,
    distinct: distinctOverflow ? -1 : distinct.size,
    min,
    max,
    mean,
    median,
    p25,
    p75,
    p95,
    stdev: count > 1 ? Math.sqrt(m2 / (count - 1)) : 0,
    sum,
    histogram: histogramOf(col, sel, isDate, bins, min, max),
    outlierCount,
  }
}

function histogramOf(
  col: ColumnData,
  sel: Uint32Array,
  isDate: boolean,
  bins: number,
  min: number,
  max: number,
): HistogramBin[] {
  if (col.kind === 'string' || col.kind === 'bool') return []
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []

  const spec = isDate ? dateBins(min, max, bins) : niceBins(min, max, bins)
  const counts = new Int32Array(spec.count)
  const src = col.values

  for (let i = 0; i < sel.length; i++) {
    const v = src[sel[i]]
    if (v !== v) continue
    let idx = Math.floor((v - spec.start) / spec.width)
    if (idx < 0) idx = 0
    else if (idx >= spec.count) idx = spec.count - 1
    counts[idx]++
  }

  const out: HistogramBin[] = new Array(spec.count)
  for (let b = 0; b < spec.count; b++) {
    out[b] = {
      start: spec.start + b * spec.width,
      end: spec.start + (b + 1) * spec.width,
      count: counts[b],
    }
  }
  return out
}

function categoricalStats(col: ColumnData, sel: Uint32Array, topN: number): CategoricalStats {
  let nulls = 0
  let count = 0
  let emptyCount = 0
  let minLength = Infinity
  let maxLength = 0
  let lengthSum = 0
  let top: ValueCount[] = []
  let distinct = 0

  if (col.kind === 'string' && col.encoding === 'dict') {
    // Tally into an array indexed by code — never a Map keyed by the string.
    const counts = new Int32Array(col.dictionary.length)
    const codes = col.codes
    for (let i = 0; i < sel.length; i++) {
      const code = codes[sel[i]]
      if (code < 0) {
        nulls++
        continue
      }
      counts[code]++
      count++
    }
    const order: number[] = []
    for (let c = 0; c < counts.length; c++) {
      if (counts[c] > 0) {
        distinct++
        order.push(c)
        const len = col.dictionary[c].length
        if (len === 0) emptyCount += counts[c]
        if (len < minLength) minLength = len
        if (len > maxLength) maxLength = len
        lengthSum += len * counts[c]
      }
    }
    order.sort((a, b) => counts[b] - counts[a])
    top = order.slice(0, topN).map((c) => ({ value: col.dictionary[c], count: counts[c] }))
  } else if (col.kind === 'string') {
    const tally = new Map<string, number>()
    let overflow = false
    for (let i = 0; i < sel.length; i++) {
      const v = readString(col, sel[i])
      if (v === null) {
        nulls++
        continue
      }
      count++
      if (v.length === 0) emptyCount++
      if (v.length < minLength) minLength = v.length
      if (v.length > maxLength) maxLength = v.length
      lengthSum += v.length
      if (!overflow) {
        tally.set(v, (tally.get(v) ?? 0) + 1)
        if (tally.size > DISTINCT_CAP) overflow = true
      }
    }
    distinct = overflow ? -1 : tally.size
    top = [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([value, c]) => ({ value, count: c }))
  }

  return {
    kind: 'categorical',
    count,
    nulls,
    distinct,
    top,
    minLength: minLength === Infinity ? 0 : minLength,
    maxLength,
    avgLength: count ? lengthSum / count : 0,
    emptyCount,
  }
}

/**
 * Exact null count for a text column without materialising a single string.
 * The tally path allocates one JS string per row, which on a million-row
 * unique-id column costs seconds — and for such a column the tally is then
 * discarded, because no sparkline is drawn for it.
 */
function countStringNulls(col: ColumnData, sel: Uint32Array): number {
  if (col.kind !== 'string') return 0
  let nulls = 0
  if (col.encoding === 'dict') {
    const codes = col.codes
    for (let i = 0; i < sel.length; i++) if (codes[sel[i]] < 0) nulls++
  } else {
    const bits = col.nulls
    for (let i = 0; i < sel.length; i++) {
      const r = sel[i]
      if ((bits[r >> 3] >> (r & 7)) & 1) nulls++
    }
  }
  return nulls
}

/**
 * Folds a bin series down to at most `max` buckets by summing adjacent groups.
 * Slicing would be wrong: the binner may return more bins than asked for, and
 * cutting the tail makes a sparkline that silently omits the largest values.
 * Condensing keeps the shape and, crucially, keeps the total.
 */
function condense(values: number[], max: number): number[] {
  if (values.length <= max) return values
  const out = new Array<number>(max).fill(0)
  for (let i = 0; i < values.length; i++) {
    const bucket = Math.min(max - 1, Math.floor((i / values.length) * max))
    out[bucket] += values[i]
  }
  return out
}

function boolStats(col: ColumnData, sel: Uint32Array): BoolStats {
  let trueCount = 0
  let falseCount = 0
  let nulls = 0
  if (col.kind === 'bool') {
    const src = col.values
    for (let i = 0; i < sel.length; i++) {
      const v = src[sel[i]]
      if (v === 1) trueCount++
      else if (v === 0) falseCount++
      else nulls++
    }
  }
  return { kind: 'bool', count: trueCount + falseCount, nulls, trueCount, falseCount }
}

export function computeStats(
  ds: Dataset,
  sel: Uint32Array,
  columnId: string,
  bins = 30,
): ColumnStats {
  const index = columnIndexOf(ds.meta, columnId)
  if (index < 0) {
    return { kind: 'categorical', count: 0, nulls: 0, distinct: 0, top: [], minLength: 0, maxLength: 0, avgLength: 0, emptyCount: 0 }
  }
  const meta = ds.meta.columns[index]
  const col = ds.columns[index]

  if (meta.kind === 'bool') return boolStats(col, sel)
  if (meta.kind === 'string') return categoricalStats(col, sel, 20)
  return quantitativeStats(col, sel, meta.kind === 'date', bins)
}

/* --------------------------------------------------------------- profiles */

export function computeProfiles(
  ds: Dataset,
  sel: Uint32Array,
  columnIds: string[],
  bins = SPARK_BINS,
): ColumnProfile[] {
  const out: ColumnProfile[] = []
  const total = sel.length || 1

  for (const columnId of columnIds) {
    const index = columnIndexOf(ds.meta, columnId)
    if (index < 0) continue
    const meta = ds.meta.columns[index]
    const col = ds.columns[index]

    let nulls = 0
    let spark: number[] = []

    if (meta.kind === 'bool') {
      const s = boolStats(col, sel)
      nulls = s.nulls
      spark = [s.falseCount, s.trueCount]
    } else if (meta.kind === 'string') {
      const categories =
        meta.distinctCount >= 0
          ? meta.distinctCount
          : col.kind === 'string' && col.encoding === 'dict'
            ? col.dictionary.length
            : Infinity

      if (categories <= SPARK_MAX_CATEGORIES) {
        // Cheap: tallies Int32Array codes, no strings involved.
        const s = categoricalStats(col, sel, SPARK_BINS)
        nulls = s.nulls
        spark = s.top.map((t) => t.count)
      } else {
        // Too many categories to plot, so only the null count is wanted.
        nulls = countStringNulls(col, sel)
        spark = []
      }
    } else if (col.kind !== 'string' && col.kind !== 'bool') {
      const src = col.values
      let min = Infinity
      let max = -Infinity
      for (let i = 0; i < sel.length; i++) {
        const v = src[sel[i]]
        if (v !== v) nulls++
        else {
          if (v < min) min = v
          if (v > max) max = v
        }
      }
      spark = histogramOf(col, sel, meta.kind === 'date', bins, min, max).map((b) => b.count)
    }

    out.push({
      columnId,
      stats: computeStatsCheap(meta.kind, nulls, sel.length),
      completeness: (sel.length - nulls) / total,
      spark: condense(spark, SPARK_BINS),
    })
  }

  return out
}

/**
 * Profiles only carry completeness and a sparkline; the full stats object is
 * fetched on demand when a column is expanded, so this placeholder stays cheap.
 */
function computeStatsCheap(kind: string, nulls: number, rows: number): ColumnStats {
  if (kind === 'bool') return { kind: 'bool', count: rows - nulls, nulls, trueCount: 0, falseCount: 0 }
  if (kind === 'string') {
    return {
      kind: 'categorical', count: rows - nulls, nulls, distinct: -1,
      top: [], minLength: 0, maxLength: 0, avgLength: 0, emptyCount: 0,
    }
  }
  return {
    kind: kind === 'date' ? 'date' : 'numeric',
    count: rows - nulls, nulls, distinct: -1,
    min: NaN, max: NaN, mean: NaN, median: NaN, p25: NaN, p75: NaN, p95: NaN,
    stdev: NaN, sum: 0, histogram: [], outlierCount: 0,
  }
}

/* ----------------------------------------------------------------- charts */

const OTHER = 'Other'

interface Accumulator {
  sum: number
  count: number
  min: number
  max: number
  nulls: number
  values: number[] | null
}

function newAcc(needValues: boolean): Accumulator {
  return { sum: 0, count: 0, min: Infinity, max: -Infinity, nulls: 0, values: needValues ? [] : null }
}

function push(acc: Accumulator, v: number) {
  if (v !== v) {
    acc.nulls++
    return
  }
  acc.sum += v
  acc.count++
  if (v < acc.min) acc.min = v
  if (v > acc.max) acc.max = v
  acc.values?.push(v)
}

function finish(acc: Accumulator, fn: AggFn, rows: number): number {
  switch (fn) {
    case 'count':
      return rows
    case 'sum':
      return acc.sum
    case 'avg':
      return acc.count ? acc.sum / acc.count : NaN
    case 'min':
      return acc.count ? acc.min : NaN
    case 'max':
      return acc.count ? acc.max : NaN
    case 'nulls':
      return acc.nulls
    case 'distinct':
      return acc.values ? new Set(acc.values).size : NaN
    case 'median': {
      if (!acc.values || !acc.values.length) return NaN
      const arr = Float64Array.from(acc.values)
      arr.sort()
      return quantileSorted(arr, 0.5)
    }
    default:
      return NaN
  }
}

function emptyChart(spec: ChartSpec, xLabel = '', yLabel = ''): ChartData {
  return {
    type: spec.type,
    xLabels: null,
    x: null,
    xEnd: null,
    series: [],
    xLabel,
    yLabel,
    xIsDate: false,
    truncated: false,
    totalCategories: 0,
    sampled: 0,
  }
}

function labelFor(spec: ChartSpec, measureName: string | null): string {
  if (!spec.yColumnId || spec.agg === 'count') return 'rows'
  return `${spec.agg} of ${measureName ?? ''}`.trim()
}

export function buildChart(ds: Dataset, sel: Uint32Array, spec: ChartSpec): ChartData {
  const xIndex = columnIndexOf(ds.meta, spec.xColumnId)
  if (xIndex < 0) return emptyChart(spec)

  const xMeta = ds.meta.columns[xIndex]
  const xCol = ds.columns[xIndex]
  const yIndex = spec.yColumnId ? columnIndexOf(ds.meta, spec.yColumnId) : -1
  const yMeta = yIndex >= 0 ? ds.meta.columns[yIndex] : null
  const yCol = yIndex >= 0 ? ds.columns[yIndex] : null
  const yLabel = labelFor(spec, yMeta?.name ?? null)
  const quantitativeX = xMeta.kind !== 'string' && xMeta.kind !== 'bool'

  if (sel.length === 0) return emptyChart(spec, xMeta.name, yLabel)

  if (spec.type === 'scatter') {
    return buildScatter(ds, sel, spec, xIndex, yIndex, xMeta.name, yMeta?.name ?? '', xMeta.kind === 'date')
  }

  if (spec.type === 'histogram' || (quantitativeX && spec.type === 'line' && false)) {
    return buildHistogram(xCol, sel, spec, xMeta.name, xMeta.kind === 'date')
  }

  // Categorical aggregation covers bar, pie and line-over-discrete-x.
  const needValues = spec.agg === 'median' || spec.agg === 'distinct'
  const keys: string[] = []
  const keyOrder = new Map<string, number>()
  const accs: Accumulator[] = []
  const rowCounts: number[] = []
  const keyNumbers: number[] = []

  // Quantitative x on a bar/line chart is binned first, so the axis stays honest.
  let binSpec: { start: number; width: number; count: number } | null = null
  if (quantitativeX && (xCol.kind === 'int' || xCol.kind === 'float' || xCol.kind === 'date')) {
    let min = Infinity
    let max = -Infinity
    const src = xCol.values
    for (let i = 0; i < sel.length; i++) {
      const v = src[sel[i]]
      if (v !== v) continue
      if (v < min) min = v
      if (v > max) max = v
    }
    const distinctGuess = xMeta.distinctCount
    if (distinctGuess < 0 || distinctGuess > 2000) {
      binSpec =
        xMeta.kind === 'date' ? dateBins(min, max, spec.bins || 40) : niceBins(min, max, spec.bins || 40)
    }
  }

  for (let i = 0; i < sel.length; i++) {
    const row = sel[i]
    let key: string
    let keyNumber = NaN

    if (xCol.kind === 'string') {
      const s = readString(xCol, row)
      if (s === null) continue
      key = s
    } else if (xCol.kind === 'bool') {
      const b = xCol.values[row]
      if (b === 2) continue
      key = b === 1 ? 'true' : 'false'
    } else {
      const v = xCol.values[row]
      if (v !== v) continue
      if (binSpec) {
        const idx = Math.max(0, Math.min(binSpec.count - 1, Math.floor((v - binSpec.start) / binSpec.width)))
        keyNumber = binSpec.start + idx * binSpec.width
      } else {
        keyNumber = v
      }
      key = String(keyNumber)
    }

    let slot = keyOrder.get(key)
    if (slot === undefined) {
      slot = keys.length
      keyOrder.set(key, slot)
      keys.push(key)
      keyNumbers.push(keyNumber)
      accs.push(newAcc(needValues))
      rowCounts.push(0)
    }
    rowCounts[slot]++
    if (yCol && (yCol.kind === 'int' || yCol.kind === 'float' || yCol.kind === 'date')) {
      push(accs[slot], yCol.values[row])
    }
  }

  if (!keys.length) return emptyChart(spec, xMeta.name, yLabel)

  const totalCategories = keys.length
  const values = accs.map((a, i) => finish(a, spec.yColumnId ? spec.agg : 'count', rowCounts[i]))

  // A line over a quantitative or date axis must stay in x order; categories
  // are ranked by value so the interesting ones survive the top-N cut.
  const isOrdered = spec.type === 'line' && quantitativeX
  let order = values.map((_, i) => i)
  if (isOrdered) {
    order.sort((a, b) => keyNumbers[a] - keyNumbers[b])
  } else {
    order.sort((a, b) => (values[b] || 0) - (values[a] || 0))
  }

  const limit = Math.max(1, spec.limit || 12)
  let truncated = false
  let kept = order
  let otherValue = 0

  if (!isOrdered && order.length > limit) {
    truncated = true
    kept = order.slice(0, limit)
    // Everything past the cut folds into one trailing "Other" — never dropped
    // silently, and never given a new hue.
    for (const i of order.slice(limit)) otherValue += values[i] || 0
  }

  const xLabels = kept.map((i) => keys[i])
  const y = new Float64Array(kept.length + (truncated ? 1 : 0))
  kept.forEach((idx, i) => {
    y[i] = values[idx]
  })
  if (truncated) {
    xLabels.push(OTHER)
    y[y.length - 1] = otherValue
  }

  const x = isOrdered ? Float64Array.from(kept.map((i) => keyNumbers[i])) : null

  return {
    type: spec.type,
    xLabels: isOrdered ? null : xLabels,
    x,
    xEnd: null,
    series: [{ name: yLabel, y }],
    xLabel: xMeta.name,
    yLabel,
    xIsDate: xMeta.kind === 'date',
    truncated,
    totalCategories,
    sampled: sel.length,
  }
}

function buildHistogram(
  col: ColumnData,
  sel: Uint32Array,
  spec: ChartSpec,
  xLabel: string,
  isDate: boolean,
): ChartData {
  if (col.kind === 'string' || col.kind === 'bool') return emptyChart(spec, xLabel, 'rows')

  const src = col.values
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < sel.length; i++) {
    const v = src[sel[i]]
    if (v !== v) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min)) return emptyChart(spec, xLabel, 'rows')

  const bins = histogramOf(col, sel, isDate, spec.bins || 30, min, max)
  const x = new Float64Array(bins.length)
  const xEnd = new Float64Array(bins.length)
  const y = new Float64Array(bins.length)
  for (let i = 0; i < bins.length; i++) {
    x[i] = bins[i].start
    xEnd[i] = bins[i].end
    y[i] = bins[i].count
  }

  return {
    type: 'histogram',
    xLabels: null,
    x,
    xEnd,
    series: [{ name: 'rows', y }],
    xLabel,
    yLabel: 'rows',
    xIsDate: isDate,
    truncated: false,
    totalCategories: bins.length,
    sampled: sel.length,
  }
}

const SCATTER_CAP = 20_000

function buildScatter(
  ds: Dataset,
  sel: Uint32Array,
  spec: ChartSpec,
  xIndex: number,
  yIndex: number,
  xLabel: string,
  yLabel: string,
  xIsDate: boolean,
): ChartData {
  const xCol = ds.columns[xIndex]
  const yCol = yIndex >= 0 ? ds.columns[yIndex] : null
  if (
    !yCol ||
    xCol.kind === 'string' || xCol.kind === 'bool' ||
    yCol.kind === 'string' || yCol.kind === 'bool'
  ) {
    return emptyChart(spec, xLabel, yLabel)
  }

  const stride = sel.length > SCATTER_CAP ? Math.ceil(sel.length / SCATTER_CAP) : 1
  const capacity = Math.ceil(sel.length / stride)
  const xs = new Float64Array(capacity)
  const ys = new Float64Array(capacity)
  let n = 0

  for (let i = 0; i < sel.length; i += stride) {
    const row = sel[i]
    const xv = xCol.values[row]
    const yv = yCol.values[row]
    if (xv !== xv || yv !== yv) continue
    xs[n] = xv
    ys[n] = yv
    n++
  }

  const series: ChartSeries[] = [{ name: yLabel || 'value', y: ys.subarray(0, n) }]
  return {
    type: 'scatter',
    xLabels: null,
    x: xs.subarray(0, n),
    xEnd: null,
    series,
    xLabel,
    yLabel: yLabel || 'value',
    xIsDate,
    truncated: n < sel.length,
    totalCategories: n,
    sampled: n,
  }
}
