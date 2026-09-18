import { describe, expect, it } from 'vitest'
import type { ColumnData } from '@/lib/types'
import type { Progress } from '@/lib/engine/protocol'
import {
  inferKind,
  isNullToken,
  parseBytes,
  parseDateValue,
  parseNumberValue,
  sniffDelimiter,
  type ParsedDataset,
} from '@/lib/engine/parse'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function bytes(s: string): Uint8Array {
  return ENC.encode(s)
}

function noop(): void {}

async function parse(src: string | Uint8Array, name = 'f.csv', options = {}): Promise<ParsedDataset> {
  return parseBytes(typeof src === 'string' ? bytes(src) : src, name, options, noop)
}

function readString(col: ColumnData, row: number): string | null {
  if (col.kind !== 'string') throw new Error('column is ' + col.kind)
  if (col.encoding === 'dict') {
    const code = col.codes[row]
    return code < 0 ? null : col.dictionary[code]
  }
  if (((col.nulls[row >> 3] >> (row & 7)) & 1) === 1) return null
  return DEC.decode(col.bytes.subarray(col.offsets[row], col.offsets[row + 1]))
}

function num(col: ColumnData, row: number): number {
  if (col.kind === 'int' || col.kind === 'float' || col.kind === 'date') return col.values[row]
  throw new Error('column is ' + col.kind)
}

function kinds(ds: ParsedDataset): string[] {
  return ds.meta.columns.map((c) => c.kind)
}

describe('isNullToken', () => {
  it('accepts the conventional sentinels case-insensitively', () => {
    for (const t of ['', '  ', 'null', 'NULL', 'NuLl', 'nil', 'na', 'NA', 'n/a', 'N/A', 'nan', 'NaN', 'none', 'NONE', '-']) {
      expect(isNullToken(t), t).toBe(true)
    }
  })

  it('rejects real values', () => {
    for (const t of ['0', 'no', 'n', 'nap', 'nulls', 'none ', '--', 'a']) {
      expect(isNullToken(t), t).toBe(false)
    }
  })

  it('honours extra tokens', () => {
    const extra = new Set(['MISSING'])
    expect(isNullToken('MISSING', extra)).toBe(true)
    expect(isNullToken('MISSING')).toBe(false)
  })
})

describe('parseNumberValue', () => {
  it('parses plain, signed, decimal and scientific forms', () => {
    expect(parseNumberValue('42')).toBe(42)
    expect(parseNumberValue('-42')).toBe(-42)
    expect(parseNumberValue('+7')).toBe(7)
    expect(parseNumberValue('3.5')).toBe(3.5)
    expect(parseNumberValue('-0.25')).toBe(-0.25)
    expect(parseNumberValue('1e3')).toBe(1000)
    expect(parseNumberValue('2.5E-2')).toBe(0.025)
    expect(parseNumberValue(' 12 ')).toBe(12)
  })

  it('parses thousands separators, currency and percent', () => {
    expect(parseNumberValue('1,234')).toBe(1234)
    expect(parseNumberValue('1,234,567.5')).toBe(1234567.5)
    expect(parseNumberValue('$1,234.50')).toBe(1234.5)
    expect(parseNumberValue('-$5')).toBe(-5)
    expect(parseNumberValue('45%')).toBe(45)
  })

  it('rejects non-numbers and malformed groupings', () => {
    for (const t of ['', ' ', 'abc', '1 2', '1,23', '12,34', '1,', '.', '1e', '0x10', '--1', 'Infinity']) {
      expect(Number.isNaN(parseNumberValue(t)), t).toBe(true)
    }
  })
})

