/// <reference lib="webworker" />
/**
 * The data worker. It owns every byte of column memory for the loaded dataset;
 * the UI thread never sees more than a screenful of values at a time.
 *
 * Caching matters more than raw speed here: re-sorting is cheap if the filter
 * selection is still valid, so the filter pass is keyed and reused whenever only
 * the sort or the requested window changed.
 */

import { parseBytes } from './parse'
import {
  applyFilters,
  distinctValues,
  extent,
  groupAggregate,
  materializeWindow,
  sortGroups,
  sortSelection,
  toCsv,
  type Dataset,
} from './query'
import { buildChart, computeProfiles, computeStats } from './stats'
import { generateSampleCsv } from '@/lib/sample'
import {
  deleteDataset,
  deleteView,
  estimateQuota,
  isPersistenceAvailable,
  listDatasets,
  listViews,
  loadDataset,
  saveDataset,
  saveView,
} from '@/lib/persist/db'
import type { FromWorker, MemoryReport, Progress, Req, ToWorker } from './protocol'
import type { GroupRow, GroupWindow, QuerySpec } from '@/lib/types'

const ctx = self as unknown as DedicatedWorkerGlobalScope

let dataset: Dataset | null = null
let selection: Uint32Array | null = null
let groups: GroupRow[] | null = null
let spec: QuerySpec | null = null

/** Identity of the filter+search pass that produced `selection`. */
let filterKey = ''
/** Identity of the sort applied on top of it. */
let sortKey = ''

const cancelled = new Set<number>()

function post(msg: FromWorker, transfer?: Transferable[]) {
  if (transfer && transfer.length) ctx.postMessage(msg, transfer)
  else ctx.postMessage(msg)
}

function progressFor(id: number) {
  return (p: Progress) => post({ id, progress: p })
}

function requireDataset(): Dataset {
  if (!dataset) throw new Error('No dataset is loaded')
  return dataset
}

function requireSelection(): Uint32Array {
  if (!selection) throw new Error('No query has been run')
  return selection
}

function keyOf(value: unknown): string {
  return JSON.stringify(value)
}

/** Re-runs only the stages of the pipeline whose inputs actually changed. */
function runQuery(next: QuerySpec, onProgress: (p: Progress) => void) {
  const ds = requireDataset()
  const started = performance.now()

  const nextFilterKey = keyOf([next.filters.filter((f) => f.enabled), next.search])
  const nextSortKey = keyOf(next.sorts)

  if (nextFilterKey !== filterKey || !selection) {
    onProgress({ phase: 'querying', ratio: -1, message: 'Filtering' })
    selection = applyFilters(ds, next.filters, next.search)
    filterKey = nextFilterKey
    sortKey = ''
    groups = null
  }

  if (next.sorts.length && nextSortKey !== sortKey) {
    onProgress({ phase: 'querying', ratio: -1, message: 'Sorting' })
    selection = sortSelection(ds, selection, next.sorts)
  } else if (!next.sorts.length && sortKey !== '') {
    // Dropping the sort means falling back to source order, which is the
    // filter pass's natural output — recompute rather than un-sort.
    selection = applyFilters(ds, next.filters, next.search)
  }
  sortKey = nextSortKey

  const matched = selection.length

  let groupCount: number | null = null
  if (next.group && next.group.columnIds.length) {
    onProgress({ phase: 'querying', ratio: -1, message: 'Grouping' })
    groups = sortGroups(groupAggregate(ds, selection, next.group), next.group, next.sorts)
    groupCount = groups.length
  } else {
    groups = null
  }

  spec = next
  return {
    matched,
    total: ds.meta.rowCount,
    groupCount,
    elapsedMs: performance.now() - started,
  }
}

function groupWindow(offset: number, limit: number): GroupWindow {
  if (!groups || !spec?.group) throw new Error('No grouping is active')
  const start = Math.max(0, Math.min(offset, groups.length))
  const end = Math.min(groups.length, start + Math.max(0, limit))
  return {
    offset: start,
    rows: groups.slice(start, end),
    columnIds: spec.group.columnIds,
    aggIds: spec.group.aggs.map((a) => a.id),
  }
}

function memoryReport(): MemoryReport {
  const ds = requireDataset()
  let naive = 0
  const columns = ds.meta.columns.map((c, i) => {
    const col = ds.columns[i]
    // What the same column would cost as plain JS values: 8 bytes per number in
    // a boxed array slot, or a 2-bytes-per-char string plus header per row.
    naive +=
      c.kind === 'string'
        ? ds.meta.rowCount * 40
        : ds.meta.rowCount * 8 + ds.meta.rowCount * 8
    return {
      columnId: c.id,
      name: c.name,
      bytes: c.byteSize,
      encoding: c.kind === 'string' ? (col.kind === 'string' ? col.encoding : 'dict') : c.kind,
    }
  })
  return { rowCount: ds.meta.rowCount, totalBytes: ds.meta.byteSize, columns, naiveBytes: naive }
}

function resetState() {
  selection = null
  groups = null
  spec = null
  filterKey = ''
  sortKey = ''
}

