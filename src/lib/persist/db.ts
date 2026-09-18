/**
 * IndexedDB persistence. Runs inside the worker, so there is no `window` and
 * no localStorage — only `self`, and the raw IDB API.
 *
 * Columns are stored one record each rather than one blob per dataset: a
 * million-row dataset is hundreds of megabytes, and a per-column layout keeps
 * each transaction short, makes progress reportable, and stays well clear of
 * per-record size limits.
 */

import type { ColumnData, DatasetMeta, SavedView } from '@/lib/types'

const DB_NAME = 'dataforge'
const DB_VERSION = 1
const STORE_DATASETS = 'datasets'
const STORE_COLUMNS = 'columns'
const STORE_VIEWS = 'views'

export interface StoredDatasetInfo {
  id: string
  name: string
  rowCount: number
  createdAt: number
  bytes: number
}

export function isPersistenceAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

function unavailable(): Error {
  return new Error('Local storage is unavailable in this browser context')
}

/* --------------------------------------------------------------- plumbing */

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!isPersistenceAvailable()) return Promise.reject(unavailable())
  if (dbPromise) return dbPromise

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_DATASETS)) {
        db.createObjectStore(STORE_DATASETS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_COLUMNS)) {
        const store = db.createObjectStore(STORE_COLUMNS, { keyPath: ['datasetId', 'columnId'] })
        store.createIndex('datasetId', 'datasetId', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORE_VIEWS)) {
        const store = db.createObjectStore(STORE_VIEWS, { keyPath: 'id' })
        store.createIndex('datasetId', 'datasetId', { unique: false })
      }
    }

    request.onsuccess = () => {
      const db = request.result
      // Close on a version bump from another tab, so its upgrade is not blocked.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? unavailable())
    request.onblocked = () => reject(new Error('Another tab is holding an older version of the database'))
  })

  dbPromise = dbPromise.catch((err) => {
    dbPromise = null
    throw err
  })
  return dbPromise
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

/** A write is only durable when the transaction completes, not when the last request succeeds. */
function commit(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(mapError(tx.error))
    tx.onerror = () => reject(mapError(tx.error))
  })
}

function mapError(err: DOMException | Error | null): Error {
  if (!err) return new Error('IndexedDB transaction failed')
  if (err.name === 'QuotaExceededError') {
    return new Error('QUOTA_EXCEEDED: this browser ran out of room for the dataset')
  }
  return err instanceof Error ? err : new Error(String(err))
}

/* ----------------------------------------------------------- serialisation */

type StoredColumn = {
  datasetId: string
  columnId: string
  kind: ColumnData['kind']
  encoding?: string
  buffers: Record<string, ArrayBuffer>
  dictionary?: string[]
  lengths: Record<string, number>
}

/** A view over a larger buffer must be sliced, or we persist slack bytes. */
function exact(view: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
}

function serializeColumn(datasetId: string, columnId: string, col: ColumnData): StoredColumn {
  const buffers: Record<string, ArrayBuffer> = {}
  const lengths: Record<string, number> = {}

  if (col.kind === 'string' && col.encoding === 'dict') {
    buffers.codes = exact(col.codes)
    lengths.codes = col.codes.length
    return { datasetId, columnId, kind: col.kind, encoding: 'dict', buffers, lengths, dictionary: col.dictionary }
  }
  if (col.kind === 'string') {
    buffers.bytes = exact(col.bytes)
    buffers.offsets = exact(col.offsets)
    buffers.nulls = exact(col.nulls)
    lengths.bytes = col.bytes.length
    lengths.offsets = col.offsets.length
    lengths.nulls = col.nulls.length
    return { datasetId, columnId, kind: col.kind, encoding: 'blob', buffers, lengths }
  }
  buffers.values = exact(col.values)
  lengths.values = col.values.length
  return { datasetId, columnId, kind: col.kind, buffers, lengths }
}

