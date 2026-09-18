import { describe, expect, it } from 'vitest'
import { parseBytes } from './parse'

/**
 * Guards the headline claim: a million rows parse into columnar memory in a
 * few seconds, with the right types and the right string encoding chosen per
 * column. Generous bounds — this is a regression tripwire, not a benchmark.
 */
function makeCsv(rows: number): Uint8Array {
  const countries = ['US', 'DE', 'IN', 'BR', 'JP', 'FR', 'GB', 'CA']
  const cats = ['books', 'toys', 'tools', 'food', 'games']
  const parts: string[] = ['order_id,customer,country,category,qty,price,ordered_at,returned\n']
  let seed = 12345
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  for (let i = 0; i < rows; i++) {
    const day = new Date(Date.UTC(2024, 0, 1 + (i % 700))).toISOString().slice(0, 10)
    parts.push(
      `ord_${i.toString(36)},cust_${(i % 50000).toString(36)},${countries[i % 8]},` +
        `${cats[i % 5]},${1 + (i % 9)},${(rnd() * 500).toFixed(2)},${day},${i % 7 === 0 ? 'true' : 'false'}\n`,
    )
  }
  return new TextEncoder().encode(parts.join(''))
}

describe('parseBytes at scale', () => {
  it('parses 1,000,000 rows with correct types and encodings', async () => {
    const bytes = makeCsv(1_000_000)
    const started = performance.now()
    const parsed = await parseBytes(bytes, 'orders.csv', {}, () => {})
    const elapsed = performance.now() - started

    expect(parsed.meta.rowCount).toBe(1_000_000)
    expect(parsed.meta.badRows).toBe(0)

    const kind = Object.fromEntries(parsed.meta.columns.map((c) => [c.name, c.kind]))
    expect(kind.qty).toBe('int')
    expect(kind.price).toBe('float')
    expect(kind.ordered_at).toBe('date')
    expect(kind.returned).toBe('bool')

    const enc = Object.fromEntries(parsed.meta.columns.map((c) => [c.name, c.encoding]))
    expect(enc.order_id).toBe('blob') // every value unique
    expect(enc.country).toBe('dict') // eight distinct values
    expect(enc.customer).toBe('dict') // 50k distinct, still under the cap

    // Columnar memory must stay in the same ballpark as the source bytes,
    // not the order of magnitude a million JS objects would cost.
    expect(parsed.meta.byteSize).toBeLessThan(bytes.length * 2)
    expect(elapsed).toBeLessThan(30_000)
  }, 180_000)
})
