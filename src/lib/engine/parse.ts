import type {
  BlobColumn,
  BoolColumn,
  ColumnData,
  ColumnKind,
  ColumnMeta,
  DatasetMeta,
  DictColumn,
  QuantitativeColumn,
  StringEncoding,
} from '@/lib/types'
import type { ParseOptions, Progress } from '@/lib/engine/protocol'

export interface ParsedDataset {
  meta: DatasetMeta
  columns: ColumnData[]
}

/* ------------------------------------------------------------- constants */

const CH_TAB = 9
const CH_LF = 10
const CH_CR = 13
const CH_QUOTE = 34
const CH_PERCENT = 37
const CH_COMMA = 44
const CH_DOT = 46
const CH_COLON = 58
const CH_SEMI = 59
const CH_PIPE = 124

const DISTINCT_CAP = 65536
const EVIDENCE_LIMIT = 10000
const PROGRESS_MASK = 0xffff
const EMIT_MS = 16
const YIELD_MS = 250
const ASCII_FAST_MAX = 128

const MAX_SAFE = Number.MAX_SAFE_INTEGER

/* --------------------------------------------------------- null handling */

function lc(c: number): number {
  return c >= 65 && c <= 90 ? c + 32 : c
}

/**
 * "" / whitespace-only / the conventional sentinels. `extra` is matched
 * exactly (parseBytes seeds it with case variants) so no per-row allocation.
 */
export function isNullToken(s: string, extra?: Set<string>): boolean {
  const n = s.length
  if (n === 0) return true
  if (extra !== undefined && extra.has(s)) return true
  let ws = true
  for (let i = 0; i < n; i++) {
    if (s.charCodeAt(i) > 32) {
      ws = false
      break
    }
  }
  if (ws) return true
  if (n > 4) return false
  const c0 = lc(s.charCodeAt(0))
  if (n === 1) return c0 === 45
  if (c0 !== 110) return false
  const c1 = lc(s.charCodeAt(1))
  if (n === 2) return c1 === 97
  if (n === 3) {
    const c2 = lc(s.charCodeAt(2))
    if (c1 === 105 && c2 === 108) return true
    if (c1 === 47 && c2 === 97) return true
    if (c1 === 97 && c2 === 110) return true
    return false
  }
  const c2 = lc(s.charCodeAt(2))
  const c3 = lc(s.charCodeAt(3))
  if (c1 === 117 && c2 === 108 && c3 === 108) return true
  if (c1 === 111 && c2 === 110 && c3 === 101) return true
  return false
}

