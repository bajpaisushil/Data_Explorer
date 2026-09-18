/**
 * Query engine: filter -> search -> sort -> group -> materialise.
 *
 * Every hot loop reads TypedArrays and writes into a pre-sized TypedArray.
 * String work is hoisted out of the per-row path: dictionary columns are
 * resolved to a byte mask once, blob columns are compared as UTF-8 bytes.
 */

import type {
  BlobColumn,
  BoolColumn,
  CellValue,
  ColumnData,
  DatasetMeta,
  DictColumn,
  Filter,
  GroupRow,
  GroupSpec,
  QuantitativeColumn,
  RowWindow,
  SearchSpec,
  SortSpec,
  ValueCount,
} from '@/lib/types'

export interface Dataset {
  meta: DatasetMeta
  columns: ColumnData[]
}

const ENC = new TextEncoder()
const DEC = new TextDecoder()

/** Distinct group keys we are willing to materialise before we stop creating new ones. */
const MAX_GROUPS = 1 << 19
/** Cap on a single group's `distinct` set; the count saturates past this. */
const DISTINCT_CAP = 100_000
/** Cap on the map used by distinctValues over unbounded (blob / numeric) columns. */
const DISTINCT_SCAN_CAP = 200_000
/** Composite integer group keys are only safe while the product of cardinalities is exact. */
const MAX_COMPOSITE_KEY = 2 ** 40

/* ------------------------------------------------------------- accessors */

export function columnIndexOf(meta: DatasetMeta, columnId: string): number {
  const cols = meta.columns
  for (let i = 0; i < cols.length; i++) if (cols[i].id === columnId) return i
  return -1
}

function colOf(ds: Dataset, columnId: string): ColumnData | null {
  const i = columnIndexOf(ds.meta, columnId)
  if (i < 0 || i >= ds.columns.length) return null
  return ds.columns[i]
}

function blobIsNull(col: BlobColumn, row: number): boolean {
  return (col.nulls[row >> 3] & (1 << (row & 7))) !== 0
}

export function readString(col: DictColumn | BlobColumn, row: number): string | null {
  if (col.encoding === 'dict') {
    const c = col.codes[row]
    return c < 0 ? null : col.dictionary[c] ?? null
  }
  if (blobIsNull(col, row)) return null
  const s = col.offsets[row]
  const e = col.offsets[row + 1]
  return e <= s ? '' : DEC.decode(col.bytes.subarray(s, e))
}

export function readCell(col: ColumnData, row: number): CellValue {
  switch (col.kind) {
    case 'bool': {
      const v = col.values[row]
      return v === 2 ? null : v === 1
    }
    case 'string':
      return readString(col, row)
    default: {
      const v = col.values[row]
      return v !== v ? null : v
    }
  }
}

/** Null test that does not care about the physical encoding. */
function isNullAt(col: ColumnData, row: number): boolean {
  switch (col.kind) {
    case 'bool':
      return col.values[row] === 2
    case 'string':
      return col.encoding === 'dict' ? col.codes[row] < 0 : blobIsNull(col, row)
    default: {
      const v = col.values[row]
      return v !== v
    }
  }
}

/* ------------------------------------------------------------ predicates */

type RowPred = (row: number) => boolean

const FAIL: RowPred = () => false

function compileRegex(src: string, ci: boolean): RegExp | null {
  try {
    return new RegExp(src, ci ? 'i' : '')
  } catch {
    return null
  }
}

/** Operands arrive as numbers or strings; ISO date text is accepted for date columns. */
function toNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return NaN
  if (typeof v === 'number') return v
  const t = v.trim()
  if (t === '') return NaN
  const n = Number(t)
  return Number.isNaN(n) ? Date.parse(t) : n
}

/** 1 = true, 0 = false, -1 = not a boolean literal. */
function toBoolCode(v: string | number | null | undefined): number {
  if (typeof v === 'number') return v === 1 ? 1 : v === 0 ? 0 : -1
  if (v === null || v === undefined) return -1
  switch (v.trim().toLowerCase()) {
    case 'true': case 't': case 'yes': case 'y': case '1': return 1
    case 'false': case 'f': case 'no': case 'n': case '0': return 0
    default: return -1
  }
}

type StringTest = (s: string) => boolean

/** Applied once per dictionary entry, never once per row. */
function makeStringTest(f: Filter): StringTest | null {
  const ci = f.caseSensitive !== true
  const raw = f.value === null || f.value === undefined ? '' : String(f.value)
  const needle = ci ? raw.toLowerCase() : raw
  const norm: (s: string) => string = ci ? (s) => s.toLowerCase() : (s) => s
  switch (f.op) {
    case 'eq': return (s) => norm(s) === needle
    case 'ne': return (s) => norm(s) !== needle
    case 'contains': return (s) => norm(s).includes(needle)
    case 'notContains': return (s) => !norm(s).includes(needle)
    case 'startsWith': return (s) => norm(s).startsWith(needle)
    case 'endsWith': return (s) => norm(s).endsWith(needle)
    case 'isEmpty': return (s) => s.length === 0
    case 'in':
    case 'notIn': {
      const set = new Set<string>()
      const vals = f.values ?? []
      for (let i = 0; i < vals.length; i++) set.add(ci ? vals[i].toLowerCase() : vals[i])
      return f.op === 'in' ? (s) => set.has(norm(s)) : (s) => !set.has(norm(s))
    }
    case 'regex': {
      const rx = compileRegex(raw, ci)
      if (rx === null) return () => false
      return (s) => rx.test(s)
    }
    default:
      return null
  }
}

/* --------------------------------------------------------- byte matching */

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false
  return true
}

function spanEqBytes(b: Uint8Array, s: number, e: number, n: Uint8Array, fold: boolean): boolean {
  const len = n.length
  if (e - s !== len) return false
  for (let i = 0; i < len; i++) {
    let c = b[s + i]
    if (fold && c >= 65 && c <= 90) c += 32
    if (c !== n[i]) return false
  }
  return true
}

function spanStartsBytes(b: Uint8Array, s: number, e: number, n: Uint8Array, fold: boolean): boolean {
  const len = n.length
  if (e - s < len) return false
  for (let i = 0; i < len; i++) {
    let c = b[s + i]
    if (fold && c >= 65 && c <= 90) c += 32
    if (c !== n[i]) return false
  }
  return true
}