function deserializeColumn(record: StoredColumn): ColumnData {
  if (record.kind === 'string' && record.encoding === 'dict') {
    return {
      kind: 'string',
      encoding: 'dict',
      codes: new Int32Array(record.buffers.codes, 0, record.lengths.codes),
      dictionary: record.dictionary ?? [],
    }
  }
  if (record.kind === 'string') {
    return {
      kind: 'string',
      encoding: 'blob',
      bytes: new Uint8Array(record.buffers.bytes, 0, record.lengths.bytes),
      offsets: new Uint32Array(record.buffers.offsets, 0, record.lengths.offsets),
      nulls: new Uint8Array(record.buffers.nulls, 0, record.lengths.nulls),
    }
  }
  if (record.kind === 'bool') {
    return { kind: 'bool', values: new Uint8Array(record.buffers.values, 0, record.lengths.values) }
  }
  return {
    kind: record.kind,
    values: new Float64Array(record.buffers.values, 0, record.lengths.values),
  }
}

/* ---------------------------------------------------------------- datasets */

/**
 * Drops column records belonging to this dataset that are no longer part of it.
 * Without this a re-save that removed a column leaves the old record behind
 * forever, quietly inflating what the storage panel reports as used.
 */
/**
 * Removes a dataset's header and column records but leaves its saved views
 * alone. Used to undo a failed save: the views predate it and are a few
 * hundred bytes of metadata, so destroying them would punish the user for a
 * quota failure that had nothing to do with them.
 */
async function deleteDatasetData(db: IDBDatabase, datasetId: string): Promise<void> {
  const tx = db.transaction([STORE_DATASETS, STORE_COLUMNS], 'readwrite')
  tx.objectStore(STORE_DATASETS).delete(datasetId)
  const request = tx.objectStore(STORE_COLUMNS).index('datasetId').openCursor(IDBKeyRange.only(datasetId))
  request.onsuccess = () => {
    const cursor = request.result
    if (!cursor) return
    cursor.delete()
    cursor.continue()
  }
  await commit(tx)
}

async function pruneColumns(db: IDBDatabase, datasetId: string, keep: Set<string>): Promise<void> {
  const tx = db.transaction(STORE_COLUMNS, 'readwrite')
  const request = tx.objectStore(STORE_COLUMNS).index('datasetId').openCursor(IDBKeyRange.only(datasetId))
  request.onsuccess = () => {
    const cursor = request.result
    if (!cursor) return
    const record = cursor.value as StoredColumn
    if (!keep.has(record.columnId)) cursor.delete()
    cursor.continue()
  }
  await commit(tx)
}

export async function saveDataset(
  meta: DatasetMeta,
  columns: ColumnData[],
  onProgress?: (ratio: number) => void,
): Promise<{ datasetId: string; bytes: number }> {
  const db = await openDb()
  let bytes = 0

  try {
    // Columns are written first and the header last, so a run that dies partway
    // can never leave a dataset listed that has nothing behind it to open.
    // One transaction per column also keeps each write short and progress real.
    for (let i = 0; i < meta.columns.length; i++) {
      const record = serializeColumn(meta.id, meta.columns[i].id, columns[i])
      for (const buf of Object.values(record.buffers)) bytes += buf.byteLength

      const tx = db.transaction(STORE_COLUMNS, 'readwrite')
      tx.objectStore(STORE_COLUMNS).put(record)
      await commit(tx)
      onProgress?.((i + 1) / (meta.columns.length + 1))
    }

    await pruneColumns(db, meta.id, new Set(meta.columns.map((c) => c.id)))

    const tx = db.transaction(STORE_DATASETS, 'readwrite')
    tx.objectStore(STORE_DATASETS).put({
      id: meta.id,
      name: meta.name,
      rowCount: meta.rowCount,
      createdAt: meta.createdAt,
      bytes: meta.byteSize,
      meta,
    })
    await commit(tx)
    onProgress?.(1)
  } catch (err) {
    // Leave nothing half-written. A partial dataset cannot be opened, yet still
    // occupies the quota whose exhaustion usually caused the failure. This does
    // mean a failed re-save loses the previous copy; the alternative is writing
    // a second copy alongside the first, which needs the room we just ran out of.
    // Saved views are deliberately spared — see deleteDatasetData.
    await deleteDatasetData(db, meta.id).catch(() => {})
    throw err
  }

  return { datasetId: meta.id, bytes }
}