function utf8Length(s: string): number {
  const n = s.length
  let bytes = 0
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

/* --------------------------------------------------------- number scanning */

const NUM_INT = 1
const NUM_THOUSANDS = 2
const NUM_CURRENCY = 4
const NUM_PERCENT = 8
const NUM_OVERFLOW = 16

let numValue = NaN
let numFlags = 0

function isCurrency(c: number): boolean {
  return c === 36 || c === 163 || c === 165 || c === 8364
}

/** Fills `numValue` / `numFlags`. Returns false when `s` is not numeric. */
function scanNumber(s: string): boolean {
  let i = 0
  let j = s.length
  while (i < j && s.charCodeAt(i) <= 32) i++
  while (j > i && s.charCodeAt(j - 1) <= 32) j--
  if (i >= j) return false

  let flags = 0
  let neg = false
  let c = s.charCodeAt(i)
  if (c === 43 || c === 45) {
    neg = c === 45
    i++
    if (i >= j) return false
    c = s.charCodeAt(i)
  }
  if (isCurrency(c)) {
    flags |= NUM_CURRENCY
    i++
    while (i < j && s.charCodeAt(i) <= 32) i++
    if (i >= j) return false
    c = s.charCodeAt(i)
    if (!neg && (c === 43 || c === 45)) {
      neg = c === 45
      i++
      if (i >= j) return false
    }
  }
  if (s.charCodeAt(j - 1) === CH_PERCENT) {
    flags |= NUM_PERCENT
    j--
    while (j > i && s.charCodeAt(j - 1) <= 32) j--
    if (i >= j) return false
  }

  const numStart = i
  let digits = 0
  let groupLen = 0
  let sawComma = false
  let intVal = 0
  while (i < j) {
    const ch = s.charCodeAt(i)
    if (ch >= 48 && ch <= 57) {
      digits++
      groupLen++
      intVal = intVal * 10 + (ch - 48)
      i++
    } else if (ch === CH_COMMA) {
      if (digits === 0) return false
      if (sawComma ? groupLen !== 3 : groupLen < 1 || groupLen > 3) return false
      sawComma = true
      groupLen = 0
      i++
    } else break
  }
  if (sawComma) {
    if (groupLen !== 3) return false
    flags |= NUM_THOUSANDS
  }

  let isInt = true
  if (i < j && s.charCodeAt(i) === CH_DOT) {
    isInt = false
    i++
    let fd = 0
    while (i < j) {
      const ch = s.charCodeAt(i)
      if (ch < 48 || ch > 57) break
      fd++
      i++
    }
    digits += fd
  }
  if (digits === 0) return false
  if (i < j) {
    const ch = s.charCodeAt(i)
    if (ch === 101 || ch === 69) {
      isInt = false
      i++
      if (i < j) {
        const sg = s.charCodeAt(i)
        if (sg === 43 || sg === 45) i++
      }
      let ed = 0
      while (i < j) {
        const d = s.charCodeAt(i)
        if (d < 48 || d > 57) break
        ed++
        i++
      }
      if (ed === 0) return false
    }
  }
  if (i !== j) return false

  if (isInt) {
    flags |= NUM_INT
    if (intVal > MAX_SAFE) flags |= NUM_OVERFLOW
    else {
      numValue = neg ? -intVal : intVal
      numFlags = flags
      return true
    }
  }
  let sub = s.slice(numStart, j)
  if (sawComma) sub = sub.split(',').join('')
  const v = Number(sub)
  if (Number.isNaN(v)) return false
  numValue = neg ? -v : v
  numFlags = flags
  return true
}

export function parseNumberValue(s: string): number {
  return scanNumber(s) ? numValue : NaN
}

/* ----------------------------------------------------------- date scanning */

const DF_NONE = 0
const DF_ISO = 1
const DF_YMD = 2
const DF_AMBIG = 3
const DF_MDY = 4
const DF_DMY = 5
const DF_EPOCH_S = 6
const DF_EPOCH_MS = 7

const DATE_FORMAT_LABEL = [
  '',
  'ISO-8601',
  'YYYY/MM/DD',
  '',
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'epoch-s',
  'epoch-ms',
]

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function daysInMonth(y: number, m: number): number {
  if (m === 2 && ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) return 29
  return DAYS_IN_MONTH[m - 1]
}

let rdVal = 0
let rdLen = 0
let rdPos = 0

function readDigits(s: string, i: number, max: number): void {
  const n = s.length
  let v = 0
  let k = 0
  while (i < n && k < max) {
    const c = s.charCodeAt(i)
    if (c < 48 || c > 57) break
    v = v * 10 + (c - 48)
    i++
    k++
  }
  rdVal = v
  rdLen = k
  rdPos = i
}

let dsFmt = DF_NONE
let dsY = 0
let dsA = 0
let dsB = 0
let dsTime = 0

function dateFromParts(y: number, mo: number, d: number, timeMs: number): number {
  if (mo < 1 || mo > 12) return NaN
  if (d < 1 || d > daysInMonth(y, mo)) return NaN
  let base = Date.UTC(y, mo - 1, d)
  if (y >= 0 && y <= 99) {
    // Date.UTC maps 0-99 onto 1900-1999; restore the literal year.
    const dt = new Date(base)
    dt.setUTCFullYear(y)
    base = dt.getTime()
  }
  return base + timeMs
}

/** Fills dsFmt/dsY/dsA/dsB/dsTime. dsA,dsB are month,day (year-first) or n1,n2. */
function scanDate(s: string): boolean {
  const n = s.length
  if (n < 6 || n > 40) return false
  readDigits(s, 0, 4)
  const d0 = rdLen
  const v0 = rdVal
  let i = rdPos
  if (i >= n) return false
  const sep = s.charCodeAt(i)
  if (sep !== 45 && sep !== 47) return false
  i++
  readDigits(s, i, 2)
  if (rdLen < 1) return false
  const v1 = rdVal
  i = rdPos
  if (i >= n || s.charCodeAt(i) !== sep) return false
  i++
  readDigits(s, i, 4)
  const d2 = rdLen
  const v2 = rdVal
  i = rdPos

  let fmt: number
  let y: number
  let a: number
  let b: number
  if (d0 === 4) {
    if (d2 < 1 || d2 > 2) return false
    y = v0
    a = v1
    b = v2
    fmt = sep === 45 ? DF_ISO : DF_YMD
    if (a < 1 || a > 12 || b < 1 || b > daysInMonth(y, a)) return false
  } else if (d0 === 1 || d0 === 2) {
    if (d2 !== 4) return false
    y = v2
    a = v0
    b = v1
    fmt = DF_AMBIG
    const mdyOk = a >= 1 && a <= 12 && b >= 1 && b <= daysInMonth(y, a)
    const dmyOk = b >= 1 && b <= 12 && a >= 1 && a <= daysInMonth(y, b)
    if (!mdyOk && !dmyOk) return false
  } else return false

  let timeMs = 0
  if (i < n) {
    const c = s.charCodeAt(i)
    if (c !== 84 && c !== 116 && c !== 32) return false
    i++
    readDigits(s, i, 2)
    if (rdLen !== 2) return false
    const h = rdVal
    i = rdPos
    if (i >= n || s.charCodeAt(i) !== CH_COLON) return false
    i++
    readDigits(s, i, 2)
    if (rdLen !== 2) return false
    const mi = rdVal
    i = rdPos
    let sec = 0
    let frac = 0
    if (i < n && s.charCodeAt(i) === CH_COLON) {
      i++
      readDigits(s, i, 2)
      if (rdLen !== 2) return false
      sec = rdVal
      i = rdPos
      if (i < n && s.charCodeAt(i) === CH_DOT) {
        i++
        readDigits(s, i, 9)
        if (rdLen < 1) return false
        let v = rdVal
        let k = rdLen
        while (k > 3) {
          v = Math.floor(v / 10)
          k--
        }
        while (k < 3) {
          v = v * 10
          k++
        }
        frac = v
        i = rdPos
      }
    }
    if (h > 23 || mi > 59 || sec > 60) return false
    timeMs = ((h * 60 + mi) * 60 + sec) * 1000 + frac
    if (i < n) {
      const t = s.charCodeAt(i)
      if (t === 90 || t === 122) i++
      else if (t === 43 || t === 45) {
        const sign = t === 45 ? -1 : 1
        i++
        readDigits(s, i, 2)
        if (rdLen !== 2) return false
        const th = rdVal
        i = rdPos
        let tm = 0
        if (i < n && s.charCodeAt(i) === CH_COLON) {
          i++
          readDigits(s, i, 2)
          if (rdLen !== 2) return false
          tm = rdVal
          i = rdPos
        } else if (i < n) {
          readDigits(s, i, 2)
          if (rdLen !== 2) return false
          tm = rdVal
          i = rdPos
        }
        if (th > 14 || tm > 59) return false
        timeMs -= sign * (th * 60 + tm) * 60000
      } else return false
    }
    if (i !== n) return false
  }

  dsFmt = fmt
  dsY = y
  dsA = a
  dsB = b
  dsTime = timeMs
  return true
}

export function parseDateValue(s: string): number {
  if (!scanDate(s)) return NaN
  if (dsFmt === DF_AMBIG) {
    if (dsA <= 12) {
      const v = dateFromParts(dsY, dsA, dsB, dsTime)
      if (!Number.isNaN(v)) return v
    }
    return dateFromParts(dsY, dsB, dsA, dsTime)
  }
  return dateFromParts(dsY, dsA, dsB, dsTime)
}

function parseDateAs(s: string, fmt: number): number {
  if (fmt === DF_EPOCH_S || fmt === DF_EPOCH_MS) {
    if (!scanNumber(s)) return NaN
    return fmt === DF_EPOCH_S ? numValue * 1000 : numValue
  }
  if (!scanDate(s)) return NaN
  if (dsFmt === DF_AMBIG) {
    if (fmt === DF_DMY) {
      const v = dateFromParts(dsY, dsB, dsA, dsTime)
      if (!Number.isNaN(v)) return v
      return dateFromParts(dsY, dsA, dsB, dsTime)
    }
    const v = dateFromParts(dsY, dsA, dsB, dsTime)
    if (!Number.isNaN(v)) return v
    return dateFromParts(dsY, dsB, dsA, dsTime)
  }
  return dateFromParts(dsY, dsA, dsB, dsTime)
}

/* ------------------------------------------------------------------ bools */

/** -1 not a bool, 0 false-word, 1 true-word, 2 "0", 3 "1". */
function boolToken(s: string): number {
  const n = s.length
  if (n === 1) {
    const c = lc(s.charCodeAt(0))
    if (c === 48) return 2
    if (c === 49) return 3
    if (c === 116 || c === 121) return 1
    if (c === 102 || c === 110) return 0
    return -1
  }
  if (n === 2) {
    return lc(s.charCodeAt(0)) === 110 && lc(s.charCodeAt(1)) === 111 ? 0 : -1
  }
  if (n === 3) {
    return lc(s.charCodeAt(0)) === 121 && lc(s.charCodeAt(1)) === 101 && lc(s.charCodeAt(2)) === 115
      ? 1
      : -1
  }
  if (n === 4) {
    return lc(s.charCodeAt(0)) === 116 &&
      lc(s.charCodeAt(1)) === 114 &&
      lc(s.charCodeAt(2)) === 117 &&
      lc(s.charCodeAt(3)) === 101
      ? 1
      : -1
  }
  if (n === 5) {
    return lc(s.charCodeAt(0)) === 102 &&
      lc(s.charCodeAt(1)) === 97 &&
      lc(s.charCodeAt(2)) === 108 &&
      lc(s.charCodeAt(3)) === 115 &&
      lc(s.charCodeAt(4)) === 101
      ? 0
      : -1
  }
  return -1
}

/* --------------------------------------------------------- header hints */

function headerSuggestsFlag(name: string): boolean {
  const l = name.toLowerCase()
  if (l.startsWith('is_') || l.startsWith('has_')) return true
  if (l.includes('_flag') || l.endsWith('flag')) return true
  return /^(is|has)[A-Z]/.test(name)
}

function headerSuggestsDate(name: string): boolean {
  const l = name.toLowerCase()
  return (
    l.includes('date') ||
    l.includes('time') ||
    l.endsWith('_at') ||
    l.endsWith('_ts') ||
    l.includes('_at_') ||
    l.includes('_ts_') ||
    l === 'ts' ||
    l === 'at'
  )
}

/* ----------------------------------------------------------- column stats */

interface ColStat {
  nonNull: number
  nullCount: number
  numOk: number
  numInt: number
  numThousands: number
  numBigPlain: number
  numOverflow: number
  numCurrency: number
  numPercent: number
  numMin: number
  numMax: number
  boolOk: number
  boolWord: number
  dtIso: number
  dtYmd: number
  dtAmbig: number
  dtN1Gt12: number
  dtN2Gt12: number
  maxBytes: number
  sumBytes: number
  distinct: Map<string, number> | null
  distinctOver: boolean
}

function newColStat(): ColStat {
  return {
    nonNull: 0,
    nullCount: 0,
    numOk: 0,
    numInt: 0,
    numThousands: 0,
    numBigPlain: 0,
    numOverflow: 0,
    numCurrency: 0,
    numPercent: 0,
    numMin: Infinity,
    numMax: -Infinity,
    boolOk: 0,
    boolWord: 0,
    dtIso: 0,
    dtYmd: 0,
    dtAmbig: 0,
    dtN1Gt12: 0,
    dtN2Gt12: 0,
    maxBytes: 0,
    sumBytes: 0,
    distinct: new Map<string, number>(),
    distinctOver: false,
  }
}

/**
 * Tally evidence for one non-null value. Each candidate type is only re-tested
 * while every earlier value matched it, so dead candidates cost nothing.
 */
function observe(st: ColStat, s: string, byteLen: number): void {
  const nn = st.nonNull
  st.nonNull = nn + 1
  if (byteLen > st.maxBytes) st.maxBytes = byteLen
  st.sumBytes += byteLen

  if (st.numOk === nn && scanNumber(s)) {
    st.numOk++
    const f = numFlags
    if ((f & NUM_INT) !== 0) {
      st.numInt++
      if ((f & NUM_OVERFLOW) !== 0) st.numOverflow++
      else if ((f & NUM_THOUSANDS) === 0 && (numValue >= 1000 || numValue <= -1000)) st.numBigPlain++
    }
    if ((f & NUM_THOUSANDS) !== 0) st.numThousands++
    if ((f & NUM_CURRENCY) !== 0) st.numCurrency++
    if ((f & NUM_PERCENT) !== 0) st.numPercent++
    if ((f & NUM_OVERFLOW) === 0) {
      if (numValue < st.numMin) st.numMin = numValue
      if (numValue > st.numMax) st.numMax = numValue
    }
  }

  if (st.boolOk === nn) {
    const t = boolToken(s)
    if (t >= 0) {
      st.boolOk++
      if (t < 2) st.boolWord++
    }
  }

  if (st.dtIso + st.dtYmd + st.dtAmbig === nn && scanDate(s)) {
    if (dsFmt === DF_ISO) st.dtIso++
    else if (dsFmt === DF_YMD) st.dtYmd++
    else {
      st.dtAmbig++
      if (dsA > 12) st.dtN1Gt12++
      if (dsB > 12) st.dtN2Gt12++
    }
  }

  const m = st.distinct
  if (m !== null) {
    if (!m.has(s)) {
      if (m.size >= DISTINCT_CAP) {
        st.distinctOver = true
        st.distinct = null
      } else m.set(s, 0)
    }
    // A column that has only ever held numbers can never need a dictionary;
    // drop the map once the evidence window closes to bound memory and time.
    if (st.distinct !== null && st.nonNull >= EVIDENCE_LIMIT && st.numOk === st.nonNull) {
      st.distinct = null
    }
  }
}

interface ColPlan {
  kind: ColumnKind
  encoding?: StringEncoding
  dateFormat?: string
  dateCode: number
  distinct: number
}

function stringPlan(st: ColStat, rowCount: number): ColPlan {
  const m = st.distinct
  const distinct = m === null ? -1 : m.size
  const encoding: StringEncoding =
    distinct >= 0 && distinct <= DISTINCT_CAP && distinct * 2 <= rowCount ? 'dict' : 'blob'
  return { kind: 'string', encoding, dateCode: DF_NONE, distinct }
}

function numericDistinct(st: ColStat): number {
  return st.distinct === null ? -1 : st.distinct.size
}

function finalizePlan(st: ColStat, name: string, rowCount: number): ColPlan {
  const nn = st.nonNull
  if (nn === 0) return stringPlan(st, rowCount)

  const thousandsOk = st.numThousands === 0 || st.numBigPlain === 0
  const allNum = st.numOk === nn
  // Currency and percent are float territory even when the digits are integral.
  const allInt =
    allNum &&
    st.numInt === nn &&
    st.numOverflow === 0 &&
    thousandsOk &&
    st.numCurrency === 0 &&
    st.numPercent === 0

  // Epoch integers only outrank `int` when the header advertises a timestamp.
  if (allInt && headerSuggestsDate(name)) {
    const lo = st.numMin
    const hi = st.numMax
    if (lo >= 1e8 && hi < 1e11) {
      return { kind: 'date', dateCode: DF_EPOCH_S, dateFormat: DATE_FORMAT_LABEL[DF_EPOCH_S], distinct: numericDistinct(st) }
    }
    if (lo >= 1e11 && hi < 1e14) {
      return { kind: 'date', dateCode: DF_EPOCH_MS, dateFormat: DATE_FORMAT_LABEL[DF_EPOCH_MS], distinct: numericDistinct(st) }
    }
  }

  if (st.boolOk === nn && (st.boolWord > 0 || headerSuggestsFlag(name))) {
    return { kind: 'bool', dateCode: DF_NONE, distinct: -1 }
  }

  if (allInt) return { kind: 'int', dateCode: DF_NONE, distinct: numericDistinct(st) }

  if (
    allNum &&
    thousandsOk &&
    (st.numCurrency === 0 || st.numCurrency === nn) &&
    (st.numPercent === 0 || st.numPercent === nn)
  ) {
    return { kind: 'float', dateCode: DF_NONE, distinct: numericDistinct(st) }
  }

  if (st.dtIso + st.dtYmd + st.dtAmbig === nn) {
    let code = DF_NONE
    if (st.dtAmbig === nn) {
      if (st.dtN1Gt12 > 0 && st.dtN2Gt12 > 0) code = DF_NONE
      else if (st.dtN1Gt12 > 0) code = DF_DMY
      else code = DF_MDY
    } else if (st.dtAmbig === 0) {
      code = st.dtIso === 0 ? DF_YMD : DF_ISO
    } else code = DF_ISO
    if (code !== DF_NONE) {
      return { kind: 'date', dateCode: code, dateFormat: DATE_FORMAT_LABEL[code], distinct: numericDistinct(st) }
    }
  }

  return stringPlan(st, rowCount)
}

export function inferKind(samples: string[]): ColumnKind {
  const st = newColStat()
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    if (isNullToken(s)) st.nullCount++
    else observe(st, s, utf8Length(s))
  }
  return finalizePlan(st, '', samples.length).kind
}

