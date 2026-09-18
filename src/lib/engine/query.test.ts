import { describe, expect, it } from 'vitest'
import {
  applyFilters,
  columnIndexOf,
  distinctValues,
  extent,
  groupAggregate,
  materializeWindow,
  readCell,
  sortSelection,
  toCsv,
  type Dataset,
} from './query'
import type {
  ColumnData,
  ColumnKind,
  ColumnMeta,
  DatasetMeta,
  Filter,
  FilterOp,
} from '@/lib/types'

/* ------------------------------------------------------------- fixtures */

function meta(columns: { name: string; kind: ColumnKind; encoding?: 'dict' | 'blob' }[], rows: number): DatasetMeta {
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
      distinctCount: -1,
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

function all(n: number): Uint32Array {
  const sel = new Uint32Array(n)
  for (let i = 0; i < n; i++) sel[i] = i
  return sel
}

function filter(columnId: string, op: FilterOp, extra: Partial<Filter> = {}): Filter {
  return { id: `f_${columnId}_${op}`, columnId, op, enabled: true, caseSensitive: false, ...extra }
}

/** Six rows, every column kind, nulls in each. */
function fixture(): Dataset {
  return {
    meta: meta(
      [
        { name: 'n', kind: 'int' },
        { name: 'f', kind: 'float' },
        { name: 'd', kind: 'date' },
        { name: 'b', kind: 'bool' },
        { name: 's', kind: 'string', encoding: 'dict' },
        { name: 'u', kind: 'string', encoding: 'blob' },
      ],
      6,
    ),
    columns: [
      num([5, 3, null, 1, 9, 3]),
      num([1.5, -2.5, 0, null, 10.25, 1.5], 'float'),
      num([Date.UTC(2024, 0, 2), Date.UTC(2024, 0, 1), null, Date.UTC(2024, 0, 4), Date.UTC(2024, 0, 3), Date.UTC(2024, 0, 1)], 'date'),
      bool([true, false, null, true, false, true]),
      dict(['apple', 'Banana', null, 'cherry', 'apple', '']),
      blob(['id-001', 'ID-002', null, 'id-003', 'id-004', '']),
    ],
  }
}

const ids = (sel: Uint32Array) => Array.from(sel)

/* ---------------------------------------------------------------- basics */

describe('readCell', () => {
  it('reads every storage layout, mapping sentinels to null', () => {
    const ds = fixture()
    expect(readCell(ds.columns[0], 0)).toBe(5)
    expect(readCell(ds.columns[0], 2)).toBeNull()
    expect(readCell(ds.columns[3], 0)).toBe(true)
    expect(readCell(ds.columns[3], 1)).toBe(false)
    expect(readCell(ds.columns[3], 2)).toBeNull()
    expect(readCell(ds.columns[4], 1)).toBe('Banana')
    expect(readCell(ds.columns[4], 2)).toBeNull()
    expect(readCell(ds.columns[5], 0)).toBe('id-001')
    expect(readCell(ds.columns[5], 2)).toBeNull()
    // An empty string is a value, not a null.
    expect(readCell(ds.columns[4], 5)).toBe('')
    expect(readCell(ds.columns[5], 5)).toBe('')
  })
})

describe('columnIndexOf', () => {
  it('returns -1 for an unknown column', () => {
    expect(columnIndexOf(fixture().meta, 'nope')).toBe(-1)
    expect(columnIndexOf(fixture().meta, 'd')).toBe(2)
  })
})

/* --------------------------------------------------------------- filters */

describe('applyFilters — numeric', () => {
  const ds = fixture()
  const run = (op: FilterOp, extra?: Partial<Filter>) =>
    ids(applyFilters(ds, [filter('n', op, extra)], null))

  it('compares, excluding nulls from every comparison', () => {
    expect(run('eq', { value: 3 })).toEqual([1, 5])
    expect(run('gt', { value: 3 })).toEqual([0, 4])
    expect(run('gte', { value: 3 })).toEqual([0, 1, 4, 5])
    expect(run('lt', { value: 3 })).toEqual([3])
    expect(run('lte', { value: 3 })).toEqual([1, 3, 5])
  })

  it('treats "not equal" as false for nulls, not true', () => {
    // Row 2 is null; it must not appear just because null !== 3.
    expect(run('ne', { value: 3 })).toEqual([0, 3, 4])
  })

  it('handles between inclusively and tolerates swapped bounds', () => {
    expect(run('between', { value: 3, value2: 5 })).toEqual([0, 1, 5])
    expect(run('between', { value: 5, value2: 3 })).toEqual([0, 1, 5])
  })

  it('isNull and notNull are the only ops that see nulls', () => {
    expect(run('isNull')).toEqual([2])
    expect(run('notNull')).toEqual([0, 1, 3, 4, 5])
  })
})

describe('applyFilters — strings', () => {
  const ds = fixture()
  const runOn = (col: string, op: FilterOp, extra?: Partial<Filter>) =>
    ids(applyFilters(ds, [filter(col, op, extra)], null))

  it('is case-insensitive by default on both encodings', () => {
    expect(runOn('s', 'eq', { value: 'banana' })).toEqual([1])
    expect(runOn('u', 'contains', { value: 'ID-00' })).toEqual([0, 1, 3, 4])
  })

  it('respects caseSensitive when asked', () => {
    expect(runOn('s', 'eq', { value: 'banana', caseSensitive: true })).toEqual([])
    expect(runOn('s', 'eq', { value: 'Banana', caseSensitive: true })).toEqual([1])
  })

  it('supports prefix and suffix matching', () => {
    expect(runOn('s', 'startsWith', { value: 'a' })).toEqual([0, 4])
    expect(runOn('u', 'endsWith', { value: '3' })).toEqual([3])
  })

  it('distinguishes empty string from null', () => {
    expect(runOn('s', 'isEmpty')).toEqual([5])
    expect(runOn('s', 'isNull')).toEqual([2])
  })

  it('matches value sets', () => {
    expect(runOn('s', 'in', { values: ['apple', 'cherry'] })).toEqual([0, 3, 4])
    expect(runOn('s', 'notIn', { values: ['apple'] })).toEqual([1, 3, 5])
  })

  it('treats an invalid regex as matching nothing rather than throwing', () => {
    expect(() => runOn('s', 'regex', { value: '([' })).not.toThrow()
    expect(runOn('s', 'regex', { value: '([' })).toEqual([])
    expect(runOn('s', 'regex', { value: '^a' })).toEqual([0, 4])
  })
})

describe('applyFilters — booleans and composition', () => {
  const ds = fixture()

  it('filters booleans without treating null as false', () => {
    expect(ids(applyFilters(ds, [filter('b', 'isTrue')], null))).toEqual([0, 3, 5])
    expect(ids(applyFilters(ds, [filter('b', 'isFalse')], null))).toEqual([1, 4])
    expect(ids(applyFilters(ds, [filter('b', 'isNull')], null))).toEqual([2])
  })

  it('ANDs multiple filters and ignores disabled ones', () => {
    expect(
      ids(applyFilters(ds, [filter('n', 'gte', { value: 3 }), filter('b', 'isTrue')], null)),
    ).toEqual([0, 5])

    expect(
      ids(applyFilters(ds, [filter('n', 'gte', { value: 3 }), filter('b', 'isTrue', { enabled: false })], null)),
    ).toEqual([0, 1, 4, 5])
  })

  it('returns every row when there is nothing to filter', () => {
    expect(ids(applyFilters(ds, [], null))).toEqual([0, 1, 2, 3, 4, 5])
  })
})

describe('applyFilters — search', () => {
  const ds = fixture()

  it('ORs a term across columns', () => {
    const hits = ids(applyFilters(ds, [], { term: 'cherry', columnIds: null, caseSensitive: false }))
    expect(hits).toEqual([3])
  })

  it('can be scoped to named columns', () => {
    const hits = ids(applyFilters(ds, [], { term: 'apple', columnIds: ['s'], caseSensitive: false }))
    expect(hits).toEqual([0, 4])
  })

  it('finds nothing for a term present in no column', () => {
    expect(ids(applyFilters(ds, [], { term: 'zzz', columnIds: null, caseSensitive: false }))).toEqual([])
  })
})

/* ------------------------------------------------------------------ sort */

describe('sortSelection', () => {
  const ds = fixture()

  it('sorts numerically with nulls last in both directions', () => {
    const asc = ids(sortSelection(ds, all(6), [{ columnId: 'n', dir: 'asc' }]))
    expect(asc.slice(0, 5)).toEqual([3, 1, 5, 0, 4])
    expect(asc[5]).toBe(2)

    const desc = ids(sortSelection(ds, all(6), [{ columnId: 'n', dir: 'desc' }]))
    expect(desc.slice(0, 5)).toEqual([4, 0, 1, 5, 3])
    // Nulls stay last even when the direction flips.
    expect(desc[5]).toBe(2)
  })

  it('is stable for equal keys', () => {
    // Rows 1 and 5 both hold 3; source order must survive.
    const asc = ids(sortSelection(ds, all(6), [{ columnId: 'n', dir: 'asc' }]))
    expect(asc.indexOf(1)).toBeLessThan(asc.indexOf(5))
  })

  it('breaks ties with a second key', () => {
    const sorted = ids(
      sortSelection(ds, all(6), [
        { columnId: 'n', dir: 'asc' },
        { columnId: 'f', dir: 'desc' },
      ]),
    )
    expect(sorted[5]).toBe(2)
  })

  it('orders dictionary strings lexicographically, case-insensitively', () => {
    const asc = ids(sortSelection(ds, all(6), [{ columnId: 's', dir: 'asc' }]))
    const values = asc.map((r) => readCell(ds.columns[4], r))
    expect(values[values.length - 1]).toBeNull()
    const nonNull = values.slice(0, -1) as string[]
    const reference = [...nonNull].sort((a, b) =>
      a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0,
    )
    expect(nonNull).toEqual(reference)
  })

  it('returns the selection unchanged when there is no sort', () => {
    expect(ids(sortSelection(ds, all(6), []))).toEqual([0, 1, 2, 3, 4, 5])
  })
})

/* ------------------------------------------------------------- windowing */

describe('materializeWindow', () => {
  const ds = fixture()

  it('returns raw JS values column-major', () => {
    const win = materializeWindow(ds, all(6), 0, 3, ['n', 's'])
    expect(win.columnIds).toEqual(['n', 's'])
    expect(win.columns[0]).toEqual([5, 3, null])
    expect(win.columns[1]).toEqual(['apple', 'Banana', null])
    expect(Array.from(win.rowIds)).toEqual([0, 1, 2])
  })

  it('clamps at the tail rather than overrunning', () => {
    const win = materializeWindow(ds, all(6), 4, 50, ['n'])
    expect(win.columns[0]).toHaveLength(2)
    expect(win.offset).toBe(4)
  })

  it('survives an offset past the end', () => {
    const win = materializeWindow(ds, all(6), 99, 10, ['n'])
    expect(win.columns[0] ?? []).toHaveLength(0)
  })

  it('honours the selection order, not source order', () => {
    const sel = Uint32Array.from([4, 0, 1])
    const win = materializeWindow(ds, sel, 0, 3, ['n'])
    expect(win.columns[0]).toEqual([9, 5, 3])
  })
})

/* ---------------------------------------------------------------- groups */

describe('groupAggregate', () => {
  const ds: Dataset = {
    meta: meta(
      [
        { name: 'cat', kind: 'string', encoding: 'dict' },
        { name: 'v', kind: 'int' },
      ],
      7,
    ),
    columns: [
      dict(['a', 'b', 'a', 'b', 'a', 'c', 'c']),
      num([1, 10, 2, 20, null, 5, 5]),
    ],
  }

  it('counts rows per key, including rows whose measure is null', () => {
    const rows = groupAggregate(ds, all(7), { columnIds: ['cat'], aggs: [] })
    const byKey = new Map(rows.map((r) => [String(r.keys[0]), r.count]))
    expect(byKey.get('a')).toBe(3)
    expect(byKey.get('b')).toBe(2)
    expect(byKey.get('c')).toBe(2)
  })

  it('aggregates measures, skipping nulls', () => {
    const rows = groupAggregate(ds, all(7), {
      columnIds: ['cat'],
      aggs: [
        { id: 's', columnId: 'v', fn: 'sum' },
        { id: 'a', columnId: 'v', fn: 'avg' },
        { id: 'mn', columnId: 'v', fn: 'min' },
        { id: 'mx', columnId: 'v', fn: 'max' },
        { id: 'n', columnId: 'v', fn: 'nulls' },
      ],
    })
    const a = rows.find((r) => r.keys[0] === 'a')
    expect(a).toBeDefined()
    expect(a!.aggs[0]).toBe(3) // 1 + 2, null skipped
    expect(a!.aggs[1]).toBeCloseTo(1.5) // mean over the two non-nulls
    expect(a!.aggs[2]).toBe(1)
    expect(a!.aggs[3]).toBe(2)
    expect(a!.aggs[4]).toBe(1)
  })

  it('computes a median', () => {
    const rows = groupAggregate(ds, all(7), {
      columnIds: ['cat'],
      aggs: [{ id: 'm', columnId: 'v', fn: 'median' }],
    })
    expect(rows.find((r) => r.keys[0] === 'b')!.aggs[0]).toBe(15)
  })

  it('groups by two columns', () => {
    const two: Dataset = {
      meta: meta(
        [
          { name: 'x', kind: 'string', encoding: 'dict' },
          { name: 'y', kind: 'string', encoding: 'dict' },
        ],
        4,
      ),
      columns: [dict(['a', 'a', 'b', 'b']), dict(['p', 'q', 'p', 'p'])],
    }
    const rows = groupAggregate(two, all(4), { columnIds: ['x', 'y'], aggs: [] })
    expect(rows).toHaveLength(3)
    const bp = rows.find((r) => r.keys[0] === 'b' && r.keys[1] === 'p')
    expect(bp!.count).toBe(2)
  })

  it('returns nothing for an empty selection', () => {
    expect(groupAggregate(ds, new Uint32Array(0), { columnIds: ['cat'], aggs: [] })).toEqual([])
  })
})

/* ------------------------------------------------------- distinct/extent */

describe('distinctValues and extent', () => {
  const ds = fixture()

  it('counts distinct values', () => {
    const values = distinctValues(ds, all(6), 's', 10)
    const apple = values.find((v) => v.value === 'apple')
    expect(apple?.count).toBe(2)
  })

  it('reports the numeric range, ignoring nulls', () => {
    expect(extent(ds, 'n')).toEqual({ min: 1, max: 9 })
  })

  it('returns NaN bounds for an all-null column', () => {
    const empty: Dataset = {
      meta: meta([{ name: 'z', kind: 'int' }], 3),
      columns: [num([null, null, null])],
    }
    const e = extent(empty, 'z')
    expect(Number.isNaN(e.min)).toBe(true)
    expect(Number.isNaN(e.max)).toBe(true)
  })
})

/* ------------------------------------------------------------------- csv */

describe('toCsv', () => {
  it('quotes only fields that need it and round-trips', () => {
    const ds: Dataset = {
      meta: meta([{ name: 'text', kind: 'string', encoding: 'dict' }], 4),
      columns: [dict(['plain', 'has,comma', 'has"quote', 'has\nnewline'])],
    }
    const csv = new TextDecoder().decode(toCsv(ds, all(4), ['text'], 0))
    expect(csv).toContain('plain')
    expect(csv).toContain('"has,comma"')
    expect(csv).toContain('"has""quote"')
    expect(csv).toContain('"has\nnewline"')
    // RFC-4180 line endings are CRLF.
    expect(csv.split('\r\n')[0]).toBe('text')
  })

  it('emits a header even when there are no rows', () => {
    const ds = fixture()
    const csv = new TextDecoder().decode(toCsv(ds, new Uint32Array(0), ['n'], 0))
    expect(csv.trim()).toBe('n')
  })
})

/* ------------------------------------------- cross-check against a naive ref */

describe('filter + sort against a reference implementation', () => {
  it('agrees with a naive scan over 50,000 synthetic rows', () => {
    const n = 50_000
    const values: (number | null)[] = new Array(n)
    const cats: (string | null)[] = new Array(n)
    let seed = 99
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
    for (let i = 0; i < n; i++) {
      const r = rnd()
      values[i] = r < 0.05 ? null : Math.floor(r * 1000)
      cats[i] = r < 0.03 ? null : ['alpha', 'beta', 'gamma', 'delta'][i % 4]
    }

    const ds: Dataset = {
      meta: meta(
        [
          { name: 'v', kind: 'int' },
          { name: 'c', kind: 'string', encoding: 'dict' },
        ],
        n,
      ),
      columns: [num(values), dict(cats)],
    }

    const sel = applyFilters(
      ds,
      [filter('v', 'gte', { value: 500 }), filter('c', 'eq', { value: 'beta' })],
      null,
    )

    const expected: number[] = []
    for (let i = 0; i < n; i++) {
      if (values[i] !== null && values[i]! >= 500 && cats[i] === 'beta') expected.push(i)
    }
    expect(ids(sel)).toEqual(expected)

    const sorted = ids(sortSelection(ds, sel, [{ columnId: 'v', dir: 'desc' }]))
    const refSorted = [...expected].sort((a, b) => values[b]! - values[a]! || a - b)
    expect(sorted).toEqual(refSorted)
  })
})