function spanEndsBytes(b: Uint8Array, s: number, e: number, n: Uint8Array, fold: boolean): boolean {
  const len = n.length
  if (e - s < len) return false
  const base = e - len
  for (let i = 0; i < len; i++) {
    let c = b[base + i]
    if (fold && c >= 65 && c <= 90) c += 32
    if (c !== n[i]) return false
  }
  return true
}

function spanHasBytes(b: Uint8Array, s: number, e: number, n: Uint8Array, fold: boolean): boolean {
  const len = n.length
  if (len === 0) return true
  const last = e - len
  const first = n[0]
  outer: for (let p = s; p <= last; p++) {
    let c = b[p]
    if (fold && c >= 65 && c <= 90) c += 32
    if (c !== first) continue
    for (let i = 1; i < len; i++) {
      let d = b[p + i]
      if (fold && d >= 65 && d <= 90) d += 32
      if (d !== n[i]) continue outer
    }
    return true
  }
  return false
}

/* ---------------------------------------------------- filter compilation */

function compileQuant(col: QuantitativeColumn, f: Filter): RowPred | null {
  const v = col.values
  if (f.op === 'isNull') return (r) => { const x = v[r]; return x !== x }
  if (f.op === 'notNull') return (r) => { const x = v[r]; return x === x }
  if (f.op === 'between') {
    let lo = toNum(f.value)
    let hi = toNum(f.value2)
    if (lo !== lo && hi !== hi) return FAIL
    if (lo !== lo) return (r) => v[r] <= hi
    if (hi !== hi) return (r) => v[r] >= lo
    if (lo > hi) { const t = lo; lo = hi; hi = t }
    return (r) => { const x = v[r]; return x >= lo && x <= hi }
  }
  const a = toNum(f.value)
  if (a !== a) {
    switch (f.op) {
      // no usable operand: every comparison is false, `ne` included
      case 'eq': case 'ne': case 'gt': case 'gte': case 'lt': case 'lte': return FAIL
      default: return null
    }
  }
  switch (f.op) {
    case 'eq': return (r) => v[r] === a
    case 'ne': return (r) => { const x = v[r]; return x === x && x !== a }
    case 'gt': return (r) => v[r] > a
    case 'gte': return (r) => v[r] >= a
    case 'lt': return (r) => v[r] < a
    case 'lte': return (r) => v[r] <= a
    default: return null
  }
}

function compileBool(col: BoolColumn, f: Filter): RowPred | null {
  const v = col.values
  switch (f.op) {
    case 'isTrue': return (r) => v[r] === 1
    case 'isFalse': return (r) => v[r] === 0
    case 'isNull': return (r) => v[r] === 2
    case 'notNull': return (r) => v[r] !== 2
    case 'eq':
    case 'ne': {
      const w = toBoolCode(f.value)
      if (w < 0) return FAIL
      return f.op === 'eq'
        ? (r) => v[r] === w
        : (r) => { const x = v[r]; return x !== 2 && x !== w }
    }
    default:
      return null
  }
}

function compileDict(col: DictColumn, f: Filter): RowPred | null {
  const codes = col.codes
  if (f.op === 'isNull') return (r) => codes[r] < 0
  if (f.op === 'notNull') return (r) => codes[r] >= 0
  const test = makeStringTest(f)
  if (test === null) return null
  const dict = col.dictionary
  const mask = new Uint8Array(dict.length)
  for (let i = 0; i < dict.length; i++) if (test(dict[i])) mask[i] = 1
  return (r) => {
    const c = codes[r]
    return c >= 0 && mask[c] === 1
  }
}

function compileBlob(col: BlobColumn, f: Filter): RowPred | null {
  const bytes = col.bytes
  const offsets = col.offsets
  switch (f.op) {
    case 'isNull': return (r) => blobIsNull(col, r)
    case 'notNull': return (r) => !blobIsNull(col, r)
    case 'isEmpty': return (r) => !blobIsNull(col, r) && offsets[r + 1] === offsets[r]
  }
  const ci = f.caseSensitive !== true
  const raw = f.value === null || f.value === undefined ? '' : String(f.value)
  const vals = f.values ?? []
  // ASCII folding over bytes is exact: no UTF-8 continuation byte can collide
  // with an ASCII code unit, so a non-ASCII haystack is still handled correctly.
  const byteable = !ci || (isAscii(raw) && vals.every(isAscii))
  if (byteable) {
    const fold = ci
    const needle = ENC.encode(fold ? raw.toLowerCase() : raw)
    switch (f.op) {
      case 'eq':
        return (r) => !blobIsNull(col, r) && spanEqBytes(bytes, offsets[r], offsets[r + 1], needle, fold)
      case 'ne':
        return (r) => !blobIsNull(col, r) && !spanEqBytes(bytes, offsets[r], offsets[r + 1], needle, fold)
      case 'startsWith':
        return (r) => !blobIsNull(col, r) && spanStartsBytes(bytes, offsets[r], offsets[r + 1], needle, fold)
      case 'endsWith':
        return (r) => !blobIsNull(col, r) && spanEndsBytes(bytes, offsets[r], offsets[r + 1], needle, fold)
      case 'contains':
        return (r) => !blobIsNull(col, r) && spanHasBytes(bytes, offsets[r], offsets[r + 1], needle, fold)
      case 'notContains':
        return (r) => !blobIsNull(col, r) && !spanHasBytes(bytes, offsets[r], offsets[r + 1], needle, fold)
      case 'in':
      case 'notIn': {
        const needles: Uint8Array[] = []
        for (let i = 0; i < vals.length; i++) needles.push(ENC.encode(fold ? vals[i].toLowerCase() : vals[i]))
        const hit = (r: number): boolean => {
          const s = offsets[r]
          const e = offsets[r + 1]
          for (let i = 0; i < needles.length; i++) if (spanEqBytes(bytes, s, e, needles[i], fold)) return true
          return false
        }
        return f.op === 'in'
          ? (r) => !blobIsNull(col, r) && hit(r)
          : (r) => !blobIsNull(col, r) && !hit(r)
      }
    }
  }
  // regex, or a non-ASCII case-insensitive needle: decode per row
  const test = makeStringTest(f)
  if (test === null) return null
  return (r) => {
    const s = readString(col, r)
    return s !== null && test(s)
  }
}

