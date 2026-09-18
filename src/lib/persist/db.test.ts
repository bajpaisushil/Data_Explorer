/**
 * Tests for the IndexedDB persistence layer.
 *
 * IndexedDB does not exist in Node, so this file builds a minimal fake that
 * implements exactly the surface `db.ts` touches, and installs it on
 * `globalThis` before the module under test is imported. The fake is
 * deliberately asynchronous — every request settles on a later macrotask, one
 * at a time, the way a browser would drive it — so the promise plumbing in
 * `db.ts` (request promisification, transaction commit, sequential per-column
 * writes) is genuinely exercised rather than short-circuited.
 *
 * Values are stored through `structuredClone`, so anything unserialisable, or
 * any accidental sharing of a live TypedArray between the caller and storage,
 * shows up as a failure here instead of in a browser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BlobColumn,
  ColumnData,
  ColumnKind,
  ColumnMeta,
  DatasetMeta,
  SavedView,
  StringEncoding,
} from '@/lib/types'

/* ===================================================================== *
 * Fake IndexedDB
 * ===================================================================== */

type Key = string | number | (string | number)[]
type Rec = { key: Key; value: any }

/** Stable map key for a primary key, including composite array keys. */
function encodeKey(key: Key): string {
  return JSON.stringify(Array.isArray(key) ? ['arr', ...key] : ['one', key])
}

/** Enough of the IDB key ordering to give `getAll` a deterministic, key-sorted result. */
function compareKeys(a: Key, b: Key): number {
  if (Array.isArray(a) !== Array.isArray(b)) return Array.isArray(a) ? 1 : -1
  const aa = Array.isArray(a) ? a : [a]
  const bb = Array.isArray(b) ? b : [b]
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    const x = aa[i]
    const y = bb[i]
    if (typeof x !== typeof y) return typeof x === 'number' ? -1 : 1
    if (x < y) return -1
    if (x > y) return 1
  }
  return aa.length - bb.length
}

function dataError(message: string): DOMException {
  return new DOMException(message, 'DataError')
}

/** Extract a record's primary key from a keyPath, including a composite one. */
function keyOf(keyPath: string | string[], value: any): Key {
  if (Array.isArray(keyPath)) {
    return keyPath.map((path) => {
      const part = value?.[path]
      if (part === undefined || part === null) throw dataError(`no value at key path "${path}"`)
      return part
    })
  }
  const part = value?.[keyPath]
  if (part === undefined || part === null) throw dataError(`no value at key path "${keyPath}"`)
  return part
}

interface IndexDef {
  name: string
  keyPath: string
  unique: boolean
}

interface StoreData {
  name: string
  keyPath: string | string[]
  indexes: Map<string, IndexDef>
  records: Map<string, Rec>
}

interface FakeRange {
  __only: Key
  includes(key: Key): boolean
}

const FakeKeyRange = {
  only(value: Key): FakeRange {
    return { __only: value, includes: (key: Key) => compareKeys(key, value) === 0 }
  },
}

/**
 * The durable side of the fake: survives `db.close()` and reopening, exactly
 * like the real thing, so "does the data survive a reconnect" is testable.
 */
class FakeBackend {
  version = 0
  stores = new Map<string, StoreData>()
  /** How many times `indexedDB.open` actually handed out a connection. */
  openCount = 0
  connections: FakeDatabase[] = []
  /** Test hook: return a DOMException to make a write fail and abort its transaction. */
  writeHook: ((store: string, op: 'put' | 'delete' | 'clear', value: unknown) => DOMException | null) | null = null
  /** Test hook: make `indexedDB.open` fail. */
  openError: DOMException | null = null
  /** Test hook: another connection is holding the old version open. */
  blocked = false

  store(name: string): StoreData {
    const store = this.stores.get(name)
    if (!store) throw new DOMException(`no object store "${name}"`, 'NotFoundError')
    return store
  }

  /** Every stored value in a store, in primary-key order. */
  values(name: string): any[] {
    return [...this.store(name).records.values()]
      .sort((a, b) => compareKeys(a.key, b.key))
      .map((r) => structuredClone(r.value))
  }

  count(name: string): number {
    return this.store(name).records.size
  }
}

class FakeRequest<T = any> {
  result!: T
  error: DOMException | null = null
  source: unknown = null
  transaction: FakeTransaction | null = null
  onsuccess: ((ev: { target: FakeRequest<T> }) => void) | null = null
  onerror: ((ev: { target: FakeRequest<T>; preventDefault(): void }) => void) | null = null
  onupgradeneeded: ((ev: { target: FakeRequest<T>; oldVersion: number; newVersion: number }) => void) | null = null
  onblocked: (() => void) | null = null
}

class FakeTransaction {
  error: DOMException | null = null
  oncomplete: (() => void) | null = null
  onabort: (() => void) | null = null
  onerror: (() => void) | null = null
  finished = false

  private queue: (() => void)[] = []
  private scheduled = false
  /** Pre-write snapshots, so an abort rolls the transaction back. */
  private snapshots = new Map<string, Map<string, Rec>>()

  constructor(
    readonly db: FakeDatabase,
    readonly storeNames: string[],
    readonly mode: string,
  ) {
    // An empty transaction still completes; schedule the drain up front.
    this.schedule()
  }

  objectStore(name: string): FakeObjectStore {
    if (!this.storeNames.includes(name)) {
      throw new DOMException(`store "${name}" is not in this transaction`, 'NotFoundError')
    }
    return new FakeObjectStore(this, this.db.backend.store(name))
  }