/* ------------------------------------------------------- field scanning */

/** RFC-4180 byte-level field reader. Reused across both passes. */
class FieldScanner {
  private readonly b: Uint8Array
  private readonly len: number
  private readonly delim: number
  pos = 0
  start = 0
  end = 0
  escapes = 0
  quoted = false
  rowEnd = false

  constructor(b: Uint8Array, delim: number) {
    this.b = b
    this.len = b.length
    this.delim = delim
  }

  reset(pos: number): void {
    this.pos = pos
  }

  next(): boolean {
    const b = this.b
    const len = this.len
    const delim = this.delim
    let i = this.pos
    if (i >= len) return false
    this.escapes = 0
    this.rowEnd = false
    this.quoted = false

    if (b[i] === CH_QUOTE) {
      this.quoted = true
      i++
      this.start = i
      let closed = false
      while (i < len) {
        const c = b[i]
        if (c === CH_QUOTE) {
          if (i + 1 < len && b[i + 1] === CH_QUOTE) {
            this.escapes++
            i += 2
            continue
          }
          this.end = i
          i++
          closed = true
          break
        }
        i++
      }
      if (!closed) {
        this.end = len
        this.pos = len
        this.rowEnd = true
        return true
      }
      while (i < len) {
        const c = b[i]
        if (c === delim || c === CH_LF || c === CH_CR) break
        i++
      }
    } else {
      this.start = i
      while (i < len) {
        const c = b[i]
        if (c === delim || c === CH_LF || c === CH_CR) break
        i++
      }
      this.end = i
    }

    if (i >= len) {
      this.pos = len
      this.rowEnd = true
      return true
    }
    const c = b[i]
    if (c === delim) {
      this.pos = i + 1
      return true
    }
    if (c === CH_CR) {
      i++
      if (i < len && b[i] === CH_LF) i++
    } else i++
    this.pos = i
    this.rowEnd = true
    return true
  }
}