describe('parseDateValue', () => {
  it('parses ISO dates and date-times', () => {
    expect(parseDateValue('2020-01-15')).toBe(Date.UTC(2020, 0, 15))
    expect(parseDateValue('2020-01-15T10:30:00')).toBe(Date.UTC(2020, 0, 15, 10, 30, 0))
    expect(parseDateValue('2020-01-15T10:30:00Z')).toBe(Date.UTC(2020, 0, 15, 10, 30, 0))
    expect(parseDateValue('2020-01-15T10:30:00.250Z')).toBe(Date.UTC(2020, 0, 15, 10, 30, 0, 250))
    expect(parseDateValue('2020-01-15T10:30:00+02:00')).toBe(Date.UTC(2020, 0, 15, 8, 30, 0))
    expect(parseDateValue('2020-01-15T10:30:00-0500')).toBe(Date.UTC(2020, 0, 15, 15, 30, 0))
    expect(parseDateValue('2020-01-15 10:30')).toBe(Date.UTC(2020, 0, 15, 10, 30))
    expect(parseDateValue('2020/03/04')).toBe(Date.UTC(2020, 2, 4))
  })

  it('defaults an ambiguous slash date to MM/DD and switches when the day proves it', () => {
    expect(parseDateValue('01/02/2020')).toBe(Date.UTC(2020, 0, 2))
    expect(parseDateValue('25/12/2020')).toBe(Date.UTC(2020, 11, 25))
  })

  it('rejects impossible and non-date strings', () => {
    for (const t of ['2021-02-30', '2020-13-01', 'hello', '2020', '20200101', '2020-01-15T25:00:00', '']) {
      expect(Number.isNaN(parseDateValue(t)), t).toBe(true)
    }
    expect(parseDateValue('2020-02-29')).toBe(Date.UTC(2020, 1, 29))
  })
})

describe('inferKind', () => {
  it('follows bool -> int -> float -> date -> string precedence', () => {
    expect(inferKind(['true', 'false', 'TRUE'])).toBe('bool')
    expect(inferKind(['yes', 'no'])).toBe('bool')
    expect(inferKind(['0', '1', '1'])).toBe('int')
    expect(inferKind(['1', '2', '-3'])).toBe('int')
    expect(inferKind(['1', '2.5'])).toBe('float')
    expect(inferKind(['2020-01-01', '2021-06-30'])).toBe('date')
    expect(inferKind(['a', 'b'])).toBe('string')
    expect(inferKind(['', '', ''])).toBe('string')
    expect(inferKind([])).toBe('string')
    expect(inferKind(['1', 'abc'])).toBe('string')
  })

  it('rejects inconsistent currency/percent columns', () => {
    expect(inferKind(['$1.50', '$2.50'])).toBe('float')
    expect(inferKind(['$1.50', '2.50'])).toBe('string')
    expect(inferKind(['10%', '20%'])).toBe('float')
    expect(inferKind(['1,234', '5,678'])).toBe('int')
    expect(inferKind(['1,234', '5678'])).toBe('string')
    expect(inferKind(['1,234', '567'])).toBe('int')
  })
})

describe('sniffDelimiter', () => {
  it('scores on field-count consistency, not frequency', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3\n4,5,6')).toBe(',')
    expect(sniffDelimiter('a;b;c\n1;2;3\n4;5;6')).toBe(';')
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t')
    expect(sniffDelimiter('a|b|c\n1|2|3')).toBe('|')
  })

  it('ignores delimiters inside quotes', () => {
    expect(sniffDelimiter('a|b\n"x|y|z|w|v"|q\n"p|q|r|s|t"|r')).toBe('|')
    expect(sniffDelimiter('a;b\n"1,2,3,4";x\n"5,6,7,8";y')).toBe(';')
  })
})

