'use client'
/**
 * Application state. The store owns the query spec and the view state; the
 * worker owns the data. Every data-shaped field here (window, profiles, charts)
 * is a cache of a worker answer, invalidated by a monotonically increasing
 * generation so a slow response can never overwrite a newer one.
 */

import { create } from 'zustand'
import { getEngine } from '@/lib/engine/client'
import { CancelledError, type Progress } from '@/lib/engine/protocol'
import {
  EMPTY_QUERY,
  type ChartData,
  type ChartSpec,
  type ColumnMeta,
  type ColumnProfile,
  type ColumnViewState,
  type DatasetMeta,
  type Filter,
  type GroupSpec,
  type GroupWindow,
  type QueryResult,
  type QuerySpec,
  type RowWindow,
  type SavedView,
  type SortSpec,
} from '@/lib/types'

export type Panel = 'profile' | 'charts' | 'columns' | 'views' | 'memory' | null
export type Status = 'empty' | 'busy' | 'ready' | 'error'

export interface StoredDataset {
  id: string
  name: string
  rowCount: number
  createdAt: number
  bytes: number
}

const DEFAULT_WIDTH = 140
const WINDOW_PAD = 200

function defaultColumnState(columns: ColumnMeta[]): Record<string, ColumnViewState> {
  const state: Record<string, ColumnViewState> = {}
  for (const c of columns) {
    state[c.id] = {
      columnId: c.id,
      width: c.kind === 'string' ? 180 : c.kind === 'date' ? 160 : DEFAULT_WIDTH,
      hidden: false,
      pinned: false,
    }
  }
  return state
}

interface State {
  status: Status
  progress: Progress | null
  error: string | null
  meta: DatasetMeta | null

  query: QuerySpec
  result: QueryResult | null
  window: RowWindow | null
  groupWindow: GroupWindow | null
  /** Row range the grid has asked for, so a refetch can restore it. */
  range: { start: number; end: number }

  columnOrder: string[]
  columnState: Record<string, ColumnViewState>
  profiles: Record<string, ColumnProfile>
  profilesStale: boolean

  charts: ChartSpec[]
  chartData: Record<string, ChartData>

  savedViews: SavedView[]
  storedDatasets: StoredDataset[]

  panel: Panel
  focusedColumnId: string | null
  theme: 'light' | 'dark' | 'system'
  persisting: boolean
  toast: { kind: 'info' | 'error' | 'good'; message: string } | null
}

interface Actions {
  loadFile: (file: File) => Promise<void>
  loadBuffer: (name: string, buffer: ArrayBuffer) => Promise<void>
  loadSample: (presetId: string, rows: number) => Promise<void>
  closeDataset: () => void

  setSearch: (term: string) => void
  addFilter: (filter: Filter) => void
  updateFilter: (id: string, patch: Partial<Filter>) => void
  removeFilter: (id: string) => void
  clearFilters: () => void
  toggleSort: (columnId: string, additive: boolean) => void
  setSorts: (sorts: SortSpec[]) => void
  setGroup: (group: GroupSpec | null) => void

  requestRange: (start: number, end: number) => void
  refreshProfiles: () => Promise<void>

  resizeColumn: (columnId: string, width: number) => void
  autoFitColumn: (columnId: string) => void
  hideColumn: (columnId: string) => void
  showColumn: (columnId: string) => void
  showAllColumns: () => void
  togglePin: (columnId: string) => void
  reorderColumn: (columnId: string, toIndex: number) => void

  addChart: (spec: ChartSpec) => void
  updateChart: (id: string, patch: Partial<ChartSpec>) => void
  removeChart: (id: string) => void
  refreshChart: (id: string) => Promise<void>

  saveCurrentView: (name: string) => Promise<void>
  applyView: (view: SavedView) => void
  deleteSavedView: (id: string) => Promise<void>
  refreshSavedViews: () => Promise<void>