  /** Remember a store's contents before this transaction's first write to it. */
  snapshot(store: StoreData): void {
    if (!this.snapshots.has(store.name)) this.snapshots.set(store.name, new Map(store.records))
  }

  request<T>(source: unknown, op: () => T): FakeRequest<T> {
    const req = new FakeRequest<T>()
    req.source = source
    req.transaction = this
    this.enqueue(() => {
      let value: T
      try {
        value = op()
      } catch (err) {
        this.fail(req, err as DOMException)
        return
      }
      req.result = value
      req.onsuccess?.({ target: req })
    })
    return req
  }

  enqueue(task: () => void): void {
    if (this.finished) throw new DOMException('transaction is not active', 'TransactionInactiveError')
    this.queue.push(task)
    this.schedule()
  }

  private schedule(): void {
    if (this.scheduled || this.finished) return
    this.scheduled = true
    setTimeout(() => {
      this.scheduled = false
      this.drain()
    }, 0)
  }

  /** One queued request per turn of the loop, like a real event loop would. */
  private drain(): void {
    if (this.finished) return
    const task = this.queue.shift()
    if (!task) {
      this.finished = true
      this.oncomplete?.()
      return
    }
    try {
      task()
    } catch (err) {
      this.abort(err as DOMException)
      return
    }
    this.schedule()
  }

  private fail(req: FakeRequest<any>, err: DOMException): void {
    req.error = err
    let prevented = false
    req.onerror?.({ target: req, preventDefault: () => (prevented = true) })
    // An unhandled request error aborts the transaction, as in a real browser.
    if (!prevented) this.abort(err)
  }

  private abort(err: DOMException): void {
    if (this.finished) return
    this.finished = true
    this.queue.length = 0
    for (const [name, records] of this.snapshots) {
      const store = this.db.backend.stores.get(name)
      if (store) store.records = records
    }
    this.error = err
    this.onabort?.()
  }
}

class FakeObjectStore {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly data: StoreData,
  ) {}

  get name(): string {
    return this.data.name
  }

  put(value: any): FakeRequest<Key> {
    if (this.tx.mode === 'readonly') throw new DOMException('read-only transaction', 'ReadOnlyError')
    // Real IDB clones (and throws DataCloneError) synchronously, at call time.
    const stored = structuredClone(value)
    const key = keyOf(this.data.keyPath, stored)
    return this.tx.request(this, () => {
      const injected = this.tx.db.backend.writeHook?.(this.data.name, 'put', value)
      if (injected) throw injected
      this.tx.snapshot(this.data)
      this.data.records.set(encodeKey(key), { key, value: stored })
      return key
    })
  }

  get(key: Key): FakeRequest<any> {
    return this.tx.request(this, () => {
      const rec = this.data.records.get(encodeKey(key))
      return rec ? structuredClone(rec.value) : undefined
    })
  }

  getAll(): FakeRequest<any[]> {
    return this.tx.request(this, () =>
      [...this.data.records.values()].sort((a, b) => compareKeys(a.key, b.key)).map((r) => structuredClone(r.value)),
    )
  }

  delete(key: Key): FakeRequest<undefined> {
    if (this.tx.mode === 'readonly') throw new DOMException('read-only transaction', 'ReadOnlyError')
    return this.tx.request(this, () => {
      const injected = this.tx.db.backend.writeHook?.(this.data.name, 'delete', key)
      if (injected) throw injected
      this.tx.snapshot(this.data)
      this.data.records.delete(encodeKey(key))
      return undefined
    })
  }

  clear(): FakeRequest<undefined> {
    if (this.tx.mode === 'readonly') throw new DOMException('read-only transaction', 'ReadOnlyError')
    return this.tx.request(this, () => {
      const injected = this.tx.db.backend.writeHook?.(this.data.name, 'clear', null)
      if (injected) throw injected
      this.tx.snapshot(this.data)
      this.data.records.clear()
      return undefined
    })
  }

  index(name: string): FakeIndex {
    const def = this.data.indexes.get(name)
    if (!def) throw new DOMException(`no index "${name}"`, 'NotFoundError')
    return new FakeIndex(this.tx, this.data, def, this)
  }

  createIndex(name: string, keyPath: string, options?: { unique?: boolean }): void {
    this.data.indexes.set(name, { name, keyPath, unique: options?.unique ?? false })
  }
}

class FakeIndex {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly data: StoreData,
    private readonly def: IndexDef,
    private readonly store: FakeObjectStore,
  ) {}

  /** Records matching `range`, in index-key then primary-key order. */
  private matches(range: FakeRange | null): Rec[] {
    return [...this.data.records.values()]
      .filter((rec) => {
        const indexKey = rec.value?.[this.def.keyPath]
        if (indexKey === undefined || indexKey === null) return false
        return range ? range.includes(indexKey) : true
      })
      .sort((a, b) => {
        const byIndex = compareKeys(a.value[this.def.keyPath], b.value[this.def.keyPath])
        return byIndex !== 0 ? byIndex : compareKeys(a.key, b.key)
      })
  }

  getAll(range?: FakeRange | null): FakeRequest<any[]> {
    return this.tx.request(this, () => this.matches(range ?? null).map((r) => structuredClone(r.value)))
  }

  openCursor(range?: FakeRange | null): FakeRequest<FakeCursor | null> {
    const req = new FakeRequest<FakeCursor | null>()
    req.source = this
    req.transaction = this.tx
    const keys = this.matches(range ?? null).map((r) => encodeKey(r.key))
    let at = 0

    const step = () => {
      // Skip anything deleted since the cursor opened.
      while (at < keys.length && !this.data.records.has(keys[at])) at++
      if (at >= keys.length) {
        req.result = null
        req.onsuccess?.({ target: req })
        return
      }
      const rec = this.data.records.get(keys[at])!
      at++
      req.result = {
        key: rec.value[this.def.keyPath],
        primaryKey: rec.key,
        value: structuredClone(rec.value),
        delete: () => this.store.delete(rec.key),
        continue: () => this.tx.enqueue(step),
      }
      req.onsuccess?.({ target: req })
    }

    this.tx.enqueue(step)
    return req
  }
}