function compileFilter(ds: Dataset, f: Filter): RowPred | null {
  const col = colOf(ds, f.columnId)
  if (col === null) return null
  switch (col.kind) {
    case 'bool': return compileBool(col, f)
    case 'string': return col.encoding === 'dict' ? compileDict(col, f) : compileBlob(col, f)
    default: return compileQuant(col, f)
  }
}

/* ---------------------------------------------------------------- search */

/** Equality, or a digit-prefix match on the integer part done arithmetically. */
function numericSearchPred(values: Float64Array, term: string): RowPred | null {
  const t = term.trim()
  if (t === '') return null
  const num = Number(t)
  if (!Number.isFinite(num)) return null
  if (/^\d+$/.test(t)) {
    const pow = Math.pow(10, t.length)
    if (pow <= Number.MAX_SAFE_INTEGER) {
      return (r) => {
        const v = values[r]
        if (v !== v) return false
        if (v === num) return true
        let n = Math.trunc(Math.abs(v))
        while (n >= pow) n = Math.floor(n / 10)
        return n === num
      }
    }
  }
  return (r) => values[r] === num
}

/** A date term is turned into one epoch-ms range up front, never formatted per row. */
function dateSearchPred(values: Float64Array, term: string): RowPred | null {
  const t = term.trim()
  let lo: number
  let hi: number
  let m = /^(\d{4})$/.exec(t)
  if (m !== null) {
    const y = Number(m[1])
    lo = Date.UTC(y, 0, 1)
    hi = Date.UTC(y + 1, 0, 1)
  } else if ((m = /^(\d{4})-(\d{1,2})$/.exec(t)) !== null) {
    const y = Number(m[1])
    const mo = Number(m[2]) - 1
    if (mo < 0 || mo > 11) return null
    lo = Date.UTC(y, mo, 1)
    hi = Date.UTC(y, mo + 1, 1)
  } else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)) !== null) {
    const y = Number(m[1])
    const mo = Number(m[2]) - 1
    const d = Number(m[3])
    if (mo < 0 || mo > 11 || d < 1 || d > 31) return null
    lo = Date.UTC(y, mo, d)
    hi = lo + 86400000
  } else {
    return null
  }
  return (r) => {
    const v = values[r]
    return v >= lo && v < hi
  }
}

function searchPred(col: ColumnData, term: string, caseSensitive: boolean): RowPred | null {
  switch (col.kind) {
    case 'string': {
      const f: Filter = {
        id: '__search',
        columnId: '__search',
        op: 'contains',
        value: term,
        caseSensitive,
        enabled: true,
      }
      return col.encoding === 'dict' ? compileDict(col, f) : compileBlob(col, f)
    }
    case 'bool': {
      const t = caseSensitive ? term : term.toLowerCase()
      const wantTrue = 'true'.startsWith(t)
      const wantFalse = 'false'.startsWith(t)
      if (!wantTrue && !wantFalse) return null
      const v = col.values
      if (wantTrue && wantFalse) return (r) => v[r] !== 2
      return wantTrue ? (r) => v[r] === 1 : (r) => v[r] === 0
    }
    case 'date':
      return dateSearchPred(col.values, term)
    default:
      return numericSearchPred(col.values, term)
  }
}

function compileSearch(ds: Dataset, spec: SearchSpec): RowPred | null {
  const term = spec.term
  if (term === '') return null
  const scope = spec.columnIds
  const preds: RowPred[] = []
  const metaCols = ds.meta.columns
  for (let i = 0; i < metaCols.length && i < ds.columns.length; i++) {
    if (scope !== null && scope.indexOf(metaCols[i].id) < 0) continue
    const p = searchPred(ds.columns[i], term, spec.caseSensitive)
    if (p !== null) preds.push(p)
  }
  if (preds.length === 0) return FAIL
  if (preds.length === 1) return preds[0]
  const k = preds.length
  return (r) => {
    for (let i = 0; i < k; i++) if (preds[i](r)) return true
    return false
  }
}

/* --------------------------------------------------------------- filters */

export function applyFilters(ds: Dataset, filters: Filter[], search: SearchSpec | null): Uint32Array {
  const n = ds.meta.rowCount
  const preds: RowPred[] = []
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i]
    if (!f.enabled) continue
    const p = compileFilter(ds, f)
    if (p !== null) preds.push(p)
  }
  if (search !== null) {
    const p = compileSearch(ds, search)
    if (p !== null) preds.push(p)
  }
  const out = new Uint32Array(n)
  const k = preds.length
  if (k === 0) {
    for (let r = 0; r < n; r++) out[r] = r
    return out
  }
  let m = 0
  rows: for (let r = 0; r < n; r++) {
    for (let i = 0; i < k; i++) if (!preds[i](r)) continue rows
    out[m++] = r
  }
  return out.subarray(0, m)
}

/* ------------------------------------------------------------------ sort */

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const rankCache = new WeakMap<string[], { len: number; ranks: Int32Array }>()

/** code -> lexicographic rank, computed once per dictionary. */
function dictRanks(dictionary: string[]): Int32Array {
  const hit = rankCache.get(dictionary)
  if (hit !== undefined && hit.len === dictionary.length) return hit.ranks
  const n = dictionary.length
  const order: number[] = new Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  order.sort((a, b) => cmpStr(dictionary[a], dictionary[b]))
  const ranks = new Int32Array(n)
  for (let i = 0; i < n; i++) ranks[order[i]] = i
  rankCache.set(dictionary, { len: n, ranks })
  return ranks
}

const F64 = new Float64Array(1)
const U32 = new Uint32Array(F64.buffer)
/** Word index of the high half of a double in this runtime's byte order. */
const HI_WORD = (() => {
  F64[0] = 1
  return U32[1] === 0x3ff00000 ? 1 : 0
})()
const LO_WORD = 1 - HI_WORD