/** One reused TextDecoder plus an ASCII fast path and an unescape scratch. */
class FieldDecoder {
  private readonly dec = new TextDecoder('utf-8')
  private scratch = new Uint8Array(512)

  decode(b: Uint8Array, start: number, end: number, escaped: boolean): string {
    let src = b
    let s = start
    let e = end
    if (escaped) {
      const raw = end - start
      if (this.scratch.length < raw) this.scratch = new Uint8Array(raw * 2)
      const sc = this.scratch
      let p = 0
      for (let i = start; i < end; i++) {
        const c = b[i]
        sc[p++] = c
        if (c === CH_QUOTE && i + 1 < end && b[i + 1] === CH_QUOTE) i++
      }
      src = sc
      s = 0
      e = p
    }
    const n = e - s
    if (n === 0) return ''
    if (n > ASCII_FAST_MAX) return this.dec.decode(src.subarray(s, e))
    for (let i = s; i < e; i++) {
      if (src[i] > 127) return this.dec.decode(src.subarray(s, e))
    }
    let out = ''
    let i = s
    while (i + 8 <= e) {
      out += String.fromCharCode(
        src[i],
        src[i + 1],
        src[i + 2],
        src[i + 3],
        src[i + 4],
        src[i + 5],
        src[i + 6],
        src[i + 7],
      )
      i += 8
    }
    while (i < e) {
      out += String.fromCharCode(src[i])
      i++
    }
    return out
  }
}

/* --------------------------------------------------------- delimiter sniff */

const SNIFF_CANDIDATES = [CH_COMMA, CH_TAB, CH_SEMI, CH_PIPE]
const SNIFF_CHARS = [',', '\t', ';', '|']
const SNIFF_LINES = 50

export function sniffDelimiter(sample: string): string {
  let best = ','
  let bestScore = -1
  for (let k = 0; k < SNIFF_CANDIDATES.length; k++) {
    const dc = SNIFF_CANDIDATES[k]
    const counts: number[] = []
    let inQ = false
    let fields = 1
    const n = sample.length
    for (let i = 0; i < n && counts.length < SNIFF_LINES; i++) {
      const c = sample.charCodeAt(i)
      if (inQ) {
        if (c === CH_QUOTE) {
          if (sample.charCodeAt(i + 1) === CH_QUOTE) i++
          else inQ = false
        }
        continue
      }
      if (c === CH_QUOTE) {
        inQ = true
        continue
      }
      if (c === dc) {
        fields++
        continue
      }
      if (c === CH_LF || c === CH_CR) {
        if (c === CH_CR && sample.charCodeAt(i + 1) === CH_LF) i++
        counts.push(fields)
        fields = 1
      }
    }
    if (counts.length === 0) counts.push(fields)
    let mode = 0
    let modeHits = 0
    for (let a = 0; a < counts.length; a++) {
      let hits = 0
      for (let b = 0; b < counts.length; b++) if (counts[b] === counts[a]) hits++
      if (hits > modeHits || (hits === modeHits && counts[a] > mode)) {
        mode = counts[a]
        modeHits = hits
      }
    }
    const score = mode <= 1 ? 0 : (modeHits / counts.length) * 100 + Math.min(mode - 1, 64) * 0.5
    if (score > bestScore) {
      bestScore = score
      best = SNIFF_CHARS[k]
    }
  }
  return best
}