interface FakeCursor {
  key: Key
  primaryKey: Key
  value: any
  delete(): FakeRequest<undefined>
  continue(): void
}

class FakeDatabase {
  closed = false
  upgrading = false
  onversionchange: (() => void) | null = null

  constructor(
    readonly backend: FakeBackend,
    readonly name: string,
  ) {}

  get version(): number {
    return this.backend.version
  }

  get objectStoreNames(): { contains(name: string): boolean; length: number } {
    const names = [...this.backend.stores.keys()]
    return { contains: (name: string) => names.includes(name), length: names.length }
  }

  createObjectStore(name: string, options: { keyPath: string | string[] }): FakeObjectStore {
    if (!this.upgrading) throw new DOMException('not in a version change transaction', 'InvalidStateError')
    if (this.backend.stores.has(name)) throw new DOMException(`store "${name}" exists`, 'ConstraintError')
    const data: StoreData = { name, keyPath: options.keyPath, indexes: new Map(), records: new Map() }
    this.backend.stores.set(name, data)
    // Only createIndex is used on the returned handle during an upgrade.
    return new FakeObjectStore(null as unknown as FakeTransaction, data)
  }

  transaction(names: string | string[], mode: 'readonly' | 'readwrite' = 'readonly'): FakeTransaction {
    if (this.closed) throw new DOMException('database is closed', 'InvalidStateError')
    const list = Array.isArray(names) ? names : [names]
    for (const name of list) this.backend.store(name) // throws NotFoundError, as IDB does
    return new FakeTransaction(this, list, mode)
  }

  close(): void {
    this.closed = true
  }
}

function makeFactory(backend: FakeBackend) {
  return {
    open(name: string, version: number): FakeRequest<FakeDatabase> {
      const req = new FakeRequest<FakeDatabase>()
      setTimeout(() => {
        if (backend.openError) {
          req.error = backend.openError
          req.onerror?.({ target: req, preventDefault: () => {} })
          return
        }
        if (backend.blocked) {
          // A real browser fires `blocked` and then simply waits.
          req.onblocked?.()
          return
        }
        backend.openCount++
        const db = new FakeDatabase(backend, name)
        backend.connections.push(db)
        req.result = db
        if (version > backend.version) {
          const oldVersion = backend.version
          backend.version = version
          db.upgrading = true
          try {
            req.onupgradeneeded?.({ target: req, oldVersion, newVersion: version })
          } finally {
            db.upgrading = false
          }
        }
        // The upgrade transaction commits before `success` fires.
        setTimeout(() => req.onsuccess?.({ target: req }), 0)
      }, 0)
      return req
    },
  }
}

/* ===================================================================== *
 * Harness
 * ===================================================================== */

type DbModule = typeof import('./db')

let backend: FakeBackend
let db: DbModule

const savedIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
const savedKeyRange = Object.getOwnPropertyDescriptor(globalThis, 'IDBKeyRange')
const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

function restore(name: string, descriptor: PropertyDescriptor | undefined): void {
  delete (globalThis as Record<string, unknown>)[name]
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
}

/** Fresh storage + a fresh copy of the module, so its cached connection never leaks between tests. */
async function freshModule(): Promise<DbModule> {
  backend = new FakeBackend()
  define('indexedDB', makeFactory(backend))
  define('IDBKeyRange', FakeKeyRange)
  vi.resetModules()
  return import('./db')
}

beforeEach(async () => {
  db = await freshModule()
})

afterEach(() => {
  restore('indexedDB', savedIndexedDB)
  restore('IDBKeyRange', savedKeyRange)
  restore('navigator', savedNavigator)
})

