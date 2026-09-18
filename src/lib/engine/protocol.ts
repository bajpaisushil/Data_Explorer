/**
 * Typed request/response contract between the UI thread and the data worker.
 *
 * One worker owns all column memory. The UI never holds a full dataset — it
 * asks for windows of at most a few hundred rows at a time.
 */

import type {
  ChartData,
  ChartSpec,
  ColumnProfile,
  ColumnStats,
  DatasetMeta,
  GroupWindow,
  QueryResult,
  QuerySpec,
  RowWindow,
  SavedView,
  ValueCount,
} from '@/lib/types'

/* --------------------------------------------------------------- requests */

export interface ParseOptions {
  /** Override delimiter detection. */
  delimiter?: string
  /** Treat the first row as a header. Defaults to true. */
  header?: boolean
  /** Extra tokens to read as null, on top of "" and "null"/"NULL"/"NaN"/"N/A". */
  nullTokens?: string[]
  /** Stop after this many data rows. 0 means no limit. */
  maxRows?: number
}

export type Req =
  | { kind: 'parseFile'; file: File; options?: ParseOptions }
  | { kind: 'parseBuffer'; name: string; buffer: ArrayBuffer; options?: ParseOptions }
  /** Generate a built-in demo dataset in the worker, then parse it in place. */
  | { kind: 'generateSample'; presetId: string; rows: number }
  | { kind: 'query'; spec: QuerySpec }
  | { kind: 'rowWindow'; offset: number; limit: number; columnIds: string[] }
  | { kind: 'groupWindow'; offset: number; limit: number }
  | { kind: 'stats'; columnId: string; bins?: number }
  /** Profile every column against the *current* query result. */
  | { kind: 'profile'; columnIds: string[]; bins?: number }
  | { kind: 'chart'; spec: ChartSpec }
  /** Distinct values of a column, for the filter UI. Respects current filters. */
  | { kind: 'distinct'; columnId: string; limit: number; search?: string; global?: boolean }
  /** Min/max of a column across the whole dataset, for range filter bounds. */
  | { kind: 'extent'; columnId: string }
  | { kind: 'exportCsv'; columnIds: string[]; limit: number }
  | { kind: 'persistDataset' }
  | { kind: 'loadDataset'; datasetId: string }
  | { kind: 'listDatasets' }
  | { kind: 'deleteDataset'; datasetId: string }
  | { kind: 'saveView'; view: SavedView }
  | { kind: 'listViews'; datasetId: string }
  | { kind: 'deleteView'; viewId: string }
  | { kind: 'memoryReport' }
  | { kind: 'dispose' }

/* -------------------------------------------------------------- responses */

export interface MemoryReport {
  rowCount: number
  totalBytes: number
  columns: { columnId: string; name: string; bytes: number; encoding: string }[]
  /** Bytes the same data would take as plain JS values, for the comparison. */
  naiveBytes: number
}

export interface ResMap {
  parseFile: DatasetMeta
  parseBuffer: DatasetMeta
  generateSample: DatasetMeta
  query: QueryResult
  rowWindow: RowWindow
  groupWindow: GroupWindow
  stats: ColumnStats
  profile: ColumnProfile[]
  chart: ChartData
  distinct: ValueCount[]
  extent: { min: number; max: number }
  exportCsv: { bytes: Uint8Array; rows: number }
  persistDataset: { datasetId: string; bytes: number }
  loadDataset: DatasetMeta
  listDatasets: { id: string; name: string; rowCount: number; createdAt: number; bytes: number }[]
  deleteDataset: { ok: true }
  saveView: { ok: true }
  listViews: SavedView[]
  deleteView: { ok: true }
  memoryReport: MemoryReport
  dispose: { ok: true }
}

export type ReqKind = Req['kind']
export type ResFor<K extends ReqKind> = ResMap[K]

/* ---------------------------------------------------------------- events */

export type ProgressPhase =
  | 'generating'
  | 'reading'
  | 'scanning'
  | 'parsing'
  | 'indexing'
  | 'querying'
  | 'saving'
  | 'loading'

export interface Progress {
  phase: ProgressPhase
  /** 0-1 when known, otherwise -1 for indeterminate. */
  ratio: number
  bytes?: number
  totalBytes?: number
  rows?: number
  message?: string
}

/* ------------------------------------------------------------ wire frames */

export type ToWorker =
  | { id: number; req: Req }
  | { id: number; cancel: true }

export type FromWorker =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; stack?: string }
  | { id: number; progress: Progress }

/** Thrown on the UI thread when a request is cancelled. */
export class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}