/* ------------------------------------------------------------- ids & meta */

function slugify(name: string): string {
  const lower = name.toLowerCase()
  let out = ''
  let pending = false
  for (let i = 0; i < lower.length; i++) {
    const c = lower.charCodeAt(i)
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c > 127) {
      if (pending && out.length > 0) out += '_'
      pending = false
      out += lower[i]
    } else if (out.length > 0) pending = true
  }
  return out
}

function makeColumnIds(names: string[]): string[] {
  const used = new Set<string>()
  const ids: string[] = new Array(names.length)
  for (let i = 0; i < names.length; i++) {
    let base = slugify(names[i])
    if (base === '') base = 'column_' + (i + 1)
    let id = base
    let n = 2
    while (used.has(id)) {
      id = base + '_' + n
      n++
    }
    used.add(id)
    ids[i] = id
  }
  return ids
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/* ---------------------------------------------------------------- builders */

interface NumBuilder {
  tag: 0
  kind: 'int' | 'float' | 'date'
  dateCode: number
  values: Float64Array
}

interface BoolBuilder {
  tag: 1
  values: Uint8Array
  trueCount: number
  falseCount: number
}

interface DictBuilder {
  tag: 2
  codes: Int32Array
  map: Map<string, number>
  dictionary: string[]
}

interface BlobBuilder {
  tag: 3
  bytes: Uint8Array
  len: number
  offsets: Uint32Array
  nulls: Uint8Array
}

type Builder = NumBuilder | BoolBuilder | DictBuilder | BlobBuilder

function createBuilder(plan: ColPlan, st: ColStat, rowCount: number): Builder {
  if (plan.kind === 'bool') {
    return { tag: 1, values: new Uint8Array(rowCount), trueCount: 0, falseCount: 0 }
  }
  if (plan.kind !== 'string') {
    return {
      tag: 0,
      kind: plan.kind,
      dateCode: plan.dateCode,
      values: new Float64Array(rowCount),
    }
  }
  if (plan.encoding === 'dict') {
    const m = st.distinct === null ? new Map<string, number>() : st.distinct
    const dictionary: string[] = new Array(m.size)
    let i = 0
    // Reuse the pass-1 set as the value -> code index; insertion order is kept.
    for (const key of m.keys()) {
      dictionary[i] = key
      m.set(key, i)
      i++
    }
    return { tag: 2, codes: new Int32Array(rowCount), map: m, dictionary }
  }
  return {
    tag: 3,
    bytes: new Uint8Array(st.sumBytes + 64),
    len: 0,
    offsets: new Uint32Array(rowCount + 1),
    nulls: new Uint8Array((rowCount + 7) >> 3),
  }
}

function ensureBlob(b: BlobBuilder, need: number): void {
  const required = b.len + need
  if (required <= b.bytes.length) return
  let cap = b.bytes.length === 0 ? 64 : b.bytes.length
  while (cap < required) cap = Math.ceil(cap * 1.6)
  const next = new Uint8Array(cap)
  next.set(b.bytes.subarray(0, b.len))
  b.bytes = next
}

function blobPushBytes(
  b: BlobBuilder,
  src: Uint8Array,
  start: number,
  end: number,
  escaped: boolean,
): void {
  ensureBlob(b, end - start)
  const dst = b.bytes
  let p = b.len
  if (!escaped) {
    dst.set(src.subarray(start, end), p)
    p += end - start
  } else {
    for (let i = start; i < end; i++) {
      const c = src[i]
      dst[p++] = c
      if (c === CH_QUOTE && i + 1 < end && src[i + 1] === CH_QUOTE) i++
    }
  }
  b.len = p
}

function blobPushString(b: BlobBuilder, s: string, enc: TextEncoder): void {
  const n = s.length
  if (n === 0) return
  ensureBlob(b, n * 3)
  const bytes = b.bytes
  const base = b.len
  let p = base
  let ascii = true
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i)
    if (c > 127) {
      ascii = false
      break
    }
    bytes[p++] = c
  }
  if (ascii) {
    b.len = p
    return
  }
  const r = enc.encodeInto(s, bytes.subarray(base))
  b.len = base + r.written
}

function setValue(b: Builder, row: number, s: string, enc: TextEncoder): void {
  switch (b.tag) {
    case 0:
      b.values[row] = b.kind === 'date' ? parseDateAs(s, b.dateCode) : scanNumber(s) ? numValue : NaN
      break
    case 1: {
      const t = boolToken(s)
      if (t === 1 || t === 3) {
        b.values[row] = 1
        b.trueCount++
      } else if (t === 0 || t === 2) {
        b.values[row] = 0
        b.falseCount++
      } else b.values[row] = 2
      break
    }
    case 2: {
      let code = b.map.get(s)
      if (code === undefined) {
        code = b.dictionary.length
        b.dictionary.push(s)
        b.map.set(s, code)
      }
      b.codes[row] = code
      break
    }
    case 3:
      blobPushString(b, s, enc)
      b.offsets[row + 1] = b.len
      break
  }
}

function setNull(b: Builder, row: number): void {
  switch (b.tag) {
    case 0:
      b.values[row] = NaN
      break
    case 1:
      b.values[row] = 2
      break
    case 2:
      b.codes[row] = -1
      break
    case 3:
      b.nulls[row >> 3] |= 1 << (row & 7)
      b.offsets[row + 1] = b.len
      break
  }
}

function finishColumn(
  b: Builder,
  plan: ColPlan,
  st: ColStat,
  name: string,
  id: string,
  index: number,
): { column: ColumnData; meta: ColumnMeta } {
  let column: ColumnData
  let byteSize = 0
  let distinct = plan.distinct
  switch (b.tag) {
    case 0: {
      const q: QuantitativeColumn = { kind: b.kind, values: b.values }
      column = q
      byteSize = b.values.byteLength
      break
    }
    case 1: {
      const c: BoolColumn = { kind: 'bool', values: b.values }
      column = c
      byteSize = b.values.byteLength
      distinct = (b.trueCount > 0 ? 1 : 0) + (b.falseCount > 0 ? 1 : 0)
      break
    }
    case 2: {
      const c: DictColumn = { kind: 'string', encoding: 'dict', codes: b.codes, dictionary: b.dictionary }
      column = c
      let dictBytes = 0
      for (let i = 0; i < b.dictionary.length; i++) dictBytes += b.dictionary[i].length * 2 + 24
      byteSize = b.codes.byteLength + dictBytes
      distinct = b.dictionary.length
      break
    }
    default: {
      const bytes = b.bytes.slice(0, b.len)
      const c: BlobColumn = { kind: 'string', encoding: 'blob', bytes, offsets: b.offsets, nulls: b.nulls }
      column = c
      byteSize = bytes.byteLength + b.offsets.byteLength + b.nulls.byteLength
      break
    }
  }
  const meta: ColumnMeta = {
    id,
    name,
    index,
    kind: plan.kind,
    nullCount: st.nullCount,
    distinctCount: distinct,
    byteSize,
  }
  if (plan.kind === 'string') meta.encoding = plan.encoding
  if (plan.dateFormat !== undefined) meta.dateFormat = plan.dateFormat
  return { column, meta }
}