describe('delimited parsing', () => {
  it('handles quoted fields with delimiters, newlines and "" escapes', async () => {
    const ds = await parse('a,b\n"x,y","line1\nline2"\n"he said ""hi""",z\n')
    expect(ds.meta.rowCount).toBe(2)
    expect(ds.meta.badRows).toBe(0)
    expect(readString(ds.columns[0], 0)).toBe('x,y')
    expect(readString(ds.columns[1], 0)).toBe('line1\nline2')
    expect(readString(ds.columns[0], 1)).toBe('he said "hi"')
    expect(readString(ds.columns[1], 1)).toBe('z')
  })

  it('strips a UTF-8 BOM and accepts CRLF, LF and lone CR', async () => {
    const src = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('a,b\r\n1,2\r\n3,4\n5,6\r7,8')])
    const ds = await parse(src)
    expect(ds.meta.columns[0].name).toBe('a')
    expect(ds.meta.rowCount).toBe(4)
    expect(num(ds.columns[0], 0)).toBe(1)
    expect(num(ds.columns[1], 3)).toBe(8)
  })

  it('decodes multi-byte UTF-8 and long fields', async () => {
    const long = 'é'.repeat(200)
    const ds = await parse(`a,b\ncafé,${long}\nnaïve,x\n`)
    expect(readString(ds.columns[0], 0)).toBe('café')
    expect(readString(ds.columns[1], 0)).toBe(long)
    expect(readString(ds.columns[0], 1)).toBe('naïve')
  })

  it('pads short rows, drops overflow and counts both as badRows', async () => {
    const ds = await parse('a,b,c\n1,2,3\n4,5\n6,7,8,9\n')
    expect(ds.meta.rowCount).toBe(3)
    expect(ds.meta.badRows).toBe(2)
    expect(num(ds.columns[2], 0)).toBe(3)
    expect(Number.isNaN(num(ds.columns[2], 1))).toBe(true)
    expect(num(ds.columns[2], 2)).toBe(8)
    expect(ds.meta.columns[2].nullCount).toBe(1)
  })

  it('skips blank lines and a trailing newline', async () => {
    const ds = await parse('a,b\n1,2\n\n3,4\n\n')
    expect(ds.meta.rowCount).toBe(2)
    expect(ds.meta.badRows).toBe(0)
  })

  it('honours an explicit delimiter, header:false and maxRows', async () => {
    const ds = await parse('1;2;3\n4;5;6\n7;8;9\n', 'x.txt', {
      delimiter: ';',
      header: false,
      maxRows: 2,
    })
    expect(ds.meta.delimiter).toBe(';')
    expect(ds.meta.columns.map((c) => c.name)).toEqual(['column_1', 'column_2', 'column_3'])
    expect(ds.meta.rowCount).toBe(2)
    expect(num(ds.columns[0], 1)).toBe(4)
  })

  it('reports scanning then parsing progress', async () => {
    const seen: Progress[] = []
    await parseBytes(bytes('a,b\n1,2\n'), 'p.csv', {}, (p) => seen.push(p))
    expect(seen.some((p) => p.phase === 'scanning')).toBe(true)
    expect(seen.some((p) => p.phase === 'parsing')).toBe(true)
    const last = seen[seen.length - 1]
    expect(last.phase).toBe('parsing')
    expect(last.ratio).toBe(1)
    expect(last.totalBytes).toBe(8)
  })
})