export async function loadDataset(
  datasetId: string,
  onProgress?: (ratio: number) => void,
): Promise<{ meta: DatasetMeta; columns: ColumnData[] } | null> {
  const db = await openDb()

  const head = await promisifyRequest<{ meta: DatasetMeta } | undefined>(
    db.transaction(STORE_DATASETS, 'readonly').objectStore(STORE_DATASETS).get(datasetId),
  )
  if (!head?.meta) return null

  const meta = head.meta
  const columns: ColumnData[] = []

  for (let i = 0; i < meta.columns.length; i++) {
    const record = await promisifyRequest<StoredColumn | undefined>(
      db
        .transaction(STORE_COLUMNS, 'readonly')
        .objectStore(STORE_COLUMNS)
        .get([datasetId, meta.columns[i].id]),
    )
    if (!record) return null
    columns.push(deserializeColumn(record))
    onProgress?.((i + 1) / meta.columns.length)
  }

  return { meta, columns }
}

export async function listDatasets(): Promise<StoredDatasetInfo[]> {
  const db = await openDb()
  const rows = await promisifyRequest<StoredDatasetInfo[]>(
    db.transaction(STORE_DATASETS, 'readonly').objectStore(STORE_DATASETS).getAll(),
  )
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      rowCount: r.rowCount,
      createdAt: r.createdAt,
      bytes: r.bytes,
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function deleteDataset(datasetId: string): Promise<void> {
  const db = await openDb()

  const tx = db.transaction([STORE_DATASETS, STORE_COLUMNS, STORE_VIEWS], 'readwrite')
  tx.objectStore(STORE_DATASETS).delete(datasetId)

  const columnCursor = tx.objectStore(STORE_COLUMNS).index('datasetId').openCursor(IDBKeyRange.only(datasetId))
  columnCursor.onsuccess = () => {
    const cursor = columnCursor.result
    if (cursor) {
      cursor.delete()
      cursor.continue()
    }
  }

  const viewCursor = tx.objectStore(STORE_VIEWS).index('datasetId').openCursor(IDBKeyRange.only(datasetId))
  viewCursor.onsuccess = () => {
    const cursor = viewCursor.result
    if (cursor) {
      cursor.delete()
      cursor.continue()
    }
  }

  await commit(tx)
}

/* ------------------------------------------------------------------ views */

export async function saveView(view: SavedView): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE_VIEWS, 'readwrite')
  tx.objectStore(STORE_VIEWS).put(view)
  await commit(tx)
}

export async function listViews(datasetId: string): Promise<SavedView[]> {
  const db = await openDb()
  const rows = await promisifyRequest<SavedView[]>(
    db.transaction(STORE_VIEWS, 'readonly').objectStore(STORE_VIEWS).index('datasetId').getAll(IDBKeyRange.only(datasetId)),
  )
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

export async function deleteView(viewId: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE_VIEWS, 'readwrite')
  tx.objectStore(STORE_VIEWS).delete(viewId)
  await commit(tx)
}

/** Wipes every dataset, column and saved view this app has stored. */
export async function clearAll(): Promise<{ datasets: number }> {
  const db = await openDb()
  const before = await listDatasets()
  const tx = db.transaction([STORE_DATASETS, STORE_COLUMNS, STORE_VIEWS], 'readwrite')
  tx.objectStore(STORE_DATASETS).clear()
  tx.objectStore(STORE_COLUMNS).clear()
  tx.objectStore(STORE_VIEWS).clear()
  await commit(tx)
  return { datasets: before.length }
}

export async function estimateQuota(): Promise<{ usage: number; quota: number } | null> {
  try {
    const storage = (globalThis as { navigator?: Navigator }).navigator?.storage
    if (!storage?.estimate) return null
    const est = await storage.estimate()
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 }
  } catch {
    return null
  }
}