/** LSD radix over four 16-bit digits. Stable, so ties keep selection order. */
function radixSortByKeys(ids: Uint32Array, lo: Uint32Array, hi: Uint32Array): Uint32Array {
  const n = ids.length
  if (n < 2) return ids
  let srcI = ids
  let srcL = lo
  let srcH = hi
  let dstI: Uint32Array = new Uint32Array(n)
  let dstL: Uint32Array = new Uint32Array(n)
  let dstH: Uint32Array = new Uint32Array(n)
  const counts = new Uint32Array(65536)
  for (let pass = 0; pass < 4; pass++) {
    const useHi = pass >= 2
    const src = useHi ? srcH : srcL
    const shift = (pass & 1) === 0 ? 0 : 16
    counts.fill(0)
    for (let i = 0; i < n; i++) counts[(src[i] >>> shift) & 0xffff]++
    if (counts[(src[0] >>> shift) & 0xffff] === n) continue
    let sum = 0
    for (let d = 0; d < 65536; d++) {
      const c = counts[d]
      counts[d] = sum
      sum += c
    }
    for (let i = 0; i < n; i++) {
      const l = srcL[i]
      const h = srcH[i]
      const p = counts[((useHi ? h : l) >>> shift) & 0xffff]++
      dstI[p] = srcI[i]
      dstL[p] = l
      dstH[p] = h
    }
    let t: Uint32Array = srcI; srcI = dstI; dstI = t
    t = srcL; srcL = dstL; dstL = t
    t = srcH; srcH = dstH; dstH = t
  }
  return srcI
}

/** Single numeric key: nulls split off, the rest radix sorted on order-preserving bit keys. */
function sortSingleNumeric(sel: Uint32Array, values: Float64Array, desc: boolean): Uint32Array {
  const m = sel.length
  let nn = 0
  for (let i = 0; i < m; i++) {
    const v = values[sel[i]]
    if (v === v) nn++
  }
  const out = new Uint32Array(m)
  const ids = new Uint32Array(nn)
  const lo = new Uint32Array(nn)
  const hi = new Uint32Array(nn)
  let j = 0
  let t = nn
  for (let i = 0; i < m; i++) {
    const row = sel[i]
    const v = values[row]
    if (v !== v) {
      out[t++] = row
      continue
    }
    F64[0] = v === 0 ? 0 : v // collapse -0 onto +0
    let h = U32[HI_WORD]
    let l = U32[LO_WORD]
    if (h & 0x80000000) {
      h = ~h >>> 0
      l = ~l >>> 0
    } else {
      h = (h ^ 0x80000000) >>> 0
    }
    if (desc) {
      // complement instead of reversing afterwards, which would undo stability
      h = ~h >>> 0
      l = ~l >>> 0
    }
    ids[j] = row
    lo[j] = l
    hi[j] = h
    j++
  }
  out.set(radixSortByKeys(ids, lo, hi), 0)
  return out
}

/** Counting sort over small dense ranks (-1 = null, always last). */
function sortSingleRank(sel: Uint32Array, ranks: Int32Array, card: number, desc: boolean): Uint32Array {
  const m = sel.length
  const counts = new Uint32Array(card + 1)
  for (let i = 0; i < m; i++) {
    const r = ranks[i]
    counts[r < 0 ? card : desc ? card - 1 - r : r]++
  }
  let sum = 0
  for (let b = 0; b <= card; b++) {
    const c = counts[b]
    counts[b] = sum
    sum += c
  }
  const out = new Uint32Array(m)
  for (let i = 0; i < m; i++) {
    const r = ranks[i]
    out[counts[r < 0 ? card : desc ? card - 1 - r : r]++] = sel[i]
  }
  return out
}

interface CmpKey {
  dir: number
  /** Numeric key per selection position, NaN = null. Null for blob keys. */
  nums: Float64Array | null
  blob: BlobColumn | null
}

/** Ranks per selection position for a dict/bool column, or null when not applicable. */
function smallIntRanks(col: ColumnData, sel: Uint32Array): { ranks: Int32Array; card: number } | null {
  const m = sel.length
  if (col.kind === 'bool') {
    const ranks = new Int32Array(m)
    const v = col.values
    for (let i = 0; i < m; i++) {
      const x = v[sel[i]]
      ranks[i] = x === 2 ? -1 : x
    }
    return { ranks, card: 2 }
  }
  if (col.kind === 'string' && col.encoding === 'dict') {
    const rk = dictRanks(col.dictionary)
    const codes = col.codes
    const ranks = new Int32Array(m)
    for (let i = 0; i < m; i++) {
      const c = codes[sel[i]]
      ranks[i] = c < 0 ? -1 : rk[c]
    }
    return { ranks, card: col.dictionary.length }
  }
  return null
}

/** UTF-8 byte order equals code point order, so raw spans sort correctly. */
function cmpSpans(col: BlobColumn, ra: number, rb: number): number {
  const b = col.bytes
  const o = col.offsets
  const as = o[ra]
  const ae = o[ra + 1]
  const bs = o[rb]
  const be = o[rb + 1]
  let i = as
  let j = bs
  while (i < ae && j < be) {
    const d = b[i++] - b[j++]
    if (d !== 0) return d < 0 ? -1 : 1
  }
  const la = ae - as
  const lb = be - bs
  return la === lb ? 0 : la < lb ? -1 : 1
}