/* -------------------------------------------------------------- progress */

function sleep0(): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, 0)
  })
}

interface Pacer {
  lastEmit: number
  lastYield: number
}

/* ------------------------------------------------------- delimited parsing */

interface ScanResult {
  names: string[]
  stats: ColStat[]
  rowCount: number
  badRows: number
  dataStart: number
}

function isBlankRow(sc: FieldScanner, col: number): boolean {
  return col === 0 && sc.rowEnd && !sc.quoted && sc.end === sc.start
}

async function scanDelimited(
  bytes: Uint8Array,
  start: number,
  delim: number,
  header: boolean,
  maxRows: number,
  nullSet: Set<string> | undefined,
  onProgress: (p: Progress) => void,
): Promise<ScanResult> {
  const len = bytes.length
  const sc = new FieldScanner(bytes, delim)
  const dec = new FieldDecoder()
  const names: string[] = []
  sc.reset(start)

  let dataStart = start
  if (header) {
    while (sc.next()) {
      names.push(dec.decode(bytes, sc.start, sc.end, sc.escapes > 0))
      if (sc.rowEnd) break
    }
    dataStart = sc.pos
  } else {
    let c = 0
    while (sc.next()) {
      c++
      if (sc.rowEnd) break
    }
    for (let i = 0; i < c; i++) names.push('column_' + (i + 1))
  }

  const ncols = names.length
  const stats: ColStat[] = new Array(ncols)
  for (let i = 0; i < ncols; i++) stats[i] = newColStat()
  if (ncols === 0) return { names, stats, rowCount: 0, badRows: 0, dataStart }

  sc.reset(dataStart)
  let rowCount = 0
  let badRows = 0
  const pacer: Pacer = { lastEmit: 0, lastYield: Date.now() }
  onProgress({ phase: 'scanning', ratio: 0, bytes: 0, totalBytes: len, rows: 0 })

  for (;;) {
    if (sc.pos >= len) break
    if (maxRows > 0 && rowCount >= maxRows) break
    if ((rowCount & PROGRESS_MASK) === 0 && rowCount > 0) {
      const now = Date.now()
      if (now - pacer.lastEmit >= EMIT_MS) {
        pacer.lastEmit = now
        onProgress({ phase: 'scanning', ratio: sc.pos / len, bytes: sc.pos, totalBytes: len, rows: rowCount })
      }
      if (now - pacer.lastYield >= YIELD_MS) {
        pacer.lastYield = now
        await sleep0()
      }
    }

    let col = 0
    let blank = false
    while (sc.next()) {
      if (isBlankRow(sc, col)) {
        blank = true
        break
      }
      if (col < ncols) {
        const st = stats[col]
        const s = dec.decode(bytes, sc.start, sc.end, sc.escapes > 0)
        if (isNullToken(s, nullSet)) st.nullCount++
        else observe(st, s, sc.end - sc.start - sc.escapes)
      }
      col++
      if (sc.rowEnd) break
    }
    if (blank) {
      if (ncols > 1) continue
      stats[0].nullCount++
      rowCount++
      continue
    }
    if (col === 0) break
    if (col < ncols) {
      for (let k = col; k < ncols; k++) stats[k].nullCount++
      badRows++
    } else if (col > ncols) badRows++
    rowCount++
  }

  onProgress({ phase: 'scanning', ratio: 1, bytes: len, totalBytes: len, rows: rowCount })
  return { names, stats, rowCount, badRows, dataStart }
}

async function fillDelimited(
  bytes: Uint8Array,
  dataStart: number,
  delim: number,
  ncols: number,
  rowCount: number,
  maxRows: number,
  builders: Builder[],
  nullSet: Set<string> | undefined,
  nullMaxBytes: number,
  onProgress: (p: Progress) => void,
): Promise<void> {
  const len = bytes.length
  const sc = new FieldScanner(bytes, delim)
  const dec = new FieldDecoder()
  const enc = new TextEncoder()
  sc.reset(dataStart)
  let row = 0
  const pacer: Pacer = { lastEmit: 0, lastYield: Date.now() }
  onProgress({ phase: 'parsing', ratio: 0, bytes: 0, totalBytes: len, rows: 0 })

  for (;;) {
    if (sc.pos >= len || row >= rowCount) break
    if (maxRows > 0 && row >= maxRows) break
    if ((row & PROGRESS_MASK) === 0 && row > 0) {
      const now = Date.now()
      if (now - pacer.lastEmit >= EMIT_MS) {
        pacer.lastEmit = now
        onProgress({ phase: 'parsing', ratio: sc.pos / len, bytes: sc.pos, totalBytes: len, rows: row })
      }
      if (now - pacer.lastYield >= YIELD_MS) {
        pacer.lastYield = now
        await sleep0()
      }
    }

    let col = 0
    let blank = false
    while (sc.next()) {
      if (isBlankRow(sc, col)) {
        blank = true
        break
      }
      if (col < ncols) {
        const b = builders[col]
        if (b.tag === 3) {
          // Blob columns copy source bytes straight through: no string is made
          // unless the field is short enough to be a null token.
          const blen = sc.end - sc.start - sc.escapes
          let nul: boolean
          if (blen === 0) nul = true
          else if (blen <= nullMaxBytes) {
            nul = isNullToken(dec.decode(bytes, sc.start, sc.end, sc.escapes > 0), nullSet)
          } else {
            nul = true
            for (let i = sc.start; i < sc.end; i++) {
              if (bytes[i] > 32) {
                nul = false
                break
              }
            }
          }
          if (nul) setNull(b, row)
          else {
            blobPushBytes(b, bytes, sc.start, sc.end, sc.escapes > 0)
            b.offsets[row + 1] = b.len
          }
        } else {
          const s = dec.decode(bytes, sc.start, sc.end, sc.escapes > 0)
          if (isNullToken(s, nullSet)) setNull(b, row)
          else setValue(b, row, s, enc)
        }
      }
      col++
      if (sc.rowEnd) break
    }
    if (blank) {
      if (ncols > 1) continue
      setNull(builders[0], row)
      row++
      continue
    }
    if (col === 0) break
    for (let k = col; k < ncols; k++) setNull(builders[k], row)
    row++
  }

  for (; row < rowCount; row++) {
    for (let k = 0; k < ncols; k++) setNull(builders[k], row)
  }
  onProgress({ phase: 'parsing', ratio: 1, bytes: len, totalBytes: len, rows: rowCount })
}

/* ------------------------------------------------------------ JSON parsing */