describe('type inference over whole columns', () => {
  it('infers every kind and keeps a neutral 0/1 column as int', async () => {
    const ds = await parse(
      [
        'id,score,active,when,label,pct,n,is_active',
        '1,3.5,true,2020-01-15,alpha,10%,0,0',
        '2,4.25,false,2020-02-20,beta,20%,1,1',
        '3,5,yes,2020-03-25,gamma,30%,0,1',
      ].join('\n'),
    )
    expect(kinds(ds)).toEqual(['int', 'float', 'bool', 'date', 'string', 'float', 'int', 'bool'])
    expect(num(ds.columns[5], 0)).toBe(10)
    expect(num(ds.columns[3], 0)).toBe(Date.UTC(2020, 0, 15))
    expect(ds.meta.columns[3].dateFormat).toBe('ISO-8601')
    const flag = ds.columns[7]
    if (flag.kind !== 'bool') throw new Error('expected bool')
    expect(Array.from(flag.values)).toEqual([0, 1, 1])
    expect(ds.meta.columns[7].distinctCount).toBe(2)
  })

  it('falls back to string when one value breaks the column', async () => {
    const ds = await parse('a\n1\n2\noops\n4\n')
    expect(kinds(ds)).toEqual(['string'])
    expect(readString(ds.columns[0], 2)).toBe('oops')
  })

  it('treats big integers beyond MAX_SAFE_INTEGER as float', async () => {
    const ds = await parse('a\n9007199254740993\n12\n')
    expect(kinds(ds)).toEqual(['float'])
  })

  it('reads epoch integers as dates only when the header says so', async () => {
    const ds = await parse('created_at,count\n1700000000,1700000000\n1700000060,5\n')
    expect(kinds(ds)).toEqual(['date', 'int'])
    expect(num(ds.columns[0], 0)).toBe(1700000000000)
    expect(ds.meta.columns[0].dateFormat).toBe('epoch-s')
  })

  it('disambiguates DD/MM from MM/DD by scanning for a day above 12', async () => {
    const dmy = await parse('d\n25/12/2020\n01/02/2020\n')
    expect(dmy.meta.columns[0].dateFormat).toBe('DD/MM/YYYY')
    expect(num(dmy.columns[0], 0)).toBe(Date.UTC(2020, 11, 25))
    expect(num(dmy.columns[0], 1)).toBe(Date.UTC(2020, 1, 1))

    const mdy = await parse('d\n12/25/2020\n01/02/2020\n')
    expect(mdy.meta.columns[0].dateFormat).toBe('MM/DD/YYYY')
    expect(num(mdy.columns[0], 0)).toBe(Date.UTC(2020, 11, 25))
    expect(num(mdy.columns[0], 1)).toBe(Date.UTC(2020, 0, 2))

    const ambiguous = await parse('d\n01/02/2020\n03/04/2020\n')
    expect(ambiguous.meta.columns[0].dateFormat).toBe('MM/DD/YYYY')
    expect(num(ambiguous.columns[0], 0)).toBe(Date.UTC(2020, 0, 2))
  })

  it('applies built-in and caller-supplied null tokens', async () => {
    const ds = await parse('a,b,c\n1,x,MISSING\n,NA,keep\nn/a,-,MISSING\n', 'n.csv', {
      nullTokens: ['MISSING'],
    })
    expect(ds.meta.columns[0].nullCount).toBe(2)
    expect(ds.meta.columns[1].nullCount).toBe(2)
    expect(ds.meta.columns[2].nullCount).toBe(2)
    expect(readString(ds.columns[2], 1)).toBe('keep')
    expect(readString(ds.columns[1], 1)).toBe(null)
  })

  it('keeps an all-null column as string', async () => {
    const ds = await parse('a,b\n,1\nNA,2\n')
    expect(kinds(ds)).toEqual(['string', 'int'])
    expect(ds.meta.columns[0].nullCount).toBe(2)
    expect(ds.meta.columns[0].distinctCount).toBe(0)
  })
})

describe('string encoding', () => {
  it('dictionary-encodes at the cardinality threshold and blob-encodes past it', async () => {
    const dictRows = Array.from({ length: 10 }, (_, i) => 'v' + (i % 5))
    const dict = await parse('s\n' + dictRows.join('\n') + '\n')
    expect(dict.meta.columns[0].encoding).toBe('dict')
    expect(dict.meta.columns[0].distinctCount).toBe(5)
    const dictCol = dict.columns[0]
    if (dictCol.kind !== 'string' || dictCol.encoding !== 'dict') throw new Error('expected dict')
    expect(dictCol.dictionary).toEqual(['v0', 'v1', 'v2', 'v3', 'v4'])
    expect(readString(dictCol, 7)).toBe('v2')

    const blobRows = Array.from({ length: 10 }, (_, i) => 'v' + (i % 6))
    const blob = await parse('s\n' + blobRows.join('\n') + '\n')
    expect(blob.meta.columns[0].encoding).toBe('blob')
  })

  it('writes monotonic blob offsets with a correct final offset', async () => {
    const values = ['alpha', '', 'beta', 'gamma-long-value', 'NA', 'delta', 'eps', 'zeta', 'eta', 'theta']
    const ds = await parse('s\n' + values.join('\n') + '\n')
    const col = ds.columns[0]
    if (col.kind !== 'string' || col.encoding !== 'blob') throw new Error('expected blob')
    expect(col.offsets.length).toBe(ds.meta.rowCount + 1)
    for (let i = 0; i < col.offsets.length - 1; i++) {
      expect(col.offsets[i + 1]).toBeGreaterThanOrEqual(col.offsets[i])
    }
    expect(col.offsets[0]).toBe(0)
    expect(col.offsets[col.offsets.length - 1]).toBe(col.bytes.length)
    expect(col.nulls.length).toBe(Math.ceil(ds.meta.rowCount / 8))
    expect(readString(col, 0)).toBe('alpha')
    expect(readString(col, 1)).toBe(null)
    expect(readString(col, 3)).toBe('gamma-long-value')
    expect(readString(col, 4)).toBe(null)
    expect(readString(col, 9)).toBe('theta')
    expect(ds.meta.columns[0].nullCount).toBe(2)
  })
})