export function sortSelection(ds: Dataset, sel: Uint32Array, sorts: SortSpec[]): Uint32Array {
  const cols: ColumnData[] = []
  const dirs: number[] = []
  for (let i = 0; i < sorts.length; i++) {
    const c = colOf(ds, sorts[i].columnId)
    if (c === null) continue
    cols.push(c)
    dirs.push(sorts[i].dir === 'desc' ? -1 : 1)
  }
  const m = sel.length
  if (cols.length === 0 || m < 2) return sel

  if (cols.length === 1) {
    const col = cols[0]
    const desc = dirs[0] < 0
    if (col.kind !== 'string' && col.kind !== 'bool') return sortSingleNumeric(sel, col.values, desc)
    const small = smallIntRanks(col, sel)
    if (small !== null) return sortSingleRank(sel, small.ranks, small.card, desc)
  }

  const keys: CmpKey[] = []
  for (let k = 0; k < cols.length; k++) {
    const col = cols[k]
    if (col.kind === 'string' && col.encoding === 'blob') {
      keys.push({ dir: dirs[k], nums: null, blob: col })
      continue
    }
    const nums = new Float64Array(m)
    const small = smallIntRanks(col, sel)
    if (small !== null) {
      const ranks = small.ranks
      for (let i = 0; i < m; i++) {
        const r = ranks[i]
        nums[i] = r < 0 ? NaN : r
      }
    } else if (col.kind !== 'string' && col.kind !== 'bool') {
      const v = col.values
      for (let i = 0; i < m; i++) nums[i] = v[sel[i]]
    }
    keys.push({ dir: dirs[k], nums, blob: null })
  }

  const nk = keys.length
  const order = new Uint32Array(m)
  for (let i = 0; i < m; i++) order[i] = i
  // Tie-break on position, so the result is stable whatever sort the engine uses.
  order.sort((a, b) => {
    for (let k = 0; k < nk; k++) {
      const key = keys[k]
      const nums = key.nums
      if (nums !== null) {
        const av = nums[a]
        const bv = nums[b]
        const an = av !== av
        const bn = bv !== bv
        if (an || bn) {
          if (an && bn) continue
          return an ? 1 : -1
        }
        if (av < bv) return -key.dir
        if (av > bv) return key.dir
        continue
      }
      const col = key.blob
      if (col === null) continue
      const ra = sel[a]
      const rb = sel[b]
      const an = blobIsNull(col, ra)
      const bn = blobIsNull(col, rb)
      if (an || bn) {
        if (an && bn) continue
        return an ? 1 : -1
      }
      const c = cmpSpans(col, ra, rb)
      if (c !== 0) return c * key.dir
    }
    return a - b
  })
  const out = new Uint32Array(m)
  for (let i = 0; i < m; i++) out[i] = sel[order[i]]
  return out
}

/* ----------------------------------------------------------- materialise */

export function materializeWindow(
  ds: Dataset,
  sel: Uint32Array,
  offset: number,
  limit: number,
  columnIds: string[],
): RowWindow {
  const n = sel.length
  const off = Math.min(Math.max(Math.floor(offset) || 0, 0), n)
  const lim = Math.min(Math.max(Math.floor(limit) || 0, 0), n - off)
  const rowIds = sel.slice(off, off + lim)
  const ids: string[] = []
  const columns: CellValue[][] = []
  for (let c = 0; c < columnIds.length; c++) {
    const col = colOf(ds, columnIds[c])
    if (col === null) continue
    const out: CellValue[] = new Array(lim)
    for (let i = 0; i < lim; i++) out[i] = readCell(col, rowIds[i])
    ids.push(columnIds[c])
    columns.push(out)
  }
  return { offset: off, rowIds, columnIds: ids, columns }
}

/* ----------------------------------------------------------- aggregation */

function growF64(a: Float64Array, cap: number, fill: number): Float64Array {
  const next = new Float64Array(cap)
  if (fill !== 0) next.fill(fill)
  next.set(a)
  return next
}

interface MedianBuf {
  bufs: (Float64Array | null)[]
  lens: number[]
}

interface AggState {
  fn: string
  col: ColumnData | null
  /** Quantitative source, or null when the column is not quantitative. */
  nums: Float64Array | null
  boolVals: Uint8Array | null
  sum: Float64Array | null
  cnt: Float64Array | null
  min: Float64Array | null
  max: Float64Array | null
  nulls: Float64Array | null
  sets: (Set<number | string> | null)[] | null
  med: MedianBuf | null
  capped: boolean
}

function aggValue(st: AggState, row: number): number {
  if (st.nums !== null) return st.nums[row]
  if (st.boolVals !== null) {
    const v = st.boolVals[row]
    return v === 2 ? NaN : v
  }
  return NaN
}

function pushMedian(med: MedianBuf, slot: number, v: number): void {
  let buf = med.bufs[slot]
  let len = med.lens[slot]
  if (buf === undefined || buf === null) {
    buf = new Float64Array(16)
    len = 0
    med.bufs[slot] = buf
  } else if (len === buf.length) {
    const next = new Float64Array(buf.length * 2)
    next.set(buf)
    buf = next
    med.bufs[slot] = buf
  }
  buf[len] = v
  med.lens[slot] = len + 1
}

function medianOf(med: MedianBuf, slot: number): number | null {
  const buf = med.bufs[slot]
  const len = med.lens[slot]
  if (buf === undefined || buf === null || !len) return null
  const view = buf.subarray(0, len)
  view.sort()
  const mid = len >> 1
  return len % 2 === 1 ? view[mid] : (view[mid - 1] + view[mid]) / 2
}