async function handle(id: number, req: Req): Promise<unknown> {
  const onProgress = progressFor(id)

  switch (req.kind) {
    case 'parseFile': {
      onProgress({ phase: 'reading', ratio: 0, totalBytes: req.file.size })
      const buffer = await req.file.arrayBuffer()
      onProgress({ phase: 'reading', ratio: 1, bytes: buffer.byteLength, totalBytes: buffer.byteLength })
      const parsed = await parseBytes(new Uint8Array(buffer), req.file.name, req.options ?? {}, onProgress)
      dataset = { meta: parsed.meta, columns: parsed.columns }
      resetState()
      return parsed.meta
    }

    case 'parseBuffer': {
      const parsed = await parseBytes(new Uint8Array(req.buffer), req.name, req.options ?? {}, onProgress)
      dataset = { meta: parsed.meta, columns: parsed.columns }
      resetState()
      return parsed.meta
    }

    case 'generateSample': {
      onProgress({ phase: 'generating', ratio: 0, rows: req.rows })
      const bytes = generateSampleCsv(req.presetId, req.rows, (ratio) =>
        onProgress({ phase: 'generating', ratio, rows: req.rows }),
      )
      const parsed = await parseBytes(bytes, `${req.presetId}.csv`, {}, onProgress)
      dataset = { meta: parsed.meta, columns: parsed.columns }
      resetState()
      return parsed.meta
    }

    case 'query':
      return runQuery(req.spec, onProgress)

    case 'rowWindow':
      return materializeWindow(requireDataset(), requireSelection(), req.offset, req.limit, req.columnIds)

    case 'groupWindow':
      return groupWindow(req.offset, req.limit)

    case 'stats':
      return computeStats(requireDataset(), requireSelection(), req.columnId, req.bins)

    case 'profile':
      return computeProfiles(requireDataset(), requireSelection(), req.columnIds, req.bins)

    case 'chart':
      return buildChart(requireDataset(), requireSelection(), req.spec)

    case 'distinct': {
      const ds = requireDataset()
      const sel = req.global ? allRows(ds.meta.rowCount) : requireSelection()
      return distinctValues(ds, sel, req.columnId, req.limit, req.search)
    }

    case 'extent':
      return extent(requireDataset(), req.columnId)

    case 'exportCsv': {
      const bytes = toCsv(requireDataset(), requireSelection(), req.columnIds, req.limit)
      return { bytes, rows: Math.min(req.limit || Infinity, requireSelection().length) }
    }

    case 'persistDataset': {
      const ds = requireDataset()
      onProgress({ phase: 'saving', ratio: 0 })
      const res = await saveDataset(ds.meta, ds.columns, (ratio) => onProgress({ phase: 'saving', ratio }))
      return res
    }

    case 'loadDataset': {
      onProgress({ phase: 'loading', ratio: 0 })
      const loaded = await loadDataset(req.datasetId, (ratio) => onProgress({ phase: 'loading', ratio }))
      if (!loaded) throw new Error('That dataset is no longer in local storage')
      dataset = loaded
      resetState()
      return loaded.meta
    }

    case 'listDatasets':
      return isPersistenceAvailable() ? await listDatasets() : []

    case 'deleteDataset':
      await deleteDataset(req.datasetId)
      return { ok: true }

    case 'saveView':
      await saveView(req.view)
      return { ok: true }

    case 'listViews':
      return isPersistenceAvailable() ? await listViews(req.datasetId) : []

    case 'deleteView':
      await deleteView(req.viewId)
      return { ok: true }

    case 'memoryReport':
      return memoryReport()

    case 'dispose':
      dataset = null
      resetState()
      return { ok: true }
  }
}

/** A selection covering every row, for "unfiltered" questions like filter operands. */
let allRowsCache: Uint32Array | null = null
function allRows(n: number): Uint32Array {
  if (!allRowsCache || allRowsCache.length !== n) {
    allRowsCache = new Uint32Array(n)
    for (let i = 0; i < n; i++) allRowsCache[i] = i
  }
  return allRowsCache
}

ctx.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const msg = event.data
  if ('cancel' in msg) {
    cancelled.add(msg.id)
    return
  }

  const { id, req } = msg
  void (async () => {
    try {
      const result = await handle(id, req)
      if (cancelled.has(id)) {
        cancelled.delete(id)
        return
      }
      const transfer: Transferable[] = []
      if (result && typeof result === 'object' && 'bytes' in result) {
        const bytes = (result as { bytes: Uint8Array }).bytes
        if (bytes instanceof Uint8Array) transfer.push(bytes.buffer as ArrayBuffer)
      }
      post({ id, ok: true, result }, transfer)
    } catch (err) {
      cancelled.delete(id)
      const e = err as Error
      post({ id, ok: false, error: e?.message ?? String(err), stack: e?.stack })
    }
  })()
})

// Lets the UI know the worker booted, so a failed module load surfaces as an
// error rather than a request that never resolves.
post({ id: -1, ok: true, result: { ready: true } })

export {}