describe('metadata', () => {
  it('slugifies headers, resolves collisions and names blank headers', async () => {
    const ds = await parse('First Name,First-Name,,Ünïcödé\n1,2,3,4\n')
    expect(ds.meta.columns.map((c) => c.id)).toEqual(['first_name', 'first_name_2', 'column_3', 'ünïcödé'])
    expect(ds.meta.columns[2].name).toBe('')
    expect(ds.meta.columns.map((c) => c.index)).toEqual([0, 1, 2, 3])
  })

  it('reports a stable id, source size and per-column byte sizes', async () => {
    const src = 'a,b\n1,hello\n2,world\n'
    const ds = await parse(src)
    expect(ds.meta.id).toMatch(/^ds_[0-9a-z]+$/)
    expect(ds.meta.name).toBe('f.csv')
    expect(ds.meta.sourceBytes).toBe(bytes(src).length)
    expect(ds.meta.delimiter).toBe(',')
    expect(ds.meta.columns[0].byteSize).toBe(2 * 8)
    expect(ds.meta.byteSize).toBe(ds.meta.columns.reduce((a, c) => a + c.byteSize, 0))
    expect(ds.meta.createdAt).toBeGreaterThan(0)
  })
})

describe('JSON input', () => {
  it('parses a JSON array of objects', async () => {
    const ds = await parse('[{"a":1,"b":"x"},{"a":2,"b":"y"},{"a":3,"b":"z"}]', 'data.json')
    expect(ds.meta.rowCount).toBe(3)
    expect(ds.meta.columns.map((c) => c.name)).toEqual(['a', 'b'])
    expect(kinds(ds)).toEqual(['int', 'string'])
    expect(num(ds.columns[0], 2)).toBe(3)
    expect(readString(ds.columns[1], 1)).toBe('y')
  })

  it('parses NDJSON and unions keys in first-seen order', async () => {
    const ds = await parse(
      '{"a":1,"b":true}\n{"b":false,"c":"new"}\n{"a":3}\n',
      'data.ndjson',
    )
    expect(ds.meta.rowCount).toBe(3)
    expect(ds.meta.columns.map((c) => c.name)).toEqual(['a', 'b', 'c'])
    expect(kinds(ds)).toEqual(['int', 'bool', 'string'])
    expect(Number.isNaN(num(ds.columns[0], 1))).toBe(true)
    expect(ds.meta.columns[2].nullCount).toBe(2)
    expect(readString(ds.columns[2], 1)).toBe('new')
  })

  it('flattens one level and stringifies arrays and deeper objects', async () => {
    const ds = await parse(
      '[{"user":{"id":7,"name":"ana"},"tags":[1,2],"deep":{"x":{"y":1}}},' +
        '{"user":{"id":8,"name":"bo"},"tags":[],"deep":{"x":{"y":2}}}]',
      'nested.json',
    )
    expect(ds.meta.columns.map((c) => c.name)).toEqual(['user.id', 'user.name', 'tags', 'deep.x'])
    expect(kinds(ds)).toEqual(['int', 'string', 'string', 'string'])
    expect(num(ds.columns[0], 1)).toBe(8)
    expect(readString(ds.columns[1], 0)).toBe('ana')
    expect(readString(ds.columns[2], 0)).toBe('[1,2]')
    expect(readString(ds.columns[3], 1)).toBe('{"y":2}')
  })

  it('falls back to delimited when a .json file is not JSON', async () => {
    const ds = await parse('a,b\n1,2\n', 'mislabelled.json')
    expect(ds.meta.rowCount).toBe(1)
    expect(ds.meta.columns.map((c) => c.name)).toEqual(['a', 'b'])
  })

  it('blob-encodes a high-cardinality JSON column and grows the byte buffer', async () => {
    const recs = Array.from({ length: 40 }, (_, i) => JSON.stringify({ k: 'uniqué-value-' + i }))
    const ds = await parse('[' + recs.join(',') + ']', 'wide.json')
    expect(ds.meta.columns[0].encoding).toBe('blob')
    const col = ds.columns[0]
    if (col.kind !== 'string' || col.encoding !== 'blob') throw new Error('expected blob')
    expect(col.offsets[40]).toBe(col.bytes.length)
    for (let i = 0; i < 40; i++) expect(readString(col, i)).toBe('uniqué-value-' + i)
  })

  it('caps JSON rows with maxRows', async () => {
    const ds = await parse('{"a":1}\n{"a":2}\n{"a":3}\n', 'm.ndjson', { maxRows: 2 })
    expect(ds.meta.rowCount).toBe(2)
    expect(num(ds.columns[0], 1)).toBe(2)
  })

  it('counts unparseable records as badRows', async () => {
    const ds = await parse('{"a":1}\n{"a":}\n{"a":3}\n', 'bad.jsonl')
    expect(ds.meta.rowCount).toBe(2)
    expect(ds.meta.badRows).toBe(1)
  })
})