  persistDataset: () => Promise<void>
  refreshStoredDatasets: () => Promise<void>
  openStoredDataset: (id: string) => Promise<void>
  deleteStoredDataset: (id: string) => Promise<void>

  exportCsv: () => Promise<void>

  setPanel: (panel: Panel) => void
  setFocusedColumn: (columnId: string | null) => void
  setTheme: (theme: 'light' | 'dark' | 'system') => void
  notify: (kind: 'info' | 'error' | 'good', message: string) => void
}

export type Store = State & Actions

/** Bumped on every query; responses from an older generation are discarded. */
let generation = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null
let rangeToken = 0

const initial: State = {
  status: 'empty',
  progress: null,
  error: null,
  meta: null,
  query: EMPTY_QUERY,
  result: null,
  window: null,
  groupWindow: null,
  range: { start: 0, end: 0 },
  columnOrder: [],
  columnState: {},
  profiles: {},
  profilesStale: true,
  charts: [],
  chartData: {},
  savedViews: [],
  storedDatasets: [],
  panel: null,
  focusedColumnId: null,
  theme: 'system',
  persisting: false,
  toast: null,
}

export const useStore = create<Store>((set, get) => {
  /** Visible columns in display order, pinned ones first. */
  function visibleColumnIds(): string[] {
    const { columnOrder, columnState } = get()
    const shown = columnOrder.filter((id) => !columnState[id]?.hidden)
    return [
      ...shown.filter((id) => columnState[id]?.pinned),
      ...shown.filter((id) => !columnState[id]?.pinned),
    ]
  }

  async function runQuery() {
    const gen = ++generation
    const { query } = get()
    set({ status: 'busy', error: null })
    try {
      const result = await getEngine().request({ kind: 'query', spec: query })
      if (gen !== generation) return
      set({ result, status: 'ready', profilesStale: true, window: null, groupWindow: null })
      const { range } = get()
      await fetchRange(range.start, Math.max(range.end, range.start + 60), gen)
      if (gen !== generation) return
      void refreshAllCharts()
      void get().refreshProfiles()
    } catch (err) {
      if (err instanceof CancelledError || gen !== generation) return
      set({ status: 'error', error: (err as Error).message })
    }
  }

  async function fetchRange(start: number, end: number, gen: number) {
    const { query, result } = get()
    if (!result) return
    const grouping = !!query.group?.columnIds.length
    const total = grouping ? (result.groupCount ?? 0) : result.matched
    const from = Math.max(0, Math.min(start, Math.max(0, total - 1)))
    const limit = Math.max(1, Math.min(end - from + WINDOW_PAD, 2000))

    try {
      if (grouping) {
        const gw = await getEngine().request({ kind: 'groupWindow', offset: from, limit })
        if (gen !== generation) return
        set({ groupWindow: gw, window: null })
      } else {
        const rw = await getEngine().request({
          kind: 'rowWindow',
          offset: from,
          limit,
          columnIds: visibleColumnIds(),
        })
        if (gen !== generation) return
        set({ window: rw, groupWindow: null })
      }
    } catch (err) {
      if (err instanceof CancelledError || gen !== generation) return
      set({ error: (err as Error).message })
    }
  }

  async function refreshAllCharts() {
    const specs = get().charts
    for (const spec of specs) await get().refreshChart(spec.id)
  }

  function afterQueryChange() {
    set({ range: { start: 0, end: 60 } })
    void runQuery()
  }

  return {
    ...initial,

    async loadFile(file) {
      set({ status: 'busy', error: null, progress: { phase: 'reading', ratio: 0 } })
      try {
        const meta = await getEngine().request(
          { kind: 'parseFile', file },
          { onProgress: (progress) => set({ progress }) },
        )
        adoptDataset(meta)
      } catch (err) {
        set({ status: 'error', progress: null, error: (err as Error).message })
      }
    },

    async loadBuffer(name, buffer) {
      set({ status: 'busy', error: null, progress: { phase: 'parsing', ratio: 0 } })
      try {
        const meta = await getEngine().request(
          { kind: 'parseBuffer', name, buffer },
          { onProgress: (progress) => set({ progress }) },
        )
        adoptDataset(meta)
      } catch (err) {
        set({ status: 'error', progress: null, error: (err as Error).message })
      }
    },

    async loadSample(presetId, rows) {
      set({ status: 'busy', error: null, progress: { phase: 'generating', ratio: 0, rows } })
      try {
        const meta = await getEngine().request(
          { kind: 'generateSample', presetId, rows },
          { onProgress: (progress) => set({ progress }) },
        )
        adoptDataset(meta)
      } catch (err) {
        set({ status: 'error', progress: null, error: (err as Error).message })
      }
    },

    closeDataset() {
      generation++
      void getEngine().request({ kind: 'dispose' }).catch(() => {})
      set({ ...initial, theme: get().theme, storedDatasets: get().storedDatasets })
    },

    setSearch(term) {
      const trimmed = term
      set((s) => ({
        query: {
          ...s.query,
          search: trimmed ? { term: trimmed, columnIds: null, caseSensitive: false } : null,
        },
      }))
      if (searchTimer) clearTimeout(searchTimer)
      searchTimer = setTimeout(afterQueryChange, 180)
    },

    addFilter(filter) {
      set((s) => ({ query: { ...s.query, filters: [...s.query.filters, filter] } }))
      afterQueryChange()
    },

    updateFilter(id, patch) {
      set((s) => ({
        query: {
          ...s.query,
          filters: s.query.filters.map((f) => (f.id === id ? { ...f, ...patch } : f)),
        },
      }))
      afterQueryChange()
    },

    removeFilter(id) {
      set((s) => ({ query: { ...s.query, filters: s.query.filters.filter((f) => f.id !== id) } }))
      afterQueryChange()
    },

    clearFilters() {
      set((s) => ({ query: { ...s.query, filters: [], search: null } }))
      afterQueryChange()
    },

    toggleSort(columnId, additive) {
      const sorts = get().query.sorts
      const existing = sorts.find((s) => s.columnId === columnId)
      let next: SortSpec[]
      if (!existing) {
        next = additive ? [...sorts, { columnId, dir: 'asc' }] : [{ columnId, dir: 'asc' }]
      } else if (existing.dir === 'asc') {
        next = sorts.map((s) => (s.columnId === columnId ? { ...s, dir: 'desc' as const } : s))
        if (!additive) next = next.filter((s) => s.columnId === columnId)
      } else {
        next = sorts.filter((s) => s.columnId !== columnId)
      }
      set((s) => ({ query: { ...s.query, sorts: next } }))
      afterQueryChange()
    },

    setSorts(sorts) {
      set((s) => ({ query: { ...s.query, sorts } }))
      afterQueryChange()
    },

    setGroup(group) {
      set((s) => ({ query: { ...s.query, group } }))
      afterQueryChange()
    },

    requestRange(start, end) {
      set({ range: { start, end } })
      const token = ++rangeToken
      const gen = generation
      // One frame of coalescing: a flick scroll fires dozens of these.
      requestAnimationFrame(() => {
        if (token !== rangeToken) return
        void fetchRange(start, end, gen)
      })
    },

    async refreshProfiles() {
      const { meta, result } = get()
      if (!meta || !result) return
      const gen = generation
      try {
        const profiles = await getEngine().request({
          kind: 'profile',
          columnIds: meta.columns.map((c) => c.id),
        })
        if (gen !== generation) return
        const byId: Record<string, ColumnProfile> = {}
        for (const p of profiles) byId[p.columnId] = p
        set({ profiles: byId, profilesStale: false })
      } catch {
        // Profiling is an enhancement; a failure must not break the grid.
      }
    },

    resizeColumn(columnId, width) {
      set((s) => ({
        columnState: {
          ...s.columnState,
          [columnId]: { ...s.columnState[columnId], width: Math.max(56, Math.min(800, width)) },
        },
      }))
    },

    autoFitColumn(columnId) {
      const { meta, window: win } = get()
      const col = meta?.columns.find((c) => c.id === columnId)
      if (!col) return
      let longest = col.name.length + 6
      const idx = win?.columnIds.indexOf(columnId) ?? -1
      if (win && idx >= 0) {
        for (const v of win.columns[idx]) {
          const len = v === null ? 1 : String(v).length
          if (len > longest) longest = len
        }
      }
      get().resizeColumn(columnId, Math.min(420, 24 + longest * 7.2))
    },

    hideColumn(columnId) {
      set((s) => ({
        columnState: { ...s.columnState, [columnId]: { ...s.columnState[columnId], hidden: true } },
      }))
      void fetchRange(get().range.start, get().range.end, generation)
    },

    showColumn(columnId) {
      set((s) => ({
        columnState: { ...s.columnState, [columnId]: { ...s.columnState[columnId], hidden: false } },
      }))
      void fetchRange(get().range.start, get().range.end, generation)
    },

    showAllColumns() {
      set((s) => {
        const next: Record<string, ColumnViewState> = {}
        for (const [id, cs] of Object.entries(s.columnState)) next[id] = { ...cs, hidden: false }
        return { columnState: next }
      })
      void fetchRange(get().range.start, get().range.end, generation)
    },

    togglePin(columnId) {
      set((s) => ({
        columnState: {
          ...s.columnState,
          [columnId]: { ...s.columnState[columnId], pinned: !s.columnState[columnId]?.pinned },
        },
      }))
      void fetchRange(get().range.start, get().range.end, generation)
    },

    reorderColumn(columnId, toIndex) {
      set((s) => {
        const order = s.columnOrder.filter((id) => id !== columnId)
        order.splice(Math.max(0, Math.min(toIndex, order.length)), 0, columnId)
        return { columnOrder: order }
      })
      void fetchRange(get().range.start, get().range.end, generation)
    },

    addChart(spec) {
      set((s) => ({ charts: [...s.charts, spec] }))
      void get().refreshChart(spec.id)
    },

    updateChart(id, patch) {
      set((s) => ({ charts: s.charts.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))
      void get().refreshChart(id)
    },

    removeChart(id) {
      set((s) => {
        const chartData = { ...s.chartData }
        delete chartData[id]
        return { charts: s.charts.filter((c) => c.id !== id), chartData }
      })
    },

    async refreshChart(id) {
      const spec = get().charts.find((c) => c.id === id)
      if (!spec || !get().result) return
      const gen = generation
      try {
        const data = await getEngine().request({ kind: 'chart', spec })
        if (gen !== generation) return
        set((s) => ({ chartData: { ...s.chartData, [id]: data } }))
      } catch (err) {
        if (err instanceof CancelledError) return
        get().notify('error', `Chart failed: ${(err as Error).message}`)
      }
    },

    async saveCurrentView(name) {
      const { meta, query, columnOrder, columnState, charts } = get()
      if (!meta) return
      const view: SavedView = {
        id: `view_${Date.now().toString(36)}`,
        datasetId: meta.id,
        name,
        createdAt: Date.now(),
        query,
        columnOrder,
        columnState,
        charts,
      }
      try {
        await getEngine().request({ kind: 'saveView', view })
        await get().refreshSavedViews()
        get().notify('good', `Saved view "${name}"`)
      } catch (err) {
        get().notify('error', (err as Error).message)
      }
    },

    applyView(view) {
      set({
        query: view.query,
        columnOrder: view.columnOrder,
        columnState: view.columnState,
        charts: view.charts,
        chartData: {},
      })
      afterQueryChange()
    },

    async deleteSavedView(id) {
      await getEngine().request({ kind: 'deleteView', viewId: id })
      await get().refreshSavedViews()
    },

    async refreshSavedViews() {
      const meta = get().meta
      if (!meta) return
      try {
        set({ savedViews: await getEngine().request({ kind: 'listViews', datasetId: meta.id }) })
      } catch {
        set({ savedViews: [] })
      }
    },

    async persistDataset() {
      set({ persisting: true })
      try {
        const res = await getEngine().request(
          { kind: 'persistDataset' },
          { onProgress: (progress) => set({ progress }) },
        )
        await get().refreshStoredDatasets()
        get().notify('good', `Saved to this browser (${(res.bytes / 1e6).toFixed(1)} MB)`)
      } catch (err) {
        get().notify('error', (err as Error).message)
      } finally {
        set({ persisting: false, progress: null })
      }
    },

    async refreshStoredDatasets() {
      try {
        set({ storedDatasets: await getEngine().request({ kind: 'listDatasets' }) })
      } catch {
        set({ storedDatasets: [] })
      }
    },

    async openStoredDataset(id) {
      set({ status: 'busy', error: null, progress: { phase: 'loading', ratio: 0 } })
      try {
        const meta = await getEngine().request(
          { kind: 'loadDataset', datasetId: id },
          { onProgress: (progress) => set({ progress }) },
        )
        adoptDataset(meta)
      } catch (err) {
        set({ status: 'error', progress: null, error: (err as Error).message })
      }
    },

    async deleteStoredDataset(id) {
      await getEngine().request({ kind: 'deleteDataset', datasetId: id })
      await get().refreshStoredDatasets()
    },

    async exportCsv() {
      const { result, query } = get()
      if (!result) return
      try {
        const res = await getEngine().request({
          kind: 'exportCsv',
          columnIds: visibleColumnIds(),
          limit: query.group ? 0 : Math.min(result.matched, 1_000_000),
        })
        const blob = new Blob([res.bytes as BlobPart], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${get().meta?.name.replace(/\.[^.]+$/, '') ?? 'dataforge'}-filtered.csv`
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        get().notify('good', `Exported ${res.rows.toLocaleString('en-US')} rows`)
      } catch (err) {
        get().notify('error', (err as Error).message)
      }
    },

    setPanel(panel) {
      set((s) => ({ panel: s.panel === panel ? null : panel }))
    },

    setFocusedColumn(columnId) {
      set({ focusedColumnId: columnId })
    },

    setTheme(theme) {
      set({ theme })
      try {
        if (theme === 'system') {
          localStorage.removeItem('dataforge.theme')
          document.documentElement.removeAttribute('data-theme')
        } else {
          localStorage.setItem('dataforge.theme', theme)
          document.documentElement.setAttribute('data-theme', theme)
        }
      } catch {
        // Storage can be unavailable in private mode; the in-memory theme still applies.
      }
    },

    notify(kind, message) {
      set({ toast: { kind, message } })
      setTimeout(() => {
        if (get().toast?.message === message) set({ toast: null })
      }, 4000)
    },
  }

  function adoptDataset(meta: DatasetMeta) {
    set({
      meta,
      status: 'ready',
      progress: null,
      error: null,
      query: EMPTY_QUERY,
      result: null,
      window: null,
      groupWindow: null,
      range: { start: 0, end: 60 },
      columnOrder: meta.columns.map((c) => c.id),
      columnState: defaultColumnState(meta.columns),
      profiles: {},
      profilesStale: true,
      charts: [],
      chartData: {},
      panel: null,
      focusedColumnId: meta.columns[0]?.id ?? null,
    })
    void runQuery()
    void get().refreshSavedViews()
    void get().refreshStoredDatasets()
  }
})

/** Columns the grid should render, in display order. */
export function selectVisibleColumns(s: Store): ColumnMeta[] {
  if (!s.meta) return []
  const byId = new Map(s.meta.columns.map((c) => [c.id, c]))
  const shown = s.columnOrder.filter((id) => !s.columnState[id]?.hidden)
  const ordered = [
    ...shown.filter((id) => s.columnState[id]?.pinned),
    ...shown.filter((id) => !s.columnState[id]?.pinned),
  ]
  return ordered.map((id) => byId.get(id)).filter((c): c is ColumnMeta => !!c)
}