export function groupAggregate(ds: Dataset, sel: Uint32Array, spec: GroupSpec): GroupRow[] {
  const m = sel.length
  const keyCols: (ColumnData | null)[] = []
  for (let i = 0; i < spec.columnIds.length; i++) keyCols.push(colOf(ds, spec.columnIds[i]))
  const present: ColumnData[] = []
  for (let i = 0; i < keyCols.length; i++) {
    const c = keyCols[i]
    if (c !== null) present.push(c)
  }

  // Composite integer key while every key column is dict/bool and the product fits.
  let intKeyed = present.length > 0
  const cards: number[] = []
  let product = 1
  for (let i = 0; i < present.length && intKeyed; i++) {
    const c = present[i]
    if (c.kind === 'bool') cards.push(3)
    else if (c.kind === 'string' && c.encoding === 'dict') cards.push(c.dictionary.length + 1)
    else { intKeyed = false; break }
    product *= cards[cards.length - 1]
    if (product > MAX_COMPOSITE_KEY) intKeyed = false
  }
  const singleNumeric =
    !intKeyed && present.length === 1 && present[0].kind !== 'string' && present[0].kind !== 'bool'

  let cap = 64
  let firstRow: Uint32Array = new Uint32Array(cap)
  let counts: Float64Array = new Float64Array(cap)
  let slots = 0

  const aggs: AggState[] = []
  for (let i = 0; i < spec.aggs.length; i++) {
    const a = spec.aggs[i]
    const col = colOf(ds, a.columnId)
    const st: AggState = {
      fn: a.fn,
      col,
      nums: col !== null && col.kind !== 'string' && col.kind !== 'bool' ? col.values : null,
      boolVals: col !== null && col.kind === 'bool' ? col.values : null,
      sum: null,
      cnt: null,
      min: null,
      max: null,
      nulls: null,
      sets: null,
      med: null,
      capped: false,
    }
    switch (a.fn) {
      case 'sum':
      case 'avg':
        st.sum = new Float64Array(cap)
        st.cnt = new Float64Array(cap)
        break
      case 'count':
        st.cnt = new Float64Array(cap)
        break
      case 'min':
        st.min = new Float64Array(cap).fill(Infinity)
        st.cnt = new Float64Array(cap)
        break
      case 'max':
        st.max = new Float64Array(cap).fill(-Infinity)
        st.cnt = new Float64Array(cap)
        break
      case 'nulls':
        st.nulls = new Float64Array(cap)
        break
      case 'distinct':
        st.sets = []
        break
      case 'median':
        st.med = { bufs: [], lens: [] }
        st.cnt = new Float64Array(cap)
        break
    }
    aggs.push(st)
  }

  const grow = (): void => {
    const next = cap * 2
    const fr = new Uint32Array(next)
    fr.set(firstRow)
    firstRow = fr
    counts = growF64(counts, next, 0)
    for (let i = 0; i < aggs.length; i++) {
      const st = aggs[i]
      if (st.sum !== null) st.sum = growF64(st.sum, next, 0)
      if (st.cnt !== null) st.cnt = growF64(st.cnt, next, 0)
      if (st.min !== null) st.min = growF64(st.min, next, Infinity)
      if (st.max !== null) st.max = growF64(st.max, next, -Infinity)
      if (st.nulls !== null) st.nulls = growF64(st.nulls, next, 0)
    }
    cap = next
  }

  const numMap = new Map<number, number>()
  const strMap = new Map<string, number>()

  for (let i = 0; i < m; i++) {
    const row = sel[i]
    let slot: number

    if (present.length === 0) {
      if (slots === 0) {
        slot = slots++
        firstRow[slot] = row
      } else {
        slot = 0
      }
    } else if (intKeyed || singleNumeric) {
      let key = 0
      if (intKeyed) {
        for (let k = 0; k < present.length; k++) {
          const c = present[k]
          const code = c.kind === 'bool' ? c.values[row] : (c as DictColumn).codes[row] + 1
          key = key * cards[k] + code
        }
      } else {
        key = (present[0] as QuantitativeColumn).values[row]
      }
      const hit = numMap.get(key)
      if (hit === undefined) {
        if (slots >= MAX_GROUPS) continue
        if (slots === cap) grow()
        slot = slots++
        numMap.set(key, slot)
        firstRow[slot] = row
      } else {
        slot = hit
      }
    } else {
      let key = ''
      for (let k = 0; k < present.length; k++) {
        if (k > 0) key += ''
        const c = present[k]
        if (c.kind === 'string') {
          const s = readString(c, row)
          key += s === null ? ' ' : s
        } else {
          key += c.values[row]
        }
      }
      const hit = strMap.get(key)
      if (hit === undefined) {
        if (slots >= MAX_GROUPS) continue
        if (slots === cap) grow()
        slot = slots++
        strMap.set(key, slot)
        firstRow[slot] = row
      } else {
        slot = hit
      }
    }

    counts[slot]++

    for (let a = 0; a < aggs.length; a++) {
      const st = aggs[a]
      switch (st.fn) {
        case 'count': {
          const cnt = st.cnt
          if (st.col === null || cnt === null) break
          if (!isNullAt(st.col, row)) cnt[slot]++
          break
        }
        case 'nulls': {
          const nl = st.nulls
          if (st.col === null || nl === null) break
          if (isNullAt(st.col, row)) nl[slot]++
          break
        }
        case 'sum':
        case 'avg': {
          const sum = st.sum
          const cnt = st.cnt
          if (sum === null || cnt === null) break
          const v = aggValue(st, row)
          if (v === v) {
            sum[slot] += v
            cnt[slot]++
          }
          break
        }
        case 'min': {
          const mn = st.min
          const cnt = st.cnt
          if (mn === null || cnt === null) break
          const v = aggValue(st, row)
          if (v === v) {
            if (v < mn[slot]) mn[slot] = v
            cnt[slot]++
          }
          break
        }
        case 'max': {
          const mx = st.max
          const cnt = st.cnt
          if (mx === null || cnt === null) break
          const v = aggValue(st, row)
          if (v === v) {
            if (v > mx[slot]) mx[slot] = v
            cnt[slot]++
          }
          break
        }
        case 'median': {
          const med = st.med
          const cnt = st.cnt
          if (med === null || cnt === null) break
          const v = aggValue(st, row)
          if (v === v) {
            pushMedian(med, slot, v)
            cnt[slot]++
          }
          break
        }
        case 'distinct': {
          const col = st.col
          const sets = st.sets
          if (col === null || sets === null) break
          let set = sets[slot]
          if (set === undefined || set === null) {
            set = new Set<number | string>()
            sets[slot] = set
          }
          if (set.size >= DISTINCT_CAP) {
            st.capped = true
            break
          }
          if (col.kind === 'string') {
            if (col.encoding === 'dict') {
              const c = col.codes[row]
              if (c >= 0) set.add(c)
            } else if (!blobIsNull(col, row)) {
              const s = readString(col, row)
              if (s !== null) set.add(s)
            }
          } else if (col.kind === 'bool') {
            const v = col.values[row]
            if (v !== 2) set.add(v)
          } else {
            const v = col.values[row]
            if (v === v) set.add(v)
          }
          break
        }
      }
    }
  }

  const rows: GroupRow[] = new Array(slots)
  for (let s = 0; s < slots; s++) {
    const row = firstRow[s]
    const keys: CellValue[] = new Array(keyCols.length)
    for (let k = 0; k < keyCols.length; k++) {
      const c = keyCols[k]
      keys[k] = c === null ? null : readCell(c, row)
    }
    const vals: (number | null)[] = new Array(aggs.length)
    for (let a = 0; a < aggs.length; a++) {
      const st = aggs[a]
      const cnt = st.cnt
      switch (st.fn) {
        case 'count':
          vals[a] = st.col === null || cnt === null ? counts[s] : cnt[s]
          break
        case 'nulls':
          vals[a] = st.nulls === null ? null : st.nulls[s]
          break
        case 'sum':
          vals[a] = st.sum !== null && cnt !== null && cnt[s] > 0 ? st.sum[s] : null
          break
        case 'avg':
          vals[a] = st.sum !== null && cnt !== null && cnt[s] > 0 ? st.sum[s] / cnt[s] : null
          break
        case 'min':
          vals[a] = st.min !== null && cnt !== null && cnt[s] > 0 ? st.min[s] : null
          break
        case 'max':
          vals[a] = st.max !== null && cnt !== null && cnt[s] > 0 ? st.max[s] : null
          break
        case 'median':
          vals[a] = st.med === null ? null : medianOf(st.med, s)
          break
        case 'distinct': {
          const set = st.sets === null ? null : st.sets[s]
          vals[a] = set === undefined || set === null ? 0 : set.size
          break
        }
        default:
          vals[a] = null
      }
    }
    rows[s] = { keys, count: counts[s], aggs: vals }
  }
  rows.sort((a, b) => b.count - a.count)
  return rows
}

