import { describe, expect, it } from 'vitest'
import { buildChart, computeProfiles, computeStats, niceBins, quantileSorted } from './stats'
import type { Dataset } from './query'
import type {
  AggFn,
  BoolStats,
  CategoricalStats,
  ChartSpec,
  ColumnData,
  ColumnKind,
  ColumnMeta,
  DatasetMeta,
  QuantitativeStats,
} from '@/lib/types'

/* ------------------------------------------------------------- fixtures */

interface ColSpec {
  name: string
  kind: ColumnKind
  encoding?: 'dict' | 'blob'
  /** Chart binning consults this; -1 means "unknown", which forces binning. */
  distinctCount?: number
}

function meta(columns: ColSpec[], rows: number): DatasetMeta {
  return {
    id: 'ds',
    name: 'test',
    rowCount: rows,
    byteSize: 0,
    sourceBytes: 0,
    createdAt: 0,
    badRows: 0,
    delimiter: ',',
    columns: columns.map<ColumnMeta>((c, i) => ({
      id: c.name,
      name: c.name,
      index: i,
      kind: c.kind,
      encoding: c.encoding,
      nullCount: 0,
      distinctCount: c.distinctCount ?? -1,
      byteSize: 0,
    })),
  }
}

function num(values: (number | null)[], kind: 'int' | 'float' | 'date' = 'int'): ColumnData {
  return { kind, values: Float64Array.from(values.map((v) => (v === null ? NaN : v))) }
}

function bool(values: (boolean | null)[]): ColumnData {
  return { kind: 'bool', values: Uint8Array.from(values.map((v) => (v === null ? 2 : v ? 1 : 0))) }
}

function dict(values: (string | null)[]): ColumnData {
  const dictionary: string[] = []
  const index = new Map<string, number>()
  const codes = Int32Array.from(
    values.map((v) => {
      if (v === null) return -1
      let code = index.get(v)
      if (code === undefined) {
        code = dictionary.length
        dictionary.push(v)
        index.set(v, code)
      }
      return code
    }),
  )
  return { kind: 'string', encoding: 'dict', codes, dictionary }
}

function blob(values: (string | null)[]): ColumnData {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const offsets = new Uint32Array(values.length + 1)
  const nulls = new Uint8Array(Math.ceil(values.length / 8))
  let total = 0
  values.forEach((v, i) => {
    if (v === null) {
      nulls[i >> 3] |= 1 << (i & 7)
      offsets[i + 1] = total
      return
    }
    const bytes = encoder.encode(v)
    chunks.push(bytes)
    total += bytes.length
    offsets[i + 1] = total
  })
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.length
  }
  return { kind: 'string', encoding: 'blob', bytes: all, offsets, nulls }
}

function ds(columns: ColSpec[], data: ColumnData[], rows: number): Dataset {
  return { meta: meta(columns, rows), columns: data }
}

/** Selection of every row, 0..n-1. */
function all(n: number): Uint32Array {
  const sel = new Uint32Array(n)
  for (let i = 0; i < n; i++) sel[i] = i
  return sel
}

function rows(...ids: number[]): Uint32Array {
  return Uint32Array.from(ids)
}

function chart(over: Partial<ChartSpec>): ChartSpec {
  return {
    id: 'c1',
    title: 't',
    type: 'bar',
    xColumnId: 'x',
    yColumnId: null,
    agg: 'count',
    bins: 30,
    limit: 12,
    ...over,
  }
}

/* --------------------------------------------------------- test helpers */

/** Two-pass sample stdev — independent of the module's Welford accumulator. */
function sampleStdev(values: number[]): number {
  const n = values.length
  if (n < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / n
  let s = 0
  for (const v of values) s += (v - mean) * (v - mean)
  return Math.sqrt(s / (n - 1))
}

/** The formula Welford exists to replace, so the precision test has teeth. */
function naiveStdev(values: number[]): number {
  const n = values.length
  let sum = 0
  let sumSq = 0
  for (const v of values) {
    sum += v
    sumSq += v * v
  }
  const mean = sum / n
  return Math.sqrt(Math.max(0, (sumSq / n - mean * mean) * (n / (n - 1))))
}

function sum(a: ArrayLike<number>): number {
  let t = 0
  for (let i = 0; i < a.length; i++) t += a[i]
  return t
}

const quant = (s: unknown) => s as QuantitativeStats
const cat = (s: unknown) => s as CategoricalStats
const bools = (s: unknown) => s as BoolStats

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/* ================================================================ niceBins */

describe('niceBins', () => {
  const cases: { min: number; max: number; target: number; width: number }[] = [
    // A tiny range: the step lands two decades below 1.
    { min: 0.003, max: 0.07, target: 30, width: 0.0025 },
    { min: 0.003, max: 0.07, target: 12, width: 0.01 },
    // Unit scale.
    { min: 1, max: 97, target: 20, width: 5 },
    { min: 1, max: 97, target: 50, width: 2 },
    // Thousands.
    { min: 1000, max: 98000, target: 30, width: 5000 },
    { min: 0, max: 1, target: 200, width: 0.005 },
  ]

  it.each(cases)('snaps the width to a nice step for $min..$max @ $target', (c) => {
    expect(niceBins(c.min, c.max, c.target).width).toBeCloseTo(c.width, 12)
  })

  it.each(cases)('keeps width a 1/2/2.5/5 multiple of a power of ten for $min..$max @ $target', (c) => {
    const { width } = niceBins(c.min, c.max, c.target)
    const mantissa = width / Math.pow(10, Math.floor(Math.log10(width)))
    // Snap to 12 digits so 2.4999999999999996 is still recognised as 2.5.
    const snapped = Number(mantissa.toPrecision(12))
    expect([1, 2, 2.5, 5]).toContain(snapped)
  })

  it.each(cases)('starts on a bin boundary at or below min for $min..$max @ $target', (c) => {
    const { start, width } = niceBins(c.min, c.max, c.target)
    expect(start).toBeLessThanOrEqual(c.min)
    const k = start / width
    expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9)
  })

  it.each(cases)('covers max for $min..$max @ $target', (c) => {
    const { start, width, count } = niceBins(c.min, c.max, c.target)
    expect(start + count * width).toBeGreaterThanOrEqual(c.max)
  })

  it.each(cases)('lands near the requested bin count for $min..$max @ $target', (c) => {
    const { count } = niceBins(c.min, c.max, c.target)
    // Snapping up can at most halve the count, and padding the start can add one.
    expect(count).toBeGreaterThanOrEqual(Math.floor(c.target / 2))
    expect(count).toBeLessThanOrEqual(c.target + 1)
  })

  it('gives a single bin that strictly contains the value when min === max', () => {
    const { start, width, count } = niceBins(7, 7, 30)
    expect(count).toBe(1)
    expect(width).toBeGreaterThan(0)
    expect(start).toBeLessThanOrEqual(7)
    expect(start + width).toBeGreaterThan(7)
  })

  it('treats a reversed range as the same range', () => {
    expect(niceBins(97, 1, 20)).toEqual(niceBins(1, 97, 20))
  })

  it('returns usable geometry for non-finite input instead of NaN bins', () => {
    for (const [min, max] of [[NaN, 5], [0, NaN], [-Infinity, 1], [0, Infinity], [NaN, NaN]]) {
      const b = niceBins(min, max, 30)
      expect(Number.isFinite(b.start)).toBe(true)
      expect(Number.isFinite(b.width)).toBe(true)
      expect(b.width).toBeGreaterThan(0)
      expect(b.count).toBeGreaterThanOrEqual(1)
    }
  })

  it('clamps the target to the 1..200 band', () => {
    expect(niceBins(0, 1, 1_000_000).count).toBeLessThanOrEqual(201)
    expect(niceBins(0, 1, 1_000_000).count).toBeGreaterThanOrEqual(100)
    // Below the band, one bin is the most that can be asked for.
    expect(niceBins(0, 1, -7).count).toBe(1)
    expect(niceBins(0, 1, -0.6).count).toBe(1)
  })

  it('treats a zero target as "unspecified" and uses the default', () => {
    // 0 bins is not a renderable histogram, so it must not be taken literally.
    const b = niceBins(0, 1, 0)
    expect(b.count).toBeGreaterThan(1)
    expect(b.count).toBeLessThanOrEqual(201)
    expect(b.start + b.count * b.width).toBeGreaterThanOrEqual(1)
  })

  it('falls back to a usable default when the target is not a number', () => {
    const b = niceBins(0, 1, NaN)
    expect(b.count).toBeGreaterThan(1)
    expect(b.count).toBeLessThanOrEqual(201)
    expect(Number.isFinite(b.width)).toBe(true)
  })

  it('never returns a zero or negative width, whatever the span', () => {
    for (const [min, max] of [[0, 1e-9], [-1e9, 1e9], [5, 5.000001], [-3, -2]]) {
      const b = niceBins(min, max, 30)
      expect(b.width).toBeGreaterThan(0)
      expect(b.count).toBeGreaterThanOrEqual(1)
      expect(b.start + b.count * b.width).toBeGreaterThanOrEqual(max)
    }
  })
})