/** Fails loudly instead of hanging if a promise never settles. */
async function settlesWithin<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`promise did not settle within ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    clearTimeout(timer!)
  }
}

/* ===================================================================== *
 * Fixtures
 * ===================================================================== */

function meta(
  id: string,
  columns: { name: string; kind: ColumnKind; encoding?: StringEncoding }[],
  overrides: Partial<DatasetMeta> = {},
): DatasetMeta {
  return {
    id,
    name: `dataset ${id}`,
    rowCount: 6,
    byteSize: 4096,
    sourceBytes: 8192,
    createdAt: 1_700_000_000_000,
    badRows: 0,
    delimiter: ',',
    columns: columns.map<ColumnMeta>((c, i) => ({
      id: c.name,
      name: c.name,
      index: i,
      kind: c.kind,
      encoding: c.encoding,
      nullCount: 1,
      distinctCount: -1,
      byteSize: 48,
    })),
    ...overrides,
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

/** Decode one value out of a blob column, to check the round trip end to end. */
function readBlobValue(col: BlobColumn, row: number): string | null {
  if (col.nulls[row >> 3] & (1 << (row & 7))) return null
  return new TextDecoder().decode(col.bytes.subarray(col.offsets[row], col.offsets[row + 1]))
}

/** Bytes a column occupies once its buffers are persisted exactly. */
function storedBytes(col: ColumnData): number {
  if (col.kind === 'string' && col.encoding === 'dict') return col.codes.byteLength
  if (col.kind === 'string') return col.bytes.byteLength + col.offsets.byteLength + col.nulls.byteLength
  return col.values.byteLength
}

function view(id: string, datasetId: string, createdAt: number, name = id): SavedView {
  return {
    id,
    datasetId,
    name,
    createdAt,
    query: {
      filters: [{ id: 'f1', columnId: 'n', op: 'gt', value: 3, enabled: true }],
      search: { term: 'abc', columnIds: ['s'], caseSensitive: false },
      sorts: [{ columnId: 'n', dir: 'desc' }],
      group: null,
    },
    columnOrder: ['n', 's'],
    columnState: {
      n: { columnId: 'n', width: 120, hidden: false, pinned: true },
      s: { columnId: 's', width: 200, hidden: true, pinned: false },
    },
    charts: [
      {
        id: 'c1',
        title: 'counts',
        type: 'bar',
        xColumnId: 's',
        yColumnId: null,
        agg: 'count',
        bins: 20,
        limit: 10,
        seriesColumnId: null,
      },
    ],
  }
}

/** Asserts same view type, same length, same values — not merely "looks similar". */
function expectSameArray(actual: unknown, expected: ArrayLike<number> & { constructor: unknown }): void {
  expect(actual).toBeInstanceOf(expected.constructor as new () => unknown)
  const got = actual as ArrayLike<number>
  expect(got.length).toBe(expected.length)
  expect(Array.from(got)).toEqual(Array.from(expected))
}

/** The six-column fixture: every ColumnData variant, nulls in each. */
const ALL_KINDS: { name: string; kind: ColumnKind; encoding?: StringEncoding }[] = [
  { name: 'i', kind: 'int' },
  { name: 'f', kind: 'float' },
  { name: 'd', kind: 'date' },
  { name: 'b', kind: 'bool' },
  { name: 's', kind: 'string', encoding: 'dict' },
  { name: 'u', kind: 'string', encoding: 'blob' },
]

function allColumns(): ColumnData[] {
  return [
    num([1, 2, null, 4, -5, 6], 'int'),
    num([1.5, -0.25, null, Number.MAX_SAFE_INTEGER + 0.5, 0, 1e-9], 'float'),
    num([1_700_000_000_000, 0, null, -86_400_000, 1, 2], 'date'),
    bool([true, false, null, true, false, null]),
    dict(['alpha', 'beta', null, 'alpha', 'gamma', 'beta']),
    blob(['hello', '', null, 'naïve ☕', 'x'.repeat(300), 'tail']),
  ]
}

/* ===================================================================== *
 * Tests
 * ===================================================================== */

describe('schema', () => {
  it('creates the three stores, keying columns by (datasetId, columnId)', async () => {
    await db.listDatasets()

    expect([...backend.stores.keys()].sort()).toEqual(['columns', 'datasets', 'views'])
    expect(backend.store('datasets').keyPath).toBe('id')
    // A composite key is what lets loadDataset fetch one column directly.
    expect(backend.store('columns').keyPath).toEqual(['datasetId', 'columnId'])
    expect(backend.store('views').keyPath).toBe('id')
    // Cascading delete and per-dataset view lookup both need this index.
    expect(backend.store('columns').indexes.get('datasetId')?.keyPath).toBe('datasetId')
    expect(backend.store('views').indexes.get('datasetId')?.keyPath).toBe('datasetId')
  })

  it('opens the database once and reuses the connection', async () => {
    await db.listDatasets()
    await db.listDatasets()
    await db.saveView(view('v1', 'ds', 1))

    expect(backend.openCount).toBe(1)
  })

  it('drops the cached connection when another tab bumps the version', async () => {
    await db.saveDataset(meta('ds', [{ name: 'i', kind: 'int' }]), [num([1, 2, 3])])
    const connection = backend.connections[0]
    expect(connection.closed).toBe(false)

    // Another tab is upgrading: the worker must let go of its connection.
    connection.onversionchange?.()
    expect(connection.closed).toBe(true)

    // ...and the next call must reconnect rather than fail on a closed handle.
    const loaded = await settlesWithin(db.loadDataset('ds'))
    expect(backend.openCount).toBe(2)
    expect(loaded?.columns).toHaveLength(1)
  })
})

describe('round trip fidelity', () => {
  it('restores every column variant with the same view type, length and values', async () => {
    const m = meta('ds', ALL_KINDS)
    const columns = allColumns()
    await db.saveDataset(m, columns)

    const loaded = await db.loadDataset('ds')
    expect(loaded).not.toBeNull()
    expect(loaded!.columns).toHaveLength(6)

    const [i, f, d, b, s, u] = loaded!.columns
    const [oi, of, od, ob, os, ou] = columns

    expect(i.kind).toBe('int')
    expectSameArray((i as { values: Float64Array }).values, (oi as { values: Float64Array }).values)
    expect(f.kind).toBe('float')
    expectSameArray((f as { values: Float64Array }).values, (of as { values: Float64Array }).values)
    expect(d.kind).toBe('date')
    expectSameArray((d as { values: Float64Array }).values, (od as { values: Float64Array }).values)

    // NaN is the null encoding; it has to survive as NaN, in place.
    expect(Number.isNaN((i as { values: Float64Array }).values[2])).toBe(true)
    expect(Number.isNaN((d as { values: Float64Array }).values[2])).toBe(true)

    expect(b.kind).toBe('bool')
    expectSameArray((b as { values: Uint8Array }).values, (ob as { values: Uint8Array }).values)
    // 2 is the null sentinel, and must not be coerced to a boolean 0/1.
    expect(Array.from((b as { values: Uint8Array }).values)).toEqual([1, 0, 2, 1, 0, 2])

    expect(s.kind).toBe('string')
    expect((s as { encoding: string }).encoding).toBe('dict')
    expectSameArray((s as { codes: Int32Array }).codes, (os as { codes: Int32Array }).codes)
    expect((s as { dictionary: string[] }).dictionary).toEqual(['alpha', 'beta', 'gamma'])
    // -1 is the null code; an unsigned round trip would turn it into 4294967295.
    expect((s as { codes: Int32Array }).codes[2]).toBe(-1)

    expect(u.kind).toBe('string')
    expect((u as { encoding: string }).encoding).toBe('blob')
    const blobCol = u as BlobColumn
    const origBlob = ou as BlobColumn
    expectSameArray(blobCol.bytes, origBlob.bytes)
    expectSameArray(blobCol.offsets, origBlob.offsets)
    expectSameArray(blobCol.nulls, origBlob.nulls)
    // The bytes/offsets/bitmap triple only matters if it decodes back to the values.
    expect([0, 1, 2, 3, 4, 5].map((r) => readBlobValue(blobCol, r))).toEqual([
      'hello',
      '',
      null,
      'naïve ☕',
      'x'.repeat(300),
      'tail',
    ])
  })

  it('restores the dataset metadata', async () => {
    const m = meta('ds', ALL_KINDS, { name: 'sales.csv', rowCount: 6, badRows: 3, delimiter: '\t' })
    await db.saveDataset(m, allColumns())

    const loaded = await db.loadDataset('ds')
    expect(loaded!.meta).toEqual(m)
  })

  it('does not hand back storage that aliases the caller’s buffers', async () => {
    // The fake clones on `put`, synchronously, exactly as real IndexedDB does,
    // so mutating the source *after* `saveDataset` resolves proves nothing about
    // db.ts — the deep copy would be the harness's. The claim is about the record
    // db.ts hands to `put`: its buffers must be copies of the caller's, not the
    // caller's live ones. The write hook sees that record before the clone.
    let raw: { buffers: Record<string, ArrayBuffer> } | undefined
    backend.writeHook = (store, op, value) => {
      if (store === 'columns' && op === 'put') raw = value as { buffers: Record<string, ArrayBuffer> }
      return null
    }

    const column = num([1, 2, 3])
    await db.saveDataset(meta('ds', [{ name: 'i', kind: 'int' }]), [column])

    const live = (column as { values: Float64Array }).values
    expect(raw).toBeDefined()
    // Handing storage the caller's own buffer is the bug; the copy must be exact.
    expect(raw!.buffers.values).not.toBe(live.buffer)
    expect(raw!.buffers.values.byteLength).toBe(live.byteLength)

    // ...and the copy is what survives: mutating the source cannot reach through.
    live[0] = 999
    const loaded = await db.loadDataset('ds')
    expect(Array.from((loaded!.columns[0] as { values: Float64Array }).values)).toEqual([1, 2, 3])
  })

  it('persists a TypedArray view without its slack bytes', async () => {
    // 10 live values sitting at byte 64 of a much larger buffer.
    const big = new ArrayBuffer(8 * 64)
    const values = new Float64Array(big, 64, 10)
    for (let i = 0; i < 10; i++) values[i] = i * 1.5
    values[3] = NaN
    const codesBuffer = new ArrayBuffer(4 * 40)
    const codes = new Int32Array(codesBuffer, 32, 4)
    codes.set([0, -1, 1, 0])

    const m = meta('ds', [
      { name: 'i', kind: 'float' },
      { name: 's', kind: 'string', encoding: 'dict' },
    ])
    const dictCol: ColumnData = { kind: 'string', encoding: 'dict', codes, dictionary: ['a', 'b'] }
    const res = await db.saveDataset(m, [{ kind: 'float', values }, dictCol])

    const loaded = await db.loadDataset('ds')
    const back = loaded!.columns[0] as { values: Float64Array }
    expect(back.values).toBeInstanceOf(Float64Array)
    expect(back.values.length).toBe(10)
    expect(Array.from(back.values)).toEqual([0, 1.5, 3, NaN, 6, 7.5, 9, 10.5, 12, 13.5])
    // Nothing of the surrounding buffer may come along for the ride.
    expect(back.values.byteLength).toBe(80)
    expect(back.values.buffer.byteLength).toBe(80)

    const backCodes = loaded!.columns[1] as { codes: Int32Array }
    expect(backCodes.codes).toBeInstanceOf(Int32Array)
    expect(Array.from(backCodes.codes)).toEqual([0, -1, 1, 0])
    expect(backCodes.codes.buffer.byteLength).toBe(16)

    // The reported total is the live bytes, not the backing buffers.
    expect(res.bytes).toBe(80 + 16)
  })
})

describe('saveDataset', () => {
  it('reports the persisted byte total and drives progress to 1', async () => {
    const m = meta('ds', ALL_KINDS)
    const columns = allColumns()
    const expected = columns.reduce((sum, c) => sum + storedBytes(c), 0)

    const progress: number[] = []
    const res = await db.saveDataset(m, columns, (r) => progress.push(r))

    expect(res).toEqual({ datasetId: 'ds', bytes: expected })
    expect(res.bytes).toBeGreaterThan(0)
    // One tick per column, then the final one. A bar that jumps to 100% on the
    // first column and then sits there for the rest of a 30-second save is the
    // regression this exists to catch, so pin the shape rather than an envelope
    // that `onProgress(1)` per column would also satisfy.
    expect(progress).toHaveLength(m.columns.length + 1)
    expect(progress.slice(0, -1)).toEqual(m.columns.map((_, i) => (i + 1) / (m.columns.length + 1)))
    expect(progress[progress.length - 1]).toBe(1)
    // Strictly increasing: it never goes backwards, and never stalls either.
    expect(progress.every((r, i) => i === 0 || r > progress[i - 1])).toBe(true)
  })

  it('writes one record per column, keyed by dataset and column', async () => {
    await db.saveDataset(meta('ds', ALL_KINDS), allColumns())

    const records = backend.values('columns') as { datasetId: string; columnId: string }[]
    expect(records).toHaveLength(6)
    expect(records.map((r) => r.columnId).sort()).toEqual(['b', 'd', 'f', 'i', 's', 'u'])
    expect(records.every((r) => r.datasetId === 'ds')).toBe(true)
  })

  it('replaces an earlier save of the same dataset instead of duplicating it', async () => {
    const m = meta('ds', [{ name: 'i', kind: 'int' }])
    await db.saveDataset(m, [num([1, 2, 3])])
    await db.saveDataset({ ...m, name: 'renamed' }, [num([9, 9, 9])])

    expect(backend.count('datasets')).toBe(1)
    expect(backend.count('columns')).toBe(1)
    const loaded = await db.loadDataset('ds')
    expect(loaded!.meta.name).toBe('renamed')
    expect(Array.from((loaded!.columns[0] as { values: Float64Array }).values)).toEqual([9, 9, 9])
  })
})

describe('loadDataset', () => {
  it('drives progress to 1', async () => {
    await db.saveDataset(meta('ds', ALL_KINDS), allColumns())

    const progress: number[] = []
    await db.loadDataset('ds', (r) => progress.push(r))

    expect(progress).toHaveLength(6)
    expect(progress[progress.length - 1]).toBe(1)
    expect([...progress].sort((a, b) => a - b)).toEqual(progress)
  })

  it('returns null for an unknown id', async () => {
    await db.saveDataset(meta('ds', [{ name: 'i', kind: 'int' }]), [num([1])])

    expect(await db.loadDataset('nope')).toBeNull()
  })

  it('returns null rather than a half-built dataset when a column record is missing', async () => {
    const m = meta('ds', [
      { name: 'i', kind: 'int' },
      { name: 'j', kind: 'int' },
    ])
    await db.saveDataset(m, [num([1, 2]), num([3, 4])])

    // Simulate a torn write: the second column never made it to disk.
    backend.store('columns').records.delete(encodeKey(['ds', 'j']))

    expect(await db.loadDataset('ds')).toBeNull()
  })
})

describe('listDatasets', () => {
  it('returns newest first with the summary fields', async () => {
    // Ids are deliberately out of chronological order: sorting must use createdAt.
    await db.saveDataset(meta('a', [{ name: 'i', kind: 'int' }], { createdAt: 200, name: 'middle', rowCount: 20, byteSize: 2048 }), [num([1])])
    await db.saveDataset(meta('b', [{ name: 'i', kind: 'int' }], { createdAt: 300, name: 'newest', rowCount: 30, byteSize: 3072 }), [num([1])])
    await db.saveDataset(meta('c', [{ name: 'i', kind: 'int' }], { createdAt: 100, name: 'oldest', rowCount: 10, byteSize: 1024 }), [num([1])])

    const rows = await db.listDatasets()

    expect(rows.map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(rows[0]).toEqual({ id: 'b', name: 'newest', rowCount: 30, createdAt: 300, bytes: 3072 })
    expect(rows[2]).toEqual({ id: 'c', name: 'oldest', rowCount: 10, createdAt: 100, bytes: 1024 })
  })

  it('is empty when nothing has been saved', async () => {
    expect(await db.listDatasets()).toEqual([])
  })
})

describe('deleteDataset', () => {
  it('removes the dataset, every column and every view, and nothing else', async () => {
    await db.saveDataset(meta('keep', ALL_KINDS), allColumns())
    await db.saveDataset(meta('drop', ALL_KINDS), allColumns())
    await db.saveView(view('v-keep', 'keep', 10))
    await db.saveView(view('v-drop-1', 'drop', 20))
    await db.saveView(view('v-drop-2', 'drop', 30))
    expect(backend.count('columns')).toBe(12)

    await db.deleteDataset('drop')

    expect(await db.loadDataset('drop')).toBeNull()
    expect((await db.listDatasets()).map((d) => d.id)).toEqual(['keep'])
    const columnOwners = (backend.values('columns') as { datasetId: string }[]).map((r) => r.datasetId)
    expect(columnOwners).toEqual(Array(6).fill('keep'))
    expect((await db.listViews('drop'))).toEqual([])
    expect((await db.listViews('keep')).map((v) => v.id)).toEqual(['v-keep'])

    // The survivor must be loadable in full, not just present.
    const kept = await db.loadDataset('keep')
    expect(kept!.columns).toHaveLength(6)
    expect(Array.from((kept!.columns[3] as { values: Uint8Array }).values)).toEqual([1, 0, 2, 1, 0, 2])
  })

  it('is a no-op for an unknown id', async () => {
    await db.saveDataset(meta('keep', [{ name: 'i', kind: 'int' }]), [num([1])])

    await expect(db.deleteDataset('ghost')).resolves.toBeUndefined()
    expect(backend.count('datasets')).toBe(1)
    expect(backend.count('columns')).toBe(1)
  })
})

describe('views', () => {
  it('round-trips a view whole', async () => {
    const v = view('v1', 'ds', 5, 'my view')
    await db.saveView(v)

    expect(await db.listViews('ds')).toEqual([v])
  })

  it('lists only the given dataset’s views, newest first', async () => {
    // Ids ascend while timestamps do not, so id order cannot pass for time order.
    await db.saveView(view('v1', 'ds', 100))
    await db.saveView(view('v2', 'other', 999))
    await db.saveView(view('v3', 'ds', 300))
    await db.saveView(view('v4', 'ds', 200))

    expect((await db.listViews('ds')).map((v) => v.id)).toEqual(['v3', 'v4', 'v1'])
    expect((await db.listViews('other')).map((v) => v.id)).toEqual(['v2'])
    expect(await db.listViews('missing')).toEqual([])
  })

  it('overwrites a view saved again under the same id', async () => {
    await db.saveView(view('v1', 'ds', 1, 'first'))
    await db.saveView(view('v1', 'ds', 2, 'second'))

    const views = await db.listViews('ds')
    expect(views).toHaveLength(1)
    expect(views[0].name).toBe('second')
  })

  it('deletes one view and leaves the rest', async () => {
    await db.saveView(view('v1', 'ds', 1))
    await db.saveView(view('v2', 'ds', 2))

    await db.deleteView('v1')

    expect((await db.listViews('ds')).map((v) => v.id)).toEqual(['v2'])
    await expect(db.deleteView('gone')).resolves.toBeUndefined()
  })
})

describe('clearAll', () => {
  it('empties every store and reports how many datasets went', async () => {
    await db.saveDataset(meta('a', ALL_KINDS), allColumns())
    await db.saveDataset(meta('b', [{ name: 'i', kind: 'int' }]), [num([1])])
    await db.saveView(view('v1', 'a', 1))
    await db.saveView(view('v2', 'b', 2))

    expect(await db.clearAll()).toEqual({ datasets: 2 })

    expect(backend.count('datasets')).toBe(0)
    expect(backend.count('columns')).toBe(0)
    expect(backend.count('views')).toBe(0)
    expect(await db.listDatasets()).toEqual([])
    expect(await db.listViews('a')).toEqual([])
    expect(await db.loadDataset('a')).toBeNull()
  })

  it('reports zero on empty storage', async () => {
    expect(await db.clearAll()).toEqual({ datasets: 0 })
  })
})

describe('error mapping', () => {
  it('turns a quota abort into a QUOTA_EXCEEDED message', async () => {
    backend.writeHook = (store) =>
      store === 'columns' ? new DOMException('the quota has been exceeded', 'QuotaExceededError') : null

    await expect(
      settlesWithin(db.saveDataset(meta('ds', [{ name: 'i', kind: 'int' }]), [num([1, 2, 3])])),
    ).rejects.toThrow(/^QUOTA_EXCEEDED/)
  })

  it('maps a quota abort on any store, including views', async () => {
    backend.writeHook = () => new DOMException('no room', 'QuotaExceededError')

    await expect(settlesWithin(db.saveView(view('v1', 'ds', 1)))).rejects.toThrow(/^QUOTA_EXCEEDED/)
  })

  it('passes other transaction failures through unchanged', async () => {
    backend.writeHook = () => new DOMException('index constraint', 'ConstraintError')

    // Only the quota case gets rewritten; anything else must keep its own message.
    await expect(settlesWithin(db.saveView(view('v1', 'ds', 1)))).rejects.toThrow('index constraint')
  })

  it('reports, rather than waits, when another tab blocks the upgrade', async () => {
    backend.blocked = true

    // A real browser never settles the open request here, so the module has to.
    await expect(settlesWithin(db.listDatasets())).rejects.toThrow(/another tab/i)
  })

  it('rolls back and reports when opening the database fails', async () => {
    backend.openError = new DOMException('cannot open', 'UnknownError')

    await expect(settlesWithin(db.listDatasets())).rejects.toThrow('cannot open')

    // A failed open must not be cached: once the fault clears, the next call works.
    backend.openError = null
    await expect(settlesWithin(db.listDatasets())).resolves.toEqual([])
  })

  /**
   * Regression: the header is written last, so a failure partway through a save
   * can no longer leave a record that listDatasets advertises but loadDataset
   * cannot open. Note this case never reaches the rollback for anything — it is
   * a first save, so there is nothing committed to undo; the two tests below
   * cover the rollback itself.
   */
  it('does not leave an unloadable dataset behind after a failed save', async () => {
    backend.writeHook = (store) =>
      store === 'columns' ? new DOMException('no room', 'QuotaExceededError') : null

    await expect(db.saveDataset(meta('ds', [{ name: 'i', kind: 'int' }]), [num([1, 2, 3])])).rejects.toThrow()

    backend.writeHook = null
    // The symptom: a header with no columns behind it, which can never be opened.
    expect(await db.loadDataset('ds')).toBeNull()
    expect(await db.listDatasets()).toEqual([])
  })

  it('rolls back the columns a failed save had already written', async () => {
    const m = meta('ds', [
      { name: 'i', kind: 'int' },
      { name: 'j', kind: 'int' },
    ])
    // The first column commits; the second runs out of room. Deletes still work,
    // so the rollback is free to run — the question is whether it does.
    backend.writeHook = (store, op, value) =>
      store === 'columns' && op === 'put' && (value as { columnId: string }).columnId === 'j'
        ? new DOMException('no room', 'QuotaExceededError')
        : null

    await expect(settlesWithin(db.saveDataset(m, [num([1, 2]), num([3, 4])]))).rejects.toThrow(/^QUOTA_EXCEEDED/)

    backend.writeHook = null
    // Column 'i' was committed before the failure. Left behind it is unopenable
    // dead weight occupying the very quota whose exhaustion caused the failure.
    expect(backend.count('columns')).toBe(0)
    expect(backend.count('datasets')).toBe(0)
  })

  /**
   * DOCUMENTS A BUG. saveDataset's rollback calls `deleteDataset`, which cascades
   * into STORE_VIEWS, so a save that merely ran out of room also destroys every
   * SavedView for that dataset — tiny metadata that had nothing to do with the
   * failure, and that costs nothing to keep. db.ts's comment owns up to losing the
   * previous copy of the data; it says nothing about the views. The catch should
   * undo only what this save wrote: the dataset header and this dataset's column
   * records.
   */
  it('a failed re-save keeps the saved views', async () => {
    const m = meta('ds', [
      { name: 'i', kind: 'int' },
      { name: 'j', kind: 'int' },
    ])
    await db.saveDataset(m, [num([1, 2]), num([3, 4])])
    await db.saveView(view('v1', 'ds', 1))

    // Room runs out on the second column of the re-save.
    backend.writeHook = (store, op, value) =>
      store === 'columns' && op === 'put' && (value as { columnId: string }).columnId === 'j'
        ? new DOMException('no room', 'QuotaExceededError')
        : null

    await expect(settlesWithin(db.saveDataset(m, [num([5, 6]), num([7, 8])]))).rejects.toThrow(/^QUOTA_EXCEEDED/)

    backend.writeHook = null
    expect((await db.listViews('ds')).map((v) => v.id)).toEqual(['v1'])
  })

  /** Regression: a dropped column used to linger in storage forever. */
  it('prunes column records dropped from the dataset on re-save', async () => {
    const m = meta('ds', [
      { name: 'i', kind: 'int' },
      { name: 'j', kind: 'int' },
    ])
    await db.saveDataset(m, [num([1]), num([2])])

    await db.saveDataset(meta('ds', [{ name: 'i', kind: 'int' }]), [num([1])])

    expect(backend.count('columns')).toBe(1)
  })
})

describe('when IndexedDB is unavailable', () => {
  beforeEach(async () => {
    delete (globalThis as Record<string, unknown>).indexedDB
    vi.resetModules()
    db = await import('./db')
  })

  it('reports persistence as unavailable', () => {
    expect(db.isPersistenceAvailable()).toBe(false)
  })

  it('rejects every entry point with a clear message instead of hanging', async () => {
    const calls: [string, Promise<unknown>][] = [
      ['saveDataset', db.saveDataset(meta('ds', [{ name: 'i', kind: 'int' }]), [num([1])])],
      ['loadDataset', db.loadDataset('ds')],
      ['listDatasets', db.listDatasets()],
      ['deleteDataset', db.deleteDataset('ds')],
      ['saveView', db.saveView(view('v1', 'ds', 1))],
      ['listViews', db.listViews('ds')],
      ['deleteView', db.deleteView('v1')],
      ['clearAll', db.clearAll()],
    ]

    for (const [name, promise] of calls) {
      await expect(settlesWithin(promise, 500), name).rejects.toThrow(/unavailable/i)
    }
  })

  it('reports persistence as available again once IndexedDB returns', async () => {
    define('indexedDB', makeFactory(backend))
    expect(db.isPersistenceAvailable()).toBe(true)
    await expect(settlesWithin(db.listDatasets())).resolves.toEqual([])
  })
})

describe('estimateQuota', () => {
  it('returns null when there is no navigator', async () => {
    delete (globalThis as Record<string, unknown>).navigator

    expect(await db.estimateQuota()).toBeNull()
  })

  it('returns null when the browser exposes no storage manager', async () => {
    define('navigator', {})
    expect(await db.estimateQuota()).toBeNull()

    define('navigator', { storage: {} })
    expect(await db.estimateQuota()).toBeNull()
  })

  it('returns the browser’s estimate', async () => {
    define('navigator', { storage: { estimate: async () => ({ usage: 1234, quota: 5678 }) } })

    expect(await db.estimateQuota()).toEqual({ usage: 1234, quota: 5678 })
  })

  it('defaults missing figures to zero', async () => {
    define('navigator', { storage: { estimate: async () => ({}) } })

    expect(await db.estimateQuota()).toEqual({ usage: 0, quota: 0 })
  })

  it('returns null rather than throwing when the estimate fails', async () => {
    define('navigator', {
      storage: {
        estimate: async () => {
          throw new DOMException('denied', 'SecurityError')
        },
      },
    })

    expect(await db.estimateQuota()).toBeNull()
  })
})