/* ------------------------------------------------------------ group sort */

function cmpCellValue(a: CellValue, b: CellValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return (a === true ? 1 : 0) - (b === true ? 1 : 0)
  }
  return cmpStr(String(a), String(b))
}

export function sortGroups(rows: GroupRow[], spec: GroupSpec, sorts: SortSpec[]): GroupRow[] {
  /** kind 0 = group key, 1 = agg, 2 = row count. */
  interface GKey { kind: number; idx: number; dir: number }
  const keys: GKey[] = []
  for (let i = 0; i < sorts.length; i++) {
    const s = sorts[i]
    const dir = s.dir === 'desc' ? -1 : 1
    const gi = spec.columnIds.indexOf(s.columnId)
    if (gi >= 0) {
      keys.push({ kind: 0, idx: gi, dir })
      continue
    }
    let ai = -1
    for (let a = 0; a < spec.aggs.length; a++) if (spec.aggs[a].id === s.columnId) { ai = a; break }
    if (ai < 0) for (let a = 0; a < spec.aggs.length; a++) if (spec.aggs[a].columnId === s.columnId) { ai = a; break }
    if (ai >= 0) {
      keys.push({ kind: 1, idx: ai, dir })
      continue
    }
    if (s.columnId === 'count' || s.columnId === '__count') keys.push({ kind: 2, idx: 0, dir })
  }
  if (keys.length === 0) return rows
  const nk = keys.length
  const out = rows.slice()
  out.sort((ra, rb) => {
    for (let k = 0; k < nk; k++) {
      const key = keys[k]
      if (key.kind === 2) {
        const d = ra.count - rb.count
        if (d !== 0) return d < 0 ? -key.dir : key.dir
        continue
      }
      const a = key.kind === 0 ? ra.keys[key.idx] : ra.aggs[key.idx]
      const b = key.kind === 0 ? rb.keys[key.idx] : rb.aggs[key.idx]
      const an = a === null || a === undefined
      const bn = b === null || b === undefined
      if (an || bn) {
        if (an && bn) continue
        return an ? 1 : -1
      }
      const c = cmpCellValue(a, b)
      if (c !== 0) return c * key.dir
    }
    return 0
  })
  return out
}

/* -------------------------------------------------------------- distinct */

function rankCounts(entries: ValueCount[], limit: number): ValueCount[] {
  entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    if (a.value === null) return 1
    if (b.value === null) return -1
    return cmpStr(a.value, b.value)
  })
  return limit > 0 && entries.length > limit ? entries.slice(0, limit) : entries
}

export function distinctValues(
  ds: Dataset,
  sel: Uint32Array,
  columnId: string,
  limit: number,
  search?: string,
): ValueCount[] {
  const col = colOf(ds, columnId)
  if (col === null) return []
  const m = sel.length
  const term = search === undefined || search === null ? '' : search.toLowerCase()
  const matches = (s: string): boolean => term === '' || s.toLowerCase().includes(term)
  const entries: ValueCount[] = []
  let nulls = 0

  if (col.kind === 'string' && col.encoding === 'dict') {
    const counts = new Float64Array(col.dictionary.length)
    const codes = col.codes
    for (let i = 0; i < m; i++) {
      const c = codes[sel[i]]
      if (c < 0) nulls++
      else counts[c]++
    }
    for (let c = 0; c < counts.length; c++) {
      if (counts[c] === 0) continue
      const s = col.dictionary[c]
      if (matches(s)) entries.push({ value: s, count: counts[c] })
    }
  } else if (col.kind === 'bool') {
    let t = 0
    let f = 0
    const v = col.values
    for (let i = 0; i < m; i++) {
      const x = v[sel[i]]
      if (x === 2) nulls++
      else if (x === 1) t++
      else f++
    }
    if (t > 0 && matches('true')) entries.push({ value: 'true', count: t })
    if (f > 0 && matches('false')) entries.push({ value: 'false', count: f })
  } else if (col.kind === 'string') {
    const map = new Map<string, number>()
    for (let i = 0; i < m; i++) {
      const row = sel[i]
      if (blobIsNull(col, row)) {
        nulls++
        continue
      }
      const s = readString(col, row)
      if (s === null) continue
      const hit = map.get(s)
      if (hit === undefined) {
        if (map.size < DISTINCT_SCAN_CAP) map.set(s, 1)
      } else {
        map.set(s, hit + 1)
      }
    }
    for (const [s, c] of map) if (matches(s)) entries.push({ value: s, count: c })
  } else {
    const map = new Map<number, number>()
    const v = col.values
    const isDate = col.kind === 'date'
    for (let i = 0; i < m; i++) {
      const x = v[sel[i]]
      if (x !== x) {
        nulls++
        continue
      }
      const hit = map.get(x)
      if (hit === undefined) {
        if (map.size < DISTINCT_SCAN_CAP) map.set(x, 1)
      } else {
        map.set(x, hit + 1)
      }
    }
    for (const [x, c] of map) {
      const s = isDate ? isoFromEpochMs(x) : String(x)
      if (matches(s)) entries.push({ value: s, count: c })
    }
  }

  if (nulls > 0 && term === '') entries.push({ value: null, count: nulls })
  return rankCounts(entries, limit)
}

/* ---------------------------------------------------------------- extent */