const CH_LBRACE = 0x7b
const CH_RBRACE = 0x7d
const CH_LBRACKET = 0x5b
const CH_RBRACKET = 0x5d
const CH_BACKSLASH = 0x5c
const CH_DQUOTE = 0x22

/** End index (exclusive) of the JSON value starting at `i`, or -1 if unterminated. */
function jsonValueEnd(b: Uint8Array, i: number, len: number): number {
  const c = b[i]
  if (c === CH_DQUOTE) {
    i++
    while (i < len) {
      const d = b[i]
      if (d === CH_BACKSLASH) {
        i += 2
        continue
      }
      if (d === CH_DQUOTE) return i + 1
      i++
    }
    return -1
  }
  if (c === CH_LBRACE || c === CH_LBRACKET) {
    let depth = 0
    while (i < len) {
      const d = b[i]
      if (d === CH_DQUOTE) {
        i++
        while (i < len) {
          const e = b[i]
          if (e === CH_BACKSLASH) {
            i += 2
            continue
          }
          if (e === CH_DQUOTE) break
          i++
        }
        if (i >= len) return -1
        i++
        continue
      }
      if (d === CH_LBRACE || d === CH_LBRACKET) {
        depth++
        i++
        continue
      }
      if (d === CH_RBRACE || d === CH_RBRACKET) {
        depth--
        i++
        if (depth === 0) return i
        continue
      }
      i++
    }
    return -1
  }
  while (i < len) {
    const d = b[i]
    if (d === CH_COMMA || d === CH_RBRACKET || d === CH_RBRACE || d <= 32) return i
    i++
  }
  return len
}

/** Streams top-level records without ever parsing the whole document. */
class JsonRecords {
  private readonly b: Uint8Array
  private readonly len: number
  private readonly arrayMode: boolean
  private readonly first: number
  pos = 0
  start = 0
  end = 0

  constructor(b: Uint8Array, start: number, arrayMode: boolean) {
    this.b = b
    this.len = b.length
    this.arrayMode = arrayMode
    let i = start
    while (i < b.length && b[i] <= 32) i++
    if (arrayMode && i < b.length && b[i] === CH_LBRACKET) i++
    this.first = i
    this.pos = i
  }

  reset(): void {
    this.pos = this.first
  }

  next(): boolean {
    const b = this.b
    const len = this.len
    let i = this.pos
    while (i < len) {
      const c = b[i]
      if (c <= 32 || c === CH_COMMA) {
        i++
        continue
      }
      break
    }
    if (i >= len) {
      this.pos = len
      return false
    }
    if (this.arrayMode && b[i] === CH_RBRACKET) {
      this.pos = len
      return false
    }
    const e = jsonValueEnd(b, i, len)
    if (e < 0) {
      this.pos = len
      return false
    }
    this.start = i
    this.end = e
    this.pos = e
    return true
  }
}

function jsonValueToString(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const t = typeof v
  if (t === 'string') return v as string
  if (t === 'number') return Number.isFinite(v as number) ? String(v) : null
  if (t === 'boolean') return (v as boolean) ? 'true' : 'false'
  const j = JSON.stringify(v)
  return typeof j === 'string' ? j : null
}

/** Flattens one level with dot notation; deeper structure is stringified. */
function visitRecord(rec: unknown, visit: (key: string, value: string | null) => void): void {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
    visit('value', jsonValueToString(rec))
    return
  }
  const obj = rec as Record<string, unknown>
  for (const key in obj) {
    const v = obj[key]
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const sub = v as Record<string, unknown>
      for (const k2 in sub) visit(key + '.' + k2, jsonValueToString(sub[k2]))
    } else visit(key, jsonValueToString(v))
  }
}

interface JsonScanResult extends ScanResult {
  keyIndex: Map<string, number>
}

async function scanJson(
  bytes: Uint8Array,
  it: JsonRecords,
  maxRows: number,
  nullSet: Set<string> | undefined,
  onProgress: (p: Progress) => void,
): Promise<JsonScanResult> {
  const len = bytes.length
  const dec = new TextDecoder('utf-8')
  const keyIndex = new Map<string, number>()
  const names: string[] = []
  const stats: ColStat[] = []
  let seen = new Int32Array(64).fill(-1)
  let rowCount = 0
  let badRows = 0
  const pacer: Pacer = { lastEmit: 0, lastYield: Date.now() }
  onProgress({ phase: 'scanning', ratio: 0, bytes: 0, totalBytes: len, rows: 0 })

  const visit = (key: string, value: string | null): void => {
    let idx = keyIndex.get(key)
    if (idx === undefined) {
      idx = names.length
      keyIndex.set(key, idx)
      names.push(key)
      const st = newColStat()
      st.nullCount = rowCount
      stats.push(st)
      if (seen.length <= idx) {
        const grown = new Int32Array(idx * 2 + 8).fill(-1)
        grown.set(seen)
        seen = grown
      }
    }
    if (seen[idx] === rowCount) return
    seen[idx] = rowCount
    const st = stats[idx]
    if (value === null || isNullToken(value, nullSet)) st.nullCount++
    else observe(st, value, utf8Length(value))
  }

  while (it.next()) {
    if (maxRows > 0 && rowCount >= maxRows) break
    if ((rowCount & PROGRESS_MASK) === 0 && rowCount > 0) {
      const now = Date.now()
      if (now - pacer.lastEmit >= EMIT_MS) {
        pacer.lastEmit = now
        onProgress({ phase: 'scanning', ratio: it.pos / len, bytes: it.pos, totalBytes: len, rows: rowCount })
      }
      if (now - pacer.lastYield >= YIELD_MS) {
        pacer.lastYield = now
        await sleep0()
      }
    }
    let rec: unknown
    try {
      rec = JSON.parse(dec.decode(bytes.subarray(it.start, it.end)))
    } catch {
      badRows++
      continue
    }
    visitRecord(rec, visit)
    for (let c = 0; c < stats.length; c++) {
      if (seen[c] !== rowCount) {
        stats[c].nullCount++
        seen[c] = rowCount
      }
    }
    rowCount++
  }

  onProgress({ phase: 'scanning', ratio: 1, bytes: len, totalBytes: len, rows: rowCount })
  return { names, stats, rowCount, badRows, dataStart: 0, keyIndex }
}