/* ========================================================== quantileSorted */

describe('quantileSorted', () => {
  const four = Float64Array.from([1, 2, 3, 4])

  it('interpolates between the bracketing order statistics', () => {
    expect(quantileSorted(four, 0.5)).toBe(2.5)
    expect(quantileSorted(four, 0.25)).toBe(1.75)
    expect(quantileSorted(four, 0.75)).toBe(3.25)
  })

  it('returns the extremes at q=0 and q=1', () => {
    expect(quantileSorted(four, 0)).toBe(1)
    expect(quantileSorted(four, 1)).toBe(4)
  })

  it('hits exact elements when the position is integral', () => {
    const five = Float64Array.from([10, 20, 30, 40, 50])
    expect(quantileSorted(five, 0.5)).toBe(30)
    expect(quantileSorted(five, 0.25)).toBe(20)
  })

  it('is monotone in q', () => {
    let prev = -Infinity
    for (let q = 0; q <= 1.0001; q += 0.05) {
      const v = quantileSorted(four, Math.min(1, q))
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('clamps q outside 0..1 rather than reading out of bounds', () => {
    expect(quantileSorted(four, -5)).toBe(1)
    expect(quantileSorted(four, 5)).toBe(4)
  })

  it('returns the only value for a single-element array', () => {
    const one = Float64Array.from([42])
    expect(quantileSorted(one, 0)).toBe(42)
    expect(quantileSorted(one, 0.5)).toBe(42)
    expect(quantileSorted(one, 1)).toBe(42)
  })

  it('returns NaN for an empty array without throwing', () => {
    const none = new Float64Array(0)
    expect(() => quantileSorted(none, 0.5)).not.toThrow()
    expect(quantileSorted(none, 0)).toBeNaN()
    expect(quantileSorted(none, 0.5)).toBeNaN()
    expect(quantileSorted(none, 1)).toBeNaN()
  })
})

/* ====================================================== numeric computeStats */

describe('computeStats — numeric column', () => {
  // Hand-picked so every statistic can be written down by hand.
  const values = [2, 4, 4, 4, 5, 5, 7, 9]
  const withNulls = [2, 4, null, 4, 4, 5, null, 5, 7, 9]
  const dataset = ds([{ name: 'n', kind: 'int' }], [num(withNulls)], withNulls.length)

  const stats = () => quant(computeStats(dataset, all(withNulls.length), 'n', 30))

  it('counts non-nulls and nulls, and they add up to the selection', () => {
    const s = stats()
    expect(s.kind).toBe('numeric')
    expect(s.count).toBe(8)
    expect(s.nulls).toBe(2)
    expect(s.count + s.nulls).toBe(withNulls.length)
  })

  it('computes min/max/sum/mean exactly, ignoring nulls', () => {
    const s = stats()
    expect(s.min).toBe(2)
    expect(s.max).toBe(9)
    expect(s.sum).toBe(40)
    expect(s.mean).toBe(5)
  })

  it('counts distinct non-null values', () => {
    // {2, 4, 5, 7, 9}
    expect(stats().distinct).toBe(5)
  })

  it('matches hand-computed order statistics', () => {
    const s = stats()
    // sorted = [2,4,4,4,5,5,7,9], n=8, pos = 7q
    expect(s.median).toBeCloseTo(4.5, 12) // pos 3.5 -> 4 + (5-4)*0.5
    expect(s.p25).toBeCloseTo(4, 12) //    pos 1.75 -> 4 + (4-4)*0.75
    expect(s.p75).toBeCloseTo(5.5, 12) //  pos 5.25 -> 5 + (7-5)*0.25
    expect(s.p95).toBeCloseTo(8.3, 12) //  pos 6.65 -> 7 + (9-7)*0.65
  })

  it('reports the sample (n-1) standard deviation', () => {
    const expected = sampleStdev(values) // sqrt(32/7)
    expect(expected).toBeCloseTo(2.138089935299395, 12)
    expect(stats().stdev).toBeCloseTo(expected, 9)
  })

  it('bins every counted value and nothing else', () => {
    const s = stats()
    expect(s.histogram.length).toBeGreaterThan(0)
    expect(sum(s.histogram.map((b) => b.count))).toBe(s.count)
    for (const b of s.histogram) {
      expect(Number.isFinite(b.start)).toBe(true)
      expect(Number.isFinite(b.end)).toBe(true)
      expect(b.end).toBeGreaterThan(b.start)
    }
    // Bins tile the axis without gaps or overlap.
    for (let i = 1; i < s.histogram.length; i++) {
      expect(s.histogram[i].start).toBeCloseTo(s.histogram[i - 1].end, 9)
    }
    expect(s.histogram[0].start).toBeLessThanOrEqual(s.min)
    expect(s.histogram[s.histogram.length - 1].end).toBeGreaterThanOrEqual(s.max)
  })

  it('keeps nulls out of every statistic', () => {
    const clean = ds([{ name: 'n', kind: 'int' }], [num(values)], values.length)
    const withoutNulls = quant(computeStats(clean, all(values.length), 'n', 30))
    const s = stats()
    expect(withoutNulls.min).toBe(s.min)
    expect(withoutNulls.max).toBe(s.max)
    expect(withoutNulls.sum).toBe(s.sum)
    expect(withoutNulls.mean).toBe(s.mean)
    expect(withoutNulls.median).toBe(s.median)
    expect(withoutNulls.stdev).toBeCloseTo(s.stdev, 12)
    expect(withoutNulls.distinct).toBe(s.distinct)
  })

  it('describes only the selected rows', () => {
    // Rows 0,1,3 of withNulls -> [2, 4, 4]
    const s = quant(computeStats(dataset, rows(0, 1, 3), 'n', 30))
    expect(s.count).toBe(3)
    expect(s.nulls).toBe(0)
    expect(s.sum).toBe(10)
    expect(s.min).toBe(2)
    expect(s.max).toBe(4)
    expect(s.distinct).toBe(2)
  })
})

/* ======================================================= Welford precision */

describe('computeStats — variance of large near-equal values', () => {
  const values = [0, 1, 2, 3, 4].map((d) => 1e9 + d)
  const dataset = ds([{ name: 'n', kind: 'float' }], [num(values, 'float')], values.length)

  it('recovers the true small stdev that the naive formula cancels away', () => {
    const truth = Math.sqrt(2.5) // sample stdev of [0,1,2,3,4]
    expect(sampleStdev(values)).toBeCloseTo(truth, 12)
    // The one-pass sum-of-squares formula is destroyed here; if it were not,
    // this test could not tell the two apart.
    expect(Math.abs(naiveStdev(values) - truth)).toBeGreaterThan(0.1)

    const s = quant(computeStats(dataset, all(values.length), 'n', 30))
    expect(s.stdev).toBeCloseTo(truth, 9)
  })

  it('keeps the mean exact for large offsets', () => {
    const s = quant(computeStats(dataset, all(values.length), 'n', 30))
    expect(s.mean).toBeCloseTo(1e9 + 2, 6)
    expect(s.min).toBe(1e9)
    expect(s.max).toBe(1e9 + 4)
  })

  it('holds up at timestamp magnitude too', () => {
    const ts = [0, 1, 2, 3, 4].map((d) => 1.7e12 + d)
    const d2 = ds([{ name: 'n', kind: 'float' }], [num(ts, 'float')], ts.length)
    const s = quant(computeStats(d2, all(ts.length), 'n', 30))
    expect(s.stdev).toBeCloseTo(Math.sqrt(2.5), 9)
  })

  it('reports zero spread for a single value and for a constant column', () => {
    const one = ds([{ name: 'n', kind: 'int' }], [num([5])], 1)
    expect(quant(computeStats(one, all(1), 'n', 30)).stdev).toBe(0)
    const flat = ds([{ name: 'n', kind: 'int' }], [num([5, 5, 5, 5])], 4)
    expect(quant(computeStats(flat, all(4), 'n', 30)).stdev).toBeCloseTo(0, 12)
  })
})

/* ============================================================ outlierCount */

describe('computeStats — outlierCount', () => {
  it('counts values outside the 1.5 * IQR fences', () => {
    // sorted = [-50,1,2,3,4,5,6,7,8,9,100]; p25 = 2.5, p75 = 7.5, IQR = 5
    // fences = [-5, 15]  ->  -50 and 100 are outside.
    const values = [5, 1, 100, 2, 8, 3, -50, 4, 9, 6, 7]
    const d = ds([{ name: 'n', kind: 'int' }], [num(values)], values.length)
    const s = quant(computeStats(d, all(values.length), 'n', 30))
    expect(s.p25).toBeCloseTo(2.5, 12)
    expect(s.p75).toBeCloseTo(7.5, 12)
    expect(s.outlierCount).toBe(2)
  })

  it('places the fences at exactly 1.5 * IQR, not merely somewhere near it', () => {
    // sorted = [0..19, 28, 32]; p25 = 5.25, p75 = 15.75, IQR = 10.5
    // fences = [-10.5, 31.5]  ->  32 is outside, 28 is inside.
    // The fixtures above plant their outliers so far out that any multiplier
    // in roughly 1..3 answers the same. This one does not: the count is 2 at
    // a 1.0x multiplier and 0 at 2.0x, so the constant is pinned from both
    // sides and a "tune the outlier sensitivity" edit cannot ship silently.
    const values = [...Array.from({ length: 20 }, (_, i) => i), 28, 32]
    const d = ds([{ name: 'n', kind: 'int' }], [num(values)], values.length)
    const s = quant(computeStats(d, all(values.length), 'n', 30))
    expect(s.p25).toBeCloseTo(5.25, 12)
    expect(s.p75).toBeCloseTo(15.75, 12)
    expect(s.outlierCount).toBe(1)
  })

  // Derives its expectation from the p25/p75 the implementation reports, so it
  // checks the comparison loop against the reported fences — never the fence
  // width itself. The test above is what pins the width.
  it('agrees with the fences it reports', () => {
    const values = [5, 1, 100, 2, 8, 3, -50, 4, 9, 6, 7, 11, 12, 13]
    const d = ds([{ name: 'n', kind: 'int' }], [num(values)], values.length)
    const s = quant(computeStats(d, all(values.length), 'n', 30))
    const iqr = s.p75 - s.p25
    const lo = s.p25 - 1.5 * iqr
    const hi = s.p75 + 1.5 * iqr
    const expected = values.filter((v) => v < lo || v > hi).length
    expect(s.outlierCount).toBe(expected)
  })

  it('finds no outliers in a tight symmetric column', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    const d = ds([{ name: 'n', kind: 'int' }], [num(values)], values.length)
    expect(quant(computeStats(d, all(values.length), 'n', 30)).outlierCount).toBe(0)
  })

  it('does not treat nulls as outliers', () => {
    const values = [1, null, 2, null, 3, 4, 5, 6, 7, 8, 9, null]
    const d = ds([{ name: 'n', kind: 'int' }], [num(values)], values.length)
    const s = quant(computeStats(d, all(values.length), 'n', 30))
    expect(s.nulls).toBe(3)
    expect(s.outlierCount).toBe(0)
  })
})

/* =============================================================== date stats */

describe('computeStats — date column', () => {
  const base = Date.UTC(2024, 2, 7, 13, 45, 12, 500) // deliberately off every boundary

  function dateDataset(step: number, n: number) {
    const values = Array.from({ length: n }, (_, i) => base + i * step)
    return {
      dataset: ds([{ name: 'd', kind: 'date' }], [num(values, 'date')], n),
      values,
    }
  }

  it('reports kind "date"', () => {
    const { dataset } = dateDataset(DAY, 11)
    expect(quant(computeStats(dataset, all(11), 'd', 10)).kind).toBe('date')
  })

  it.each([
    { unit: SECOND, name: 'second' },
    { unit: MINUTE, name: 'minute' },
    { unit: HOUR, name: 'hour' },
    { unit: DAY, name: 'day' },
  ])('puts $name bin edges on exact UTC boundaries', ({ unit }) => {
    const n = 11
    const { dataset } = dateDataset(unit, n) // span is exactly 10 units
    const s = quant(computeStats(dataset, all(n), 'd', 10))
    expect(s.histogram.length).toBeGreaterThan(0)
    for (const b of s.histogram) {
      expect(b.start % unit).toBe(0)
      expect(b.end % unit).toBe(0)
      expect(b.end - b.start).toBe(unit)
    }
    expect(s.histogram[0].start).toBeLessThanOrEqual(s.min)
    expect(s.histogram[s.histogram.length - 1].end).toBeGreaterThanOrEqual(s.max)
  })

  it('bins every non-null timestamp exactly once', () => {
    const n = 11
    const { dataset } = dateDataset(DAY, n)
    const s = quant(computeStats(dataset, all(n), 'd', 10))
    expect(sum(s.histogram.map((b) => b.count))).toBe(s.count)
    expect(s.count).toBe(n)
  })

  it('keeps the numeric statistics in epoch milliseconds', () => {
    const n = 11
    const { dataset, values } = dateDataset(DAY, n)
    const s = quant(computeStats(dataset, all(n), 'd', 10))
    expect(s.min).toBe(values[0])
    expect(s.max).toBe(values[n - 1])
    expect(s.median).toBe(values[5])
  })

  it('handles an all-null date column without NaN geometry', () => {
    const d = ds([{ name: 'd', kind: 'date' }], [num([null, null, null], 'date')], 3)
    const s = quant(computeStats(d, all(3), 'd', 10))
    expect(s.kind).toBe('date')
    expect(s.count).toBe(0)
    expect(s.nulls).toBe(3)
    expect(s.histogram).toEqual([])
  })
})

/* ========================================================= categorical stats */

describe('computeStats — categorical column', () => {
  //            0    1    2     3     4      5   6     7    8     9     10  11
  const data = ['a', 'a', 'a', 'bb', 'bb', 'ccc', '', null, 'a', 'bb', null, 'dddd']
  const dictDs = ds([{ name: 's', kind: 'string', encoding: 'dict' }], [dict(data)], data.length)
  const blobDs = ds([{ name: 's', kind: 'string', encoding: 'blob' }], [blob(data)], data.length)

  const statsOf = (d: Dataset, sel = all(data.length)) => cat(computeStats(d, sel, 's', 30))

  it('counts values, nulls and distinct values exactly', () => {
    const s = statsOf(dictDs)
    expect(s.kind).toBe('categorical')
    expect(s.count).toBe(10)
    expect(s.nulls).toBe(2)
    expect(s.count + s.nulls).toBe(data.length)
    expect(s.distinct).toBe(5) // a, bb, ccc, '', dddd
  })

  it('ranks the top values by descending count and excludes nulls', () => {
    const s = statsOf(dictDs)
    expect(s.top.slice(0, 2)).toEqual([
      { value: 'a', count: 4 },
      { value: 'bb', count: 3 },
    ])
    const counts = s.top.map((t) => t.count)
    expect([...counts].sort((x, y) => y - x)).toEqual(counts)
    expect(s.top.some((t) => t.value === null)).toBe(false)
    expect(sum(counts)).toBe(s.count)
  })

  it('counts the empty string as a value, separately from null', () => {
    const s = statsOf(dictDs)
    expect(s.emptyCount).toBe(1)
    expect(s.nulls).toBe(2)
    expect(s.top).toContainEqual({ value: '', count: 1 })
  })

  it('measures value lengths over non-null rows only', () => {
    const s = statsOf(dictDs)
    expect(s.minLength).toBe(0) // the empty string
    expect(s.maxLength).toBe(4) // 'dddd'
    // 4*1 + 3*2 + 3 + 0 + 4 = 17 characters over 10 non-null rows
    expect(s.avgLength).toBeCloseTo(1.7, 12)
  })

  it('counts distinct over the selection, not the whole dictionary', () => {
    // Rows 0..4 use only 'a' and 'bb', though the dictionary holds five values.
    const s = statsOf(dictDs, rows(0, 1, 2, 3, 4))
    expect(s.count).toBe(5)
    expect(s.distinct).toBe(2)
    expect(s.top).toEqual([
      { value: 'a', count: 3 },
      { value: 'bb', count: 2 },
    ])
    expect(s.emptyCount).toBe(0)
    expect(s.minLength).toBe(1)
    expect(s.maxLength).toBe(2)
  })

  it('caps the top list without distorting the other statistics', () => {
    const many = Array.from({ length: 60 }, (_, i) => `v${i}`)
    const d = ds([{ name: 's', kind: 'string', encoding: 'dict' }], [dict(many)], many.length)
    const s = cat(computeStats(d, all(many.length), 's', 30))
    expect(s.distinct).toBe(60)
    expect(s.count).toBe(60)
    expect(s.top.length).toBeLessThanOrEqual(20)
  })

  it('produces identical statistics for dict and blob encodings', () => {
    expect(statsOf(blobDs)).toEqual(statsOf(dictDs))
    expect(statsOf(blobDs, rows(0, 1, 2, 3, 4))).toEqual(statsOf(dictDs, rows(0, 1, 2, 3, 4)))
    expect(statsOf(blobDs, rows(7, 10))).toEqual(statsOf(dictDs, rows(7, 10)))
  })

  it('handles an all-null column in both encodings', () => {
    const nulls = [null, null, null]
    for (const col of [dict(nulls), blob(nulls)]) {
      const encoding = col.kind === 'string' ? col.encoding : undefined
      const d = ds([{ name: 's', kind: 'string', encoding }], [col], 3)
      const s = cat(computeStats(d, all(3), 's', 30))
      expect(s.count).toBe(0)
      expect(s.nulls).toBe(3)
      expect(s.distinct).toBe(0)
      expect(s.top).toEqual([])
      expect(s.minLength).toBe(0)
      expect(s.maxLength).toBe(0)
      expect(s.avgLength).toBe(0)
      expect(s.emptyCount).toBe(0)
    }
  })

  it('handles an empty selection in both encodings', () => {
    for (const d of [dictDs, blobDs]) {
      const s = cat(computeStats(d, new Uint32Array(0), 's', 30))
      expect(s.count).toBe(0)
      expect(s.nulls).toBe(0)
      expect(s.distinct).toBe(0)
      expect(s.top).toEqual([])
      expect(s.avgLength).toBe(0)
    }
  })

  it('handles a single distinct value in both encodings', () => {
    const same = ['q', 'q', 'q']
    const a = ds([{ name: 's', kind: 'string', encoding: 'dict' }], [dict(same)], 3)
    const b = ds([{ name: 's', kind: 'string', encoding: 'blob' }], [blob(same)], 3)
    const sa = cat(computeStats(a, all(3), 's', 30))
    expect(sa.distinct).toBe(1)
    expect(sa.top).toEqual([{ value: 'q', count: 3 }])
    expect(sa.minLength).toBe(1)
    expect(sa.maxLength).toBe(1)
    expect(sa.avgLength).toBe(1)
    expect(cat(computeStats(b, all(3), 's', 30))).toEqual(sa)
  })
})

/* ================================================================ bool stats */

describe('computeStats — bool column', () => {
  const data = [true, true, false, null, true, null, false]
  const d = ds([{ name: 'b', kind: 'bool' }], [bool(data)], data.length)

  it('splits the 0/1/2 sentinels into false/true/null', () => {
    const s = bools(computeStats(d, all(data.length), 'b'))
    expect(s.kind).toBe('bool')
    expect(s.trueCount).toBe(3)
    expect(s.falseCount).toBe(2)
    expect(s.nulls).toBe(2)
    expect(s.count).toBe(5)
    expect(s.trueCount + s.falseCount).toBe(s.count)
    expect(s.count + s.nulls).toBe(data.length)
  })

  it('respects the selection', () => {
    const s = bools(computeStats(d, rows(2, 3, 6), 'b'))
    expect(s.trueCount).toBe(0)
    expect(s.falseCount).toBe(2)
    expect(s.nulls).toBe(1)
  })

  it('returns zeros for an empty selection', () => {
    const s = bools(computeStats(d, new Uint32Array(0), 'b'))
    expect(s).toEqual({ kind: 'bool', count: 0, nulls: 0, trueCount: 0, falseCount: 0 })
  })
})

/* =========================================================== unknown column */

describe('computeStats — unknown column', () => {
  const d = ds([{ name: 'n', kind: 'int' }], [num([1, 2, 3])], 3)

  it('returns an empty, well-shaped result instead of throwing', () => {
    let s: unknown
    expect(() => {
      s = computeStats(d, all(3), 'nope')
    }).not.toThrow()
    const r = s as { kind: string; count: number; nulls: number }
    expect(typeof r.kind).toBe('string')
    expect(r.count).toBe(0)
    expect(r.nulls).toBe(0)
  })
})

/* ================================================================= profiles */

describe('computeProfiles', () => {
  const n = 8
  const dataset = ds(
    [
      { name: 'n', kind: 'int' },
      { name: 'd', kind: 'date' },
      { name: 's', kind: 'string', encoding: 'dict' },
      { name: 'b', kind: 'bool' },
    ],
    [
      num([1, 2, null, 4, 5, 6, null, 8]),
      num(Array.from({ length: n }, (_, i) => Date.UTC(2024, 0, 1) + i * DAY), 'date'),
      dict(['a', 'b', 'a', null, 'c', 'a', 'b', null]),
      bool([true, false, null, true, true, false, null, true]),
    ],
    n,
  )
  const ids = ['n', 'd', 's', 'b']

  it('returns one profile per requested column, in request order', () => {
    const p = computeProfiles(dataset, all(n), ids)
    expect(p.map((x) => x.columnId)).toEqual(ids)
  })

  it('reports completeness as the non-null share of the selection', () => {
    const p = computeProfiles(dataset, all(n), ids)
    const byId = new Map(p.map((x) => [x.columnId, x]))
    expect(byId.get('n')!.completeness).toBeCloseTo(6 / 8, 12)
    expect(byId.get('d')!.completeness).toBe(1)
    expect(byId.get('s')!.completeness).toBeCloseTo(6 / 8, 12)
    expect(byId.get('b')!.completeness).toBeCloseTo(6 / 8, 12)
    for (const prof of p) {
      expect(prof.completeness).toBeGreaterThanOrEqual(0)
      expect(prof.completeness).toBeLessThanOrEqual(1)
      const nulls = prof.stats.nulls
      expect(prof.completeness).toBeCloseTo((n - nulls) / n, 12)
    }
  })

  it('returns a sparkline of at most 24 finite values', () => {
    for (const prof of computeProfiles(dataset, all(n), ids)) {
      expect(prof.spark.length).toBeLessThanOrEqual(24)
      for (const v of prof.spark) {
        expect(Number.isFinite(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('fills the sparkline with the top-N counts for a categorical column', () => {
    // 's' is ['a','b','a',null,'c','a','b',null] -> a:3, b:2, c:1
    const p = computeProfiles(dataset, all(n), ['s'])[0]
    expect(p.spark).toEqual([3, 2, 1])
    expect(sum(p.spark)).toBe(n - p.stats.nulls)
  })

  it('fills the sparkline with the true/false split for a bool column', () => {
    // 'b' is [T,F,null,T,T,F,null,T]
    const p = computeProfiles(dataset, all(n), ['b'])[0]
    expect(p.spark).toEqual([2, 4])
    expect(sum(p.spark)).toBe(n - p.stats.nulls)
  })

  it('fills the sparkline with bin counts for a numeric column', () => {
    const p = computeProfiles(dataset, all(n), ['n'])[0]
    expect(p.spark.length).toBeGreaterThan(1)
    // The bins fit inside the sparkline budget, so no row may go missing.
    expect(p.spark.length).toBeLessThanOrEqual(24)
    expect(sum(p.spark)).toBe(n - p.stats.nulls)
  })

  /**
   * Regression: the binner may return more bins than requested, and the series
   * used to be sliced to 24 — silently dropping the tail of the distribution.
   */
  it('draws every row in the sparkline instead of cutting off the tail', () => {
    const dates = Array.from({ length: 8 }, (_, i) => Date.UTC(2024, 0, 1) + i * DAY)
    const d = ds([{ name: 'd', kind: 'date' }], [num(dates, 'date')], dates.length)
    const p = computeProfiles(d, all(dates.length), ['d'])[0]
    expect(p.spark.length).toBeLessThanOrEqual(24)
    expect(sum(p.spark)).toBe(dates.length)
  })

  it('caps the sparkline at 24 even when more bins are requested', () => {
    const wide = ds([{ name: 'n', kind: 'int' }], [num(Array.from({ length: 200 }, (_, i) => i))], 200)
    const p = computeProfiles(wide, all(200), ['n'], 100)
    expect(p[0].spark.length).toBeLessThanOrEqual(24)
  })

  it('skips an unknown column id rather than throwing', () => {
    let p: ReturnType<typeof computeProfiles> = []
    expect(() => {
      p = computeProfiles(dataset, all(n), ['n', 'nope', 's'])
    }).not.toThrow()
    expect(p.map((x) => x.columnId)).toEqual(['n', 's'])
  })

  it('returns nothing for an empty column list', () => {
    expect(computeProfiles(dataset, all(n), [])).toEqual([])
  })

  it('survives an empty selection with finite completeness', () => {
    let p: ReturnType<typeof computeProfiles> = []
    expect(() => {
      p = computeProfiles(dataset, new Uint32Array(0), ids)
    }).not.toThrow()
    expect(p).toHaveLength(ids.length)
    for (const prof of p) {
      expect(Number.isFinite(prof.completeness)).toBe(true)
      expect(prof.completeness).toBeGreaterThanOrEqual(0)
      expect(prof.completeness).toBeLessThanOrEqual(1)
      expect(prof.spark.every((v) => Number.isFinite(v))).toBe(true)
    }
  })

  it('reports zero completeness for an all-null column', () => {
    const d = ds([{ name: 'n', kind: 'int' }], [num([null, null, null])], 3)
    const p = computeProfiles(d, all(3), ['n'])
    expect(p[0].completeness).toBe(0)
    expect(p[0].stats.nulls).toBe(3)
    expect(p[0].spark.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('reports the same completeness whichever encoding a text column uses', () => {
    // Completeness and the null count are storage-independent: they must not
    // shift because a column happened to be stored as a blob rather than a
    // dict. The sparkline is deliberately not, and the assertions below pin
    // that asymmetry rather than leaving it unexamined.
    const text = ['a', null, 'c', 'd', null, 'f', 'g', 'h']
    const asDict = ds([{ name: 's', kind: 'string', encoding: 'dict' }], [dict(text)], text.length)
    const asBlob = ds([{ name: 's', kind: 'string', encoding: 'blob' }], [blob(text)], text.length)
    const d = computeProfiles(asDict, all(text.length), ['s'])[0]
    const b = computeProfiles(asBlob, all(text.length), ['s'])[0]
    expect(d.stats.nulls).toBe(2)
    expect(b.stats.nulls).toBe(2)
    expect(b.completeness).toBe(d.completeness)
    expect(b.completeness).toBeCloseTo(6 / 8, 12)

    // The sparkline does depend on encoding, by design. With distinctCount at
    // -1 the dict column can read its own dictionary length (6 categories, so
    // cheap enough to tally), while the blob column has no cardinality to read
    // and declines to decode every string on the chance it is unique.
    expect(d.spark).toEqual([1, 1, 1, 1, 1, 1])
    expect(b.spark).toEqual([])
  })

  it('lets the parser-supplied distinct count veto a dict sparkline', () => {
    // meta.distinctCount, not the dictionary, decides: 6 dictionary entries
    // but a reported 500 categories sends this down the count-only path, so
    // dropping the parser's count in favour of dictionary.length is caught.
    const six = ['a', 'b', 'a', null, 'c', 'a']
    const d = ds(
      [{ name: 's', kind: 'string', encoding: 'dict', distinctCount: 500 }],
      [dict(six)],
      six.length,
    )
    const p = computeProfiles(d, all(six.length), ['s'])[0]
    expect(p.spark).toEqual([])
    expect(p.stats.nulls).toBe(1)
    expect(p.completeness).toBeCloseTo(5 / 6, 12)
  })

  it('lets the parser-supplied distinct count earn a blob column a sparkline', () => {
    // The mirror case: a blob is only assumed high-cardinality when nothing
    // says otherwise. A reported 3 categories puts it on the tally path.
    const three = ['x', 'y', 'x', null, 'z', 'x']
    const d = ds(
      [{ name: 's', kind: 'string', encoding: 'blob', distinctCount: 3 }],
      [blob(three)],
      three.length,
    )
    const p = computeProfiles(d, all(three.length), ['s'])[0]
    expect(p.spark).toEqual([3, 1, 1])
    expect(p.stats.nulls).toBe(1)
    expect(sum(p.spark)).toBe(5)
  })

  it('counts nulls in a high-cardinality text column over the selection only', () => {
    // Every value distinct, so no sparkline is worth drawing — but the null
    // count still has to be exact, and still has to respect the selection.
    const many: (string | null)[] = Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? null : `id-${i}`))
    for (const col of [dict(many), blob(many)]) {
      const encoding = col.kind === 'string' ? col.encoding : undefined
      const d = ds([{ name: 's', kind: 'string', encoding }], [col], many.length)
      const full = computeProfiles(d, all(many.length), ['s'])[0]
      expect(full.stats.nulls).toBe(100)
      expect(full.completeness).toBeCloseTo(200 / 300, 12)
      expect(full.spark.length).toBeLessThanOrEqual(24)
      expect(full.spark.every((v) => Number.isFinite(v))).toBe(true)

      // Rows 0 (null), 1, 2, 3 (null) -> 2 nulls of 4.
      const part = computeProfiles(d, rows(0, 1, 2, 3), ['s'])[0]
      expect(part.stats.nulls).toBe(2)
      expect(part.completeness).toBeCloseTo(0.5, 12)
    }
  })

  it('profiles the selection, not the dataset', () => {
    const p = computeProfiles(dataset, rows(2, 6), ['n'])
    expect(p[0].stats.nulls).toBe(2)
    expect(p[0].completeness).toBe(0)
  })
})

/* =================================================================== charts */

describe('buildChart — histogram', () => {
  const values = [1, 2, 2, 3, 5, 8, 13, 21, null, 34]
  const dataset = ds([{ name: 'x', kind: 'int' }], [num(values)], values.length)

  it('bins every non-null value and matches x/xEnd/y lengths', () => {
    const c = buildChart(dataset, all(values.length), chart({ type: 'histogram', bins: 6 }))
    expect(c.type).toBe('histogram')
    expect(c.x).not.toBeNull()
    expect(c.xEnd).not.toBeNull()
    expect(c.series).toHaveLength(1)
    const y = c.series[0].y
    expect(c.x!.length).toBe(y.length)
    expect(c.xEnd!.length).toBe(y.length)
    expect(sum(y)).toBe(9) // 10 rows, one null
    expect(c.xLabels).toBeNull()
    expect(c.totalCategories).toBe(c.x!.length)
    // Bounded here, pinned exactly in the it.fails below: whichever way the
    // sampled/selection ambiguity is resolved, the answer is in this range.
    expect(c.sampled).toBeGreaterThanOrEqual(9)
    expect(c.sampled).toBeLessThanOrEqual(values.length)
  })

  // SOURCE BUG (see sourceBugs): buildHistogram returns `sampled: sel.length`,
  // so this reports 10 for the 9 rows it actually binned. ChartData.sampled is
  // documented as "Rows contributing to the chart", and buildScatter reports
  // the true plotted count, so 9 is the documented answer. The assertion stays
  // correct and stays red rather than being relaxed to sel.length.
  it('reports the binned row count as sampled, not the selection size', () => {
    const c = buildChart(dataset, all(values.length), chart({ type: 'histogram', bins: 6 }))
    expect(c.sampled).toBe(9)
  })

  it('emits monotone, contiguous bin edges', () => {
    const c = buildChart(dataset, all(values.length), chart({ type: 'histogram', bins: 6 }))
    const x = c.x!
    const xEnd = c.xEnd!
    for (let i = 0; i < x.length; i++) {
      expect(Number.isFinite(x[i])).toBe(true)
      expect(xEnd[i]).toBeGreaterThan(x[i])
      if (i > 0) expect(x[i]).toBeCloseTo(xEnd[i - 1], 9)
    }
  })

  it('collapses a single distinct value into one bin holding every row', () => {
    const d = ds([{ name: 'x', kind: 'int' }], [num([7, 7, 7, null])], 4)
    const c = buildChart(d, all(4), chart({ type: 'histogram', bins: 10 }))
    expect(c.series[0].y.length).toBe(1)
    expect(c.series[0].y[0]).toBe(3)
    expect(Number.isFinite(c.x![0])).toBe(true)
    expect(c.xEnd![0]).toBeGreaterThan(c.x![0])
  })

  it('returns an empty chart for an all-null column', () => {
    const d = ds([{ name: 'x', kind: 'int' }], [num([null, null])], 2)
    const c = buildChart(d, all(2), chart({ type: 'histogram' }))
    expect(c.series).toEqual([])
    expect(c.x).toBeNull()
    expect(c.totalCategories).toBe(0)
  })
})

describe('buildChart — bar / pie top-N', () => {
  // A:10  B:8  C:6  D:4  E:2  F:1  plus 3 null categories = 34 rows
  const cats: (string | null)[] = []
  for (const [name, count] of [['A', 10], ['B', 8], ['C', 6], ['D', 4], ['E', 2], ['F', 1]] as const) {
    for (let i = 0; i < count; i++) cats.push(name)
  }
  cats.push(null, null, null)
  const TOTAL = 31
  const dataset = ds(
    [{ name: 'x', kind: 'string', encoding: 'dict' }],
    [dict(cats)],
    cats.length,
  )

  it.each(['bar', 'pie'] as const)('%s: keeps the top-N and folds the rest into one Other', (type) => {
    const c = buildChart(dataset, all(cats.length), chart({ type, limit: 3 }))
    expect(c.truncated).toBe(true)
    expect(c.totalCategories).toBe(6)
    expect(c.xLabels).toEqual(['A', 'B', 'C', 'Other'])
    expect(Array.from(c.series[0].y)).toEqual([10, 8, 6, 7]) // Other = 4 + 2 + 1
  })

  it.each(['bar', 'pie'] as const)('%s: plots every row that went in', (type) => {
    const c = buildChart(dataset, all(cats.length), chart({ type, limit: 3 }))
    expect(sum(c.series[0].y)).toBe(TOTAL)
    expect(c.xLabels!.length).toBe(c.series[0].y.length)
    expect(c.totalCategories).toBe(6)
    // Bounded here, pinned exactly in the it.fails below.
    expect(c.sampled).toBeGreaterThanOrEqual(TOTAL)
    expect(c.sampled).toBeLessThanOrEqual(cats.length)
  })

  // SOURCE BUG (see sourceBugs): buildChart returns `sampled: sel.length`, so
  // this reports 34 while exactly 31 rows are plotted — the 3 null categories
  // are skipped and contribute nothing. buildScatter reports the true plotted
  // count for the same documented field ("Rows contributing to the chart"),
  // and the UI prints it as "N rows" under the chart.
  it('bar/pie: reports the plotted row count as sampled, not the selection size', () => {
    for (const type of ['bar', 'pie'] as const) {
      const c = buildChart(dataset, all(cats.length), chart({ type, limit: 3 }))
      expect(c.sampled).toBe(TOTAL)
    }
  })

  it('ranks categories by descending value', () => {
    const c = buildChart(dataset, all(cats.length), chart({ type: 'bar', limit: 12 }))
    const y = Array.from(c.series[0].y)
    expect(y).toEqual([...y].sort((a, b) => b - a))
    expect(c.xLabels).toEqual(['A', 'B', 'C', 'D', 'E', 'F'])
  })

  it('omits Other entirely when nothing was cut', () => {
    const c = buildChart(dataset, all(cats.length), chart({ type: 'bar', limit: 12 }))
    expect(c.truncated).toBe(false)
    expect(c.xLabels).not.toContain('Other')
    expect(c.totalCategories).toBe(6)
    expect(sum(c.series[0].y)).toBe(TOTAL)
  })

  it('adds Other at most once, at any limit', () => {
    for (const limit of [1, 2, 3, 4, 5, 6, 7, 20]) {
      const c = buildChart(dataset, all(cats.length), chart({ type: 'bar', limit }))
      expect(c.xLabels!.filter((l) => l === 'Other')).toHaveLength(limit >= 6 ? 0 : 1)
      expect(c.xLabels!.length).toBe(Math.min(6, limit) + (limit < 6 ? 1 : 0))
      expect(sum(c.series[0].y)).toBe(TOTAL)
      expect(c.truncated).toBe(limit < 6)
    }
  })

  it('never silently drops a category from the total, whatever the limit', () => {
    for (const limit of [1, 2, 5]) {
      const c = buildChart(dataset, all(cats.length), chart({ type: 'pie', limit }))
      const other = c.series[0].y[c.series[0].y.length - 1]
      const plotted = Array.from(c.series[0].y).slice(0, -1)
      expect(other).toBe(TOTAL - sum(plotted))
    }
  })

  it('excludes null categories from the axis', () => {
    const c = buildChart(dataset, all(cats.length), chart({ type: 'bar', limit: 12 }))
    expect(c.xLabels).not.toContain(null)
    expect(c.xLabels).not.toContain('null')
    expect(sum(c.series[0].y)).toBe(TOTAL)
  })
})

describe('buildChart — aggregation', () => {
  //  g:  a a a b b
  //  v:  1 null 3 10 null
  const g = ['a', 'a', 'a', 'b', 'b']
  const v = [1, null, 3, 10, null]
  const dataset = ds(
    [
      { name: 'x', kind: 'string', encoding: 'dict' },
      { name: 'v', kind: 'float' },
    ],
    [dict(g), num(v, 'float')],
    g.length,
  )
  const sel = all(g.length)

  const byLabel = (c: ReturnType<typeof buildChart>) =>
    new Map(c.xLabels!.map((l, i) => [l, c.series[0].y[i]]))

  it("ignores yColumnId when the agg is 'count'", () => {
    const withY = buildChart(dataset, sel, chart({ type: 'bar', yColumnId: 'v', agg: 'count' }))
    const withoutY = buildChart(dataset, sel, chart({ type: 'bar', yColumnId: null, agg: 'count' }))
    expect(Array.from(withY.series[0].y)).toEqual(Array.from(withoutY.series[0].y))
    expect(withY.xLabels).toEqual(withoutY.xLabels)
    expect(byLabel(withY).get('a')).toBe(3) // all three rows, including the null v
    expect(byLabel(withY).get('b')).toBe(2)
  })

  it("divides 'avg' by the non-null count, not the row count", () => {
    const c = buildChart(dataset, sel, chart({ type: 'bar', yColumnId: 'v', agg: 'avg' }))
    const m = byLabel(c)
    expect(m.get('a')).toBeCloseTo(2, 12) // (1 + 3) / 2, not / 3
    expect(m.get('b')).toBeCloseTo(10, 12) // 10 / 1, not / 2
  })

  it("sums, mins and maxes over non-null values only", () => {
    const s = byLabel(buildChart(dataset, sel, chart({ type: 'bar', yColumnId: 'v', agg: 'sum' })))
    expect(s.get('a')).toBe(4)
    expect(s.get('b')).toBe(10)
    const mn = byLabel(buildChart(dataset, sel, chart({ type: 'bar', yColumnId: 'v', agg: 'min' })))
    expect(mn.get('a')).toBe(1)
    const mx = byLabel(buildChart(dataset, sel, chart({ type: 'bar', yColumnId: 'v', agg: 'max' })))
    expect(mx.get('a')).toBe(3)
  })

  it("counts nulls per group for agg 'nulls'", () => {
    const m = byLabel(buildChart(dataset, sel, chart({ type: 'bar', yColumnId: 'v', agg: 'nulls' })))
    expect(m.get('a')).toBe(1)
    expect(m.get('b')).toBe(1)
  })

  it("takes the per-group median over non-null values", () => {
    const m = byLabel(buildChart(dataset, sel, chart({ type: 'bar', yColumnId: 'v', agg: 'median' })))
    expect(m.get('a')).toBe(2) // median of [1, 3]
    expect(m.get('b')).toBe(10)
  })

  it('labels the y axis with the aggregation it performed', () => {
    expect(buildChart(dataset, sel, chart({ type: 'bar', agg: 'count' })).yLabel).toBe('rows')
    expect(buildChart(dataset, sel, chart({ type: 'bar', yColumnId: 'v', agg: 'avg' })).yLabel).toBe('avg of v')
    expect(buildChart(dataset, sel, chart({ type: 'bar' })).xLabel).toBe('x')
  })
})

describe('buildChart — line over a date axis', () => {
  const n = 12
  const times = Array.from({ length: n }, (_, i) => Date.UTC(2024, 0, 1) + i * DAY)
  // Shuffled storage order: the chart must sort, not rely on input order.
  const order = [7, 0, 11, 3, 5, 1, 9, 2, 10, 4, 8, 6]
  const dataset = ds(
    [{ name: 'x', kind: 'date' }],
    [num(order.map((i) => times[i]), 'date')],
    n,
  )

  it('returns x in ascending order with a matching y series', () => {
    const c = buildChart(dataset, all(n), chart({ type: 'line', bins: 12 }))
    expect(c.x).not.toBeNull()
    const x = Array.from(c.x!)
    expect(x.length).toBeGreaterThan(1)
    expect(x).toEqual([...x].sort((a, b) => a - b))
    for (let i = 1; i < x.length; i++) expect(x[i]).toBeGreaterThan(x[i - 1])
    expect(c.series[0].y.length).toBe(x.length)
    expect(c.xIsDate).toBe(true)
    expect(c.xLabels).toBeNull()
  })

  it('plots every non-null row exactly once', () => {
    const c = buildChart(dataset, all(n), chart({ type: 'line', bins: 12 }))
    expect(sum(c.series[0].y)).toBe(n)
  })

  it('stays x-ascending when the axis is not binned', () => {
    const small = ds(
      [{ name: 'x', kind: 'date', distinctCount: 12 }],
      [num(order.map((i) => times[i]), 'date')],
      n,
    )
    const c = buildChart(small, all(n), chart({ type: 'line', bins: 12 }))
    const x = Array.from(c.x!)
    expect(x).toEqual(times)
    expect(sum(c.series[0].y)).toBe(n)
  })

  it('stays x-ascending for a plain numeric axis too', () => {
    const d = ds([{ name: 'x', kind: 'int' }], [num([50, 10, 30, 20, 40])], 5)
    const c = buildChart(d, all(5), chart({ type: 'line', bins: 5 }))
    const x = Array.from(c.x!)
    expect(x).toEqual([...x].sort((a, b) => a - b))
    expect(c.xIsDate).toBe(false)
  })
})

describe('buildChart — binning a wide quantitative axis', () => {
  // distinctCount is left at -1 ("unknown"), which is the branch that forces
  // binning. Ascending-order checks alone cannot see this: the fixtures above
  // come back sorted whether they were bucketed or used raw. Here the axis is
  // 1000 values wide, so unbinned output would be 1000 keys in the Map — 1000
  // accumulators behind a top-12 bar chart, and 1000 points on a line.
  const N = 1000
  const dataset = ds(
    [{ name: 'x', kind: 'int' }],
    [num(Array.from({ length: N }, (_, i) => i))],
    N,
  )
  const starts = Array.from({ length: 10 }, (_, i) => i * 100)

  it('buckets a 1000-distinct line axis to the requested bin width', () => {
    const c = buildChart(dataset, all(N), chart({ type: 'line', bins: 10 }))
    expect(Array.from(c.x!)).toEqual(starts)
    expect(Array.from(c.series[0].y)).toEqual(starts.map(() => 100))
    expect(sum(c.series[0].y)).toBe(N)
  })

  it('buckets a 1000-distinct bar axis instead of building 1000 categories', () => {
    const c = buildChart(dataset, all(N), chart({ type: 'bar', bins: 10 }))
    expect(c.xLabels).toEqual(starts.map(String))
    expect(c.totalCategories).toBe(10)
    expect(c.truncated).toBe(false)
    expect(sum(c.series[0].y)).toBe(N)
  })
})

describe('buildChart — scatter', () => {
  it('returns x and y of equal length', () => {
    const xs = [1, 2, null, 4, 5, 6]
    const ys = [10, null, 30, 40, 50, null]
    const d = ds(
      [{ name: 'x', kind: 'float' }, { name: 'y', kind: 'float' }],
      [num(xs, 'float'), num(ys, 'float')],
      xs.length,
    )
    const c = buildChart(d, all(xs.length), chart({ type: 'scatter', yColumnId: 'y' }))
    expect(c.x!.length).toBe(c.series[0].y.length)
    // Only rows with both coordinates present survive: rows 0, 3, 4.
    expect(Array.from(c.x!)).toEqual([1, 4, 5])
    expect(Array.from(c.series[0].y)).toEqual([10, 40, 50])
    expect(c.sampled).toBe(3)
  })

  it('caps the point count at 20,000 and reports what it returned', () => {
    const n = 25_000
    const xs = Float64Array.from({ length: n }, (_, i) => i)
    const ys = Float64Array.from({ length: n }, (_, i) => i * 2)
    const d = ds(
      [{ name: 'x', kind: 'float' }, { name: 'y', kind: 'float' }],
      [{ kind: 'float', values: xs }, { kind: 'float', values: ys }],
      n,
    )
    const c = buildChart(d, all(n), chart({ type: 'scatter', yColumnId: 'y' }))
    expect(c.x!.length).toBeLessThanOrEqual(20_000)
    expect(c.x!.length).toBeGreaterThan(0)
    expect(c.series[0].y.length).toBe(c.x!.length)
    expect(c.sampled).toBe(c.x!.length)
    expect(c.truncated).toBe(true)
    // Sampling must preserve the y = 2x relationship it sampled.
    for (let i = 0; i < c.x!.length; i += 500) {
      expect(c.series[0].y[i]).toBe(c.x![i] * 2)
    }
  })

  it('does not sample below the cap', () => {
    const n = 100
    const d = ds(
      [{ name: 'x', kind: 'float' }, { name: 'y', kind: 'float' }],
      [
        { kind: 'float', values: Float64Array.from({ length: n }, (_, i) => i) },
        { kind: 'float', values: Float64Array.from({ length: n }, (_, i) => i) },
      ],
      n,
    )
    const c = buildChart(d, all(n), chart({ type: 'scatter', yColumnId: 'y' }))
    expect(c.x!.length).toBe(n)
    expect(c.truncated).toBe(false)
  })

  it('returns an empty chart when there is no y column', () => {
    const d = ds([{ name: 'x', kind: 'float' }], [num([1, 2, 3], 'float')], 3)
    const c = buildChart(d, all(3), chart({ type: 'scatter', yColumnId: null }))
    expect(c.series).toEqual([])
    expect(c.x).toBeNull()
  })

  it('returns an empty chart when an axis is not quantitative', () => {
    const d = ds(
      [{ name: 'x', kind: 'string', encoding: 'dict' }, { name: 'y', kind: 'float' }],
      [dict(['a', 'b', 'c']), num([1, 2, 3], 'float')],
      3,
    )
    const c = buildChart(d, all(3), chart({ type: 'scatter', yColumnId: 'y' }))
    expect(c.series).toEqual([])
    expect(c.x).toBeNull()
  })
})

describe('buildChart — degenerate input', () => {
  const data = ['a', 'b', 'a']
  const dataset = ds(
    [
      { name: 'x', kind: 'string', encoding: 'dict' },
      { name: 'v', kind: 'float' },
      { name: 'nul', kind: 'float' },
    ],
    [dict(data), num([1, 2, 3], 'float'), num([null, null, null], 'float')],
    3,
  )

  const types = ['bar', 'pie', 'line', 'histogram', 'scatter'] as const

  it.each(types)('%s: empty selection returns an empty, well-shaped chart', (type) => {
    let c: ReturnType<typeof buildChart>
    expect(() => {
      c = buildChart(dataset, new Uint32Array(0), chart({ type, yColumnId: 'v' }))
    }).not.toThrow()
    c = buildChart(dataset, new Uint32Array(0), chart({ type, yColumnId: 'v' }))
    expect(c.type).toBe(type)
    expect(c.series).toEqual([])
    expect(c.x).toBeNull()
    expect(c.xLabels).toBeNull()
    expect(c.totalCategories).toBe(0)
    expect(c.sampled).toBe(0)
    expect(c.truncated).toBe(false)
  })

  it.each(types)('%s: unknown x column returns an empty chart', (type) => {
    const c = buildChart(dataset, all(3), chart({ type, xColumnId: 'missing', yColumnId: 'v' }))
    expect(c.series).toEqual([])
    expect(c.x).toBeNull()
    expect(c.totalCategories).toBe(0)
  })

  it.each(types)('%s: unknown y column does not throw', (type) => {
    let c: ReturnType<typeof buildChart>
    expect(() => {
      c = buildChart(dataset, all(3), chart({ type, yColumnId: 'missing', agg: 'sum' }))
    }).not.toThrow()
    c = buildChart(dataset, all(3), chart({ type, yColumnId: 'missing', agg: 'sum' }))
    for (const s of c.series) for (const v of s.y) expect(Number.isNaN(v)).toBe(false)
  })

  it.each(['bar', 'pie', 'line'] as const)('%s: an all-null x column yields an empty chart', (type) => {
    const c = buildChart(dataset, all(3), chart({ type, xColumnId: 'nul', yColumnId: 'v' }))
    expect(c.series).toEqual([])
    expect(c.x).toBeNull()
    expect(c.totalCategories).toBe(0)
  })

  it.each(['bar', 'pie'] as const)('%s: a single distinct category yields one plotted value', (type) => {
    const d = ds([{ name: 'x', kind: 'string', encoding: 'dict' }], [dict(['z', 'z', 'z'])], 3)
    const c = buildChart(d, all(3), chart({ type, limit: 12 }))
    expect(c.xLabels).toEqual(['z'])
    expect(Array.from(c.series[0].y)).toEqual([3])
    expect(c.truncated).toBe(false)
    expect(c.totalCategories).toBe(1)
  })

  it('handles a limit of zero as a sane positive limit', () => {
    const c = buildChart(dataset, all(3), chart({ type: 'bar', limit: 0 }))
    expect(c.xLabels!.length).toBeGreaterThan(0)
    expect(sum(c.series[0].y)).toBe(3)
  })

  it('handles a bins request of zero', () => {
    const d = ds([{ name: 'x', kind: 'int' }], [num([1, 2, 3, 4, 5])], 5)
    const c = buildChart(d, all(5), chart({ type: 'histogram', bins: 0 }))
    expect(c.series[0].y.length).toBeGreaterThan(0)
    expect(sum(c.series[0].y)).toBe(5)
    for (let i = 0; i < c.x!.length; i++) expect(Number.isFinite(c.x![i])).toBe(true)
  })

  it('charts a bool x axis without inventing a null category', () => {
    const d = ds([{ name: 'x', kind: 'bool' }], [bool([true, false, null, true])], 4)
    const c = buildChart(d, all(4), chart({ type: 'bar' }))
    expect(new Set(c.xLabels)).toEqual(new Set(['true', 'false']))
    expect(sum(c.series[0].y)).toBe(3)
  })
})

describe('the "Other" fold re-aggregates rather than summing', () => {
  /**
   * Summing per-category results is only correct for count and sum. An "Other"
   * bar holding the sum of twenty averages dwarfs every real category and means
   * nothing, so the fold must merge the underlying accumulators.
   */
  function skewed() {
    const cats: string[] = []
    const vals: number[] = []
    // Six categories. a and b are the top two by average; c..f each average 10.
    const plan: [string, number[]][] = [
      ['a', [100, 100]],
      ['b', [90, 90]],
      ['c', [10, 10]],
      ['d', [10, 10]],
      ['e', [10, 10]],
      ['f', [10, 10]],
    ]
    for (const [name, xs] of plan) {
      for (const x of xs) {
        cats.push(name)
        vals.push(x)
      }
    }
    return ds(
      [
        { name: 'cat', kind: 'string', encoding: 'dict' },
        { name: 'v', kind: 'int' },
      ],
      [dict(cats), num(vals)],
      cats.length,
    )
  }

  const spec = (agg: AggFn): ChartSpec => ({
    id: 'c',
    title: 'c',
    type: 'bar',
    xColumnId: 'cat',
    yColumnId: 'v',
    agg,
    bins: 30,
    limit: 2,
    seriesColumnId: null,
  })

  it('averages the remainder instead of adding the averages up', () => {
    const d = skewed()
    const data = buildChart(d, all(12), spec('avg'))

    expect(data.truncated).toBe(true)
    expect(data.xLabels?.[data.xLabels.length - 1]).toBe('Other')

    const other = data.series[0].y[data.series[0].y.length - 1]
    // Four folded categories each averaging 10 -> the remainder averages 10.
    // Adding the four averages together would give 40.
    expect(other).toBeCloseTo(10, 10)
  })

  it('takes the true max of the remainder, not the sum of the maxima', () => {
    const data = buildChart(skewed(), all(12), spec('max'))
    const other = data.series[0].y[data.series[0].y.length - 1]
    expect(other).toBe(10)
  })

  it('still adds up when the aggregate really is additive', () => {
    const data = buildChart(skewed(), all(12), spec('sum'))
    const other = data.series[0].y[data.series[0].y.length - 1]
    // c..f contribute 8 rows of 10.
    expect(other).toBe(80)
  })

  it('counts every folded row when counting rows', () => {
    const d = skewed()
    const data = buildChart(d, all(12), { ...spec('count'), yColumnId: null })
    const y = data.series[0].y
    expect(y[y.length - 1]).toBe(8)
    // Nothing is lost by folding.
    expect(Array.from(y).reduce((a, b) => a + b, 0)).toBe(12)
  })
})