export function extent(ds: Dataset, columnId: string): { min: number; max: number } {
  const col = colOf(ds, columnId)
  if (col === null || col.kind === 'string' || col.kind === 'bool') return { min: NaN, max: NaN }
  const v = col.values
  let mn = Infinity
  let mx = -Infinity
  for (let i = 0; i < v.length; i++) {
    const x = v[i]
    if (x !== x) continue
    if (x < mn) mn = x
    if (x > mx) mx = x
  }
  return mn === Infinity ? { min: NaN, max: NaN } : { min: mn, max: mx }
}

/* ------------------------------------------------------------------- csv */

const QUOTE = 34
const CR = 13
const LF = 10
const DELIM = 44

class ByteSink {
  private buf: Uint8Array
  private len = 0

  constructor(initial: number) {
    this.buf = new Uint8Array(Math.max(1024, initial))
  }

  private ensure(extra: number): void {
    const need = this.len + extra
    if (need <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < need) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  byte(b: number): void {
    this.ensure(1)
    this.buf[this.len++] = b
  }

  raw(src: Uint8Array, s: number, e: number): void {
    const n = e - s
    if (n <= 0) return
    this.ensure(n)
    this.buf.set(src.subarray(s, e), this.len)
    this.len += n
  }

  text(s: string): void {
    if (s.length === 0) return
    this.ensure(s.length * 3)
    this.len += ENC.encodeInto(s, this.buf.subarray(this.len)).written
  }

  done(): Uint8Array {
    return this.buf.subarray(0, this.len)
  }
}

function needsQuoteStr(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === DELIM || c === QUOTE || c === CR || c === LF) return true
  }
  return false
}

function csvFieldBytes(s: string): Uint8Array {
  return ENC.encode(needsQuoteStr(s) ? '"' + s.replace(/"/g, '""') + '"' : s)
}

function needsQuoteBytes(b: Uint8Array, s: number, e: number): boolean {
  for (let i = s; i < e; i++) {
    const c = b[i]
    if (c === DELIM || c === QUOTE || c === CR || c === LF) return true
  }
  return false
}

const TRUE_BYTES = ENC.encode('true')
const FALSE_BYTES = ENC.encode('false')

function pad(n: number, width: number): string {
  let s = String(n)
  while (s.length < width) s = '0' + s
  return s
}

/** ISO-8601 UTC without allocating a Date per cell (civil-from-days). */
function isoFromEpochMs(ms: number): string {
  const days = Math.floor(ms / 86400000)
  const rem = ms - days * 86400000
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  )
  const y0 = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const mo = mp < 10 ? mp + 3 : mp - 9
  const y = mo <= 2 ? y0 + 1 : y0
  const hh = Math.floor(rem / 3600000)
  const mi = Math.floor(rem / 60000) % 60
  const ss = Math.floor(rem / 1000) % 60
  const mss = rem % 1000
  const year = y < 0 ? '-' + pad(-y, 6) : y > 9999 ? '+' + pad(y, 6) : pad(y, 4)
  return year + '-' + pad(mo, 2) + '-' + pad(d, 2) + 'T' + pad(hh, 2) + ':' + pad(mi, 2) + ':' + pad(ss, 2) + '.' + pad(mss, 3) + 'Z'
}

export function toCsv(ds: Dataset, sel: Uint32Array, columnIds: string[], limit: number): Uint8Array {
  const cols: ColumnData[] = []
  const names: string[] = []
  for (let c = 0; c < columnIds.length; c++) {
    const i = columnIndexOf(ds.meta, columnIds[c])
    if (i < 0 || i >= ds.columns.length) continue
    cols.push(ds.columns[i])
    names.push(ds.meta.columns[i].name)
  }
  const rows = limit > 0 ? Math.min(limit, sel.length) : sel.length
  const sink = new ByteSink(Math.min(1 << 22, 64 + rows * Math.max(1, cols.length) * 12))

  for (let c = 0; c < names.length; c++) {
    if (c > 0) sink.byte(DELIM)
    const b = csvFieldBytes(names[c])
    sink.raw(b, 0, b.length)
  }
  sink.byte(CR)
  sink.byte(LF)

  // Dictionary entries are encoded (and quoted) once, then copied per row.
  const dictFields: (Uint8Array[] | null)[] = new Array(cols.length)
  for (let c = 0; c < cols.length; c++) {
    const col = cols[c]
    if (col.kind === 'string' && col.encoding === 'dict') {
      const fields: Uint8Array[] = new Array(col.dictionary.length)
      for (let i = 0; i < col.dictionary.length; i++) fields[i] = csvFieldBytes(col.dictionary[i])
      dictFields[c] = fields
    } else {
      dictFields[c] = null
    }
  }

  for (let i = 0; i < rows; i++) {
    const row = sel[i]
    for (let c = 0; c < cols.length; c++) {
      if (c > 0) sink.byte(DELIM)
      const col = cols[c]
      if (col.kind === 'bool') {
        const v = col.values[row]
        if (v === 1) sink.raw(TRUE_BYTES, 0, TRUE_BYTES.length)
        else if (v === 0) sink.raw(FALSE_BYTES, 0, FALSE_BYTES.length)
        continue
      }
      if (col.kind === 'string') {
        const fields = dictFields[c]
        if (fields !== null && col.encoding === 'dict') {
          const code = col.codes[row]
          if (code >= 0) {
            const b = fields[code]
            sink.raw(b, 0, b.length)
          }
          continue
        }
        if (col.encoding !== 'blob') continue
        if (blobIsNull(col, row)) continue
        const bytes = col.bytes
        const s = col.offsets[row]
        const e = col.offsets[row + 1]
        if (!needsQuoteBytes(bytes, s, e)) {
          sink.raw(bytes, s, e)
          continue
        }
        sink.byte(QUOTE)
        let run = s
        for (let p = s; p < e; p++) {
          if (bytes[p] !== QUOTE) continue
          sink.raw(bytes, run, p + 1)
          sink.byte(QUOTE)
          run = p + 1
        }
        sink.raw(bytes, run, e)
        sink.byte(QUOTE)
        continue
      }
      const v = col.values[row]
      if (v !== v) continue
      sink.text(col.kind === 'date' ? isoFromEpochMs(v) : String(v))
    }
    sink.byte(CR)
    sink.byte(LF)
  }
  return sink.done()
}