describe('degenerate input', () => {
  it('accepts an empty file', async () => {
    const ds = await parse(new Uint8Array(0), 'empty.csv')
    expect(ds.meta.rowCount).toBe(0)
    expect(ds.meta.columns).toEqual([])
    expect(ds.columns).toEqual([])
  })

  it('accepts a header-only file', async () => {
    const ds = await parse('a,b,c')
    expect(ds.meta.rowCount).toBe(0)
    expect(ds.meta.columns.map((c) => c.name)).toEqual(['a', 'b', 'c'])
    expect(kinds(ds)).toEqual(['string', 'string', 'string'])
    const col = ds.columns[0]
    if (col.kind !== 'string' || col.encoding !== 'dict') throw new Error('expected dict')
    expect(col.codes.length).toBe(0)
    expect(col.dictionary).toEqual([])
  })

  it('accepts an empty JSON array', async () => {
    const ds = await parse('[]', 'empty.json')
    expect(ds.meta.rowCount).toBe(0)
    expect(ds.meta.columns).toEqual([])
  })
})

describe('scale', () => {
  it('parses a 200k-row CSV to the right rowCount and kinds', async () => {
    const rows = 200_000
    const parts: string[] = new Array(rows + 1)
    parts[0] = 'id,name,value,flag,ts'
    for (let i = 0; i < rows; i++) {
      const day = (i % 28) + 1
      parts[i + 1] =
        i +
        ',name_' +
        (i % 1000) +
        ',' +
        (i % 97) +
        '.5,' +
        (i % 2 === 0 ? 'true' : 'false') +
        ',2021-03-' +
        (day < 10 ? '0' + day : day)
    }
    const ds = await parse(parts.join('\n') + '\n', 'big.csv')
    expect(ds.meta.rowCount).toBe(rows)
    expect(kinds(ds)).toEqual(['int', 'string', 'float', 'bool', 'date'])
    expect(ds.meta.badRows).toBe(0)
    expect(ds.meta.columns[1].encoding).toBe('dict')
    expect(ds.meta.columns[1].distinctCount).toBe(1000)
    expect(num(ds.columns[0], rows - 1)).toBe(rows - 1)
    expect(readString(ds.columns[1], 12345)).toBe('name_345')
    expect(num(ds.columns[2], 3)).toBe(3.5)
    expect(num(ds.columns[4], 0)).toBe(Date.UTC(2021, 2, 1))
    const flag = ds.columns[3]
    if (flag.kind !== 'bool') throw new Error('expected bool')
    expect(flag.values[0]).toBe(1)
    expect(flag.values[1]).toBe(0)
  }, 120_000)
})