async function fillJson(
  bytes: Uint8Array,
  it: JsonRecords,
  keyIndex: Map<string, number>,
  rowCount: number,
  maxRows: number,
  builders: Builder[],
  nullSet: Set<string> | undefined,
  onProgress: (p: Progress) => void,
): Promise<void> {
  const len = bytes.length
  const dec = new TextDecoder('utf-8')
  const enc = new TextEncoder()
  const ncols = builders.length
  const seen = new Int32Array(ncols).fill(-1)
  let row = 0
  const pacer: Pacer = { lastEmit: 0, lastYield: Date.now() }
  onProgress({ phase: 'parsing', ratio: 0, bytes: 0, totalBytes: len, rows: 0 })

  const visit = (key: string, value: string | null): void => {
    const idx = keyIndex.get(key)
    if (idx === undefined || idx >= ncols) return
    if (seen[idx] === row) return
    seen[idx] = row
    const b = builders[idx]
    if (value === null || isNullToken(value, nullSet)) setNull(b, row)
    else setValue(b, row, value, enc)
  }

  it.reset()
  while (it.next()) {
    if (row >= rowCount) break
    if (maxRows > 0 && row >= maxRows) break
    if ((row & PROGRESS_MASK) === 0 && row > 0) {
      const now = Date.now()
      if (now - pacer.lastEmit >= EMIT_MS) {
        pacer.lastEmit = now
        onProgress({ phase: 'parsing', ratio: it.pos / len, bytes: it.pos, totalBytes: len, rows: row })
      }
      if (now - pacer.lastYield >= YIELD_MS) {
        pacer.lastYield = now
        await sleep0()
      }
    }
    let rec: unknown
    try {
      rec = JSON.parse(dec.decode(bytes.subarray(it.start, it.end)))
    } catch {
      continue
    }
    visitRecord(rec, visit)
    for (let c = 0; c < ncols; c++) {
      if (seen[c] !== row) {
        setNull(builders[c], row)
        seen[c] = row
      }
    }
    row++
  }

  for (; row < rowCount; row++) {
    for (let c = 0; c < ncols; c++) setNull(builders[c], row)
  }
  onProgress({ phase: 'parsing', ratio: 1, bytes: len, totalBytes: len, rows: rowCount })
}

/* ------------------------------------------------------------- entry point */

type SourceFormat = 'delimited' | 'json-array' | 'json-stream'

function firstContentByte(bytes: Uint8Array, start: number): number {
  let i = start
  const n = bytes.length
  while (i < n && bytes[i] <= 32) i++
  return i < n ? bytes[i] : -1
}

function detectFormat(name: string, bytes: Uint8Array, start: number): SourceFormat {
  const lower = name.toLowerCase()
  const head = firstContentByte(bytes, start)
  if (lower.endsWith('.ndjson') || lower.endsWith('.jsonl')) return 'json-stream'
  if (lower.endsWith('.json')) {
    if (head === CH_LBRACKET) return 'json-array'
    if (head === CH_LBRACE) return 'json-stream'
    return 'delimited'
  }
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) return 'delimited'
  if (head === CH_LBRACKET) return 'json-array'
  if (head === CH_LBRACE) return 'json-stream'
  return 'delimited'
}

function buildNullSet(tokens?: string[]): { set: Set<string> | undefined; maxBytes: number } {
  let maxBytes = 4
  if (tokens === undefined || tokens.length === 0) return { set: undefined, maxBytes }
  const set = new Set<string>()
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    set.add(t)
    set.add(t.toLowerCase())
    set.add(t.toUpperCase())
    const b = utf8Length(t)
    if (b > maxBytes) maxBytes = b
  }
  return { set, maxBytes }
}

function assemble(
  scan: ScanResult,
  builders: Builder[],
  plans: ColPlan[],
  name: string,
  delimiter: string,
  sourceBytes: number,
  createdAt: number,
): ParsedDataset {
  const ids = makeColumnIds(scan.names)
  const columns: ColumnData[] = new Array(scan.names.length)
  const metas: ColumnMeta[] = new Array(scan.names.length)
  let byteSize = 0
  for (let i = 0; i < scan.names.length; i++) {
    const out = finishColumn(builders[i], plans[i], scan.stats[i], scan.names[i], ids[i], i)
    columns[i] = out.column
    metas[i] = out.meta
    byteSize += out.meta.byteSize
  }
  const meta: DatasetMeta = {
    id: 'ds_' + hash32(name + '|' + scan.rowCount + '|' + createdAt).toString(36),
    name,
    rowCount: scan.rowCount,
    byteSize,
    sourceBytes,
    createdAt,
    columns: metas,
    badRows: scan.badRows,
    delimiter,
  }
  return { meta, columns }
}

export async function parseBytes(
  bytes: Uint8Array,
  name: string,
  options: ParseOptions,
  onProgress: (p: Progress) => void,
): Promise<ParsedDataset> {
  const createdAt = Date.now()
  const sourceBytes = bytes.length
  const start =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  const maxRows = options.maxRows !== undefined && options.maxRows > 0 ? options.maxRows : 0
  const { set: nullSet, maxBytes: nullMaxBytes } = buildNullSet(options.nullTokens)
  const format = detectFormat(name, bytes, start)

  if (format !== 'delimited') {
    const it = new JsonRecords(bytes, start, format === 'json-array')
    const scan = await scanJson(bytes, it, maxRows, nullSet, onProgress)
    const plans: ColPlan[] = new Array(scan.names.length)
    const builders: Builder[] = new Array(scan.names.length)
    for (let i = 0; i < scan.names.length; i++) {
      plans[i] = finalizePlan(scan.stats[i], scan.names[i], scan.rowCount)
      builders[i] = createBuilder(plans[i], scan.stats[i], scan.rowCount)
    }
    await fillJson(bytes, it, scan.keyIndex, scan.rowCount, maxRows, builders, nullSet, onProgress)
    return assemble(scan, builders, plans, name, ',', sourceBytes, createdAt)
  }

  let delimiter: string
  if (options.delimiter !== undefined && options.delimiter.length > 0) delimiter = options.delimiter
  else if (name.toLowerCase().endsWith('.tsv')) delimiter = '\t'
  else {
    const sampleEnd = Math.min(bytes.length, start + 65536)
    const sample = new TextDecoder('utf-8').decode(bytes.subarray(start, sampleEnd))
    delimiter = sniffDelimiter(sample)
  }
  const delimByte = delimiter.charCodeAt(0)

  const scan = await scanDelimited(
    bytes,
    start,
    delimByte,
    options.header !== false,
    maxRows,
    nullSet,
    onProgress,
  )
  const plans: ColPlan[] = new Array(scan.names.length)
  const builders: Builder[] = new Array(scan.names.length)
  for (let i = 0; i < scan.names.length; i++) {
    plans[i] = finalizePlan(scan.stats[i], scan.names[i], scan.rowCount)
    builders[i] = createBuilder(plans[i], scan.stats[i], scan.rowCount)
  }
  await fillDelimited(
    bytes,
    scan.dataStart,
    delimByte,
    scan.names.length,
    scan.rowCount,
    maxRows,
    builders,
    nullSet,
    nullMaxBytes,
    onProgress,
  )
  return assemble(scan, builders, plans, name, delimiter, sourceBytes, createdAt)
}
