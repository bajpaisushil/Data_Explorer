'use client'
import clsx from 'clsx'
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { ChartsPanel } from '@/components/ChartsPanel'
import { ColumnsPanel } from '@/components/ColumnsPanel'
import { Dropzone } from '@/components/Dropzone'
import { FilterBar } from '@/components/FilterBar'
import { MemoryPanel } from '@/components/MemoryPanel'
import { ProfilePanel } from '@/components/ProfilePanel'
import { StatusBar } from '@/components/StatusBar'
import { TopBar } from '@/components/TopBar'
import { ViewsPanel } from '@/components/ViewsPanel'
import { DataGrid } from '@/components/grid/DataGrid'
import { disposeEngine } from '@/lib/engine/client'
import { selectVisibleColumns, useStore } from '@/lib/state/store'
import type { ColumnMeta, ColumnViewState, RowWindow } from '@/lib/types'

export function Explorer() {
  const meta = useStore((s) => s.meta)
  const panel = useStore((s) => s.panel)
  const toast = useStore((s) => s.toast)

  useEffect(() => () => disposeEngine(), [])

  if (!meta) {
    return (
      <main className="min-h-dvh">
        <Dropzone />
        <Toast toast={toast} />
      </main>
    )
  }

  return (
    <main className="flex h-dvh flex-col overflow-hidden">
      <TopBar />
      <FilterBar />

      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-2 sm:px-4">
        <div className="df-card-raised min-w-0 flex-1 overflow-hidden">
          <GridSurface />
        </div>

        {panel === 'columns' && <ColumnsPanel />}
        {panel === 'profile' && <ProfilePanel />}
        {panel === 'charts' && <ChartsPanel />}
        {panel === 'views' && <ViewsPanel />}
        {panel === 'memory' && <MemoryPanel />}
      </div>

      <StatusBar />
      <Toast toast={toast} />
    </main>
  )
}

/**
 * Feeds the grid. Grouped results are shaped into the same column/window form
 * the grid already renders, so there is only one grid implementation.
 */
function GridSurface() {
  const store = useStore()
  const grouping = !!store.query.group?.columnIds.length

  const flat = useMemo(() => selectVisibleColumns(store), [store])

  const grouped = useMemo(() => {
    if (!grouping || !store.meta || !store.query.group) return null
    const byId = new Map(store.meta.columns.map((c) => [c.id, c]))
    const group = store.query.group

    const columns: ColumnMeta[] = group.columnIds.map((id, i) => {
      const src = byId.get(id)
      return {
        id: `key_${id}`,
        name: src?.name ?? id,
        index: i,
        kind: src?.kind ?? 'string',
        nullCount: 0,
        distinctCount: -1,
        byteSize: 0,
      }
    })
    columns.push({
      id: 'group_count',
      name: 'Rows',
      index: columns.length,
      kind: 'int',
      nullCount: 0,
      distinctCount: -1,
      byteSize: 0,
    })
    for (const agg of group.aggs) {
      columns.push({
        id: `agg_${agg.id}`,
        name: `${agg.fn} of ${byId.get(agg.columnId)?.name ?? agg.columnId}`,
        index: columns.length,
        kind: agg.fn === 'count' || agg.fn === 'distinct' || agg.fn === 'nulls' ? 'int' : 'float',
        nullCount: 0,
        distinctCount: -1,
        byteSize: 0,
      })
    }

    const gw = store.groupWindow
    const window: RowWindow | null = gw
      ? {
          offset: gw.offset,
          rowIds: Uint32Array.from(gw.rows.map((_, i) => gw.offset + i)),
          columnIds: columns.map((c) => c.id),
          columns: columns.map((c, ci) =>
            gw.rows.map((row) => {
              if (ci < group.columnIds.length) return row.keys[ci] ?? null
              if (ci === group.columnIds.length) return row.count
              return row.aggs[ci - group.columnIds.length - 1] ?? null
            }),
          ),
        }
      : null

    const state: Record<string, ColumnViewState> = {}
    for (const c of columns) {
      state[c.id] = { columnId: c.id, width: c.kind === 'string' ? 180 : 130, hidden: false, pinned: false }
    }

    return { columns, window, state }
  }, [grouping, store.meta, store.query.group, store.groupWindow])

  const columns = grouped ? grouped.columns : flat
  const window = grouped ? grouped.window : store.window
  const columnState = grouped ? grouped.state : store.columnState
  const rowCount = grouping ? (store.result?.groupCount ?? 0) : (store.result?.matched ?? 0)

  const sparks = useMemo(() => {
    if (grouping) return {}
    const out: Record<string, number[]> = {}
    for (const [id, p] of Object.entries(store.profiles)) out[id] = p.spark
    return out
  }, [grouping, store.profiles])

  if (store.status === 'error') {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="df-sunken max-w-md px-6 py-8 text-center">
          <AlertTriangle size={22} className="mx-auto mb-2 text-critical" />
          <p className="text-2xs font-semibold text-ink-1">Something went wrong</p>
          <p className="mt-1 text-2xs text-ink-2">{store.error}</p>
        </div>
      </div>
    )
  }

  return (
    <DataGrid
      columns={columns}
      columnState={columnState}
      rowCount={rowCount}
      window={window}
      loading={store.status === 'busy'}
      sorts={store.query.sorts}
      sparks={sparks}
      highlight={store.query.search?.term}
      onRangeChange={store.requestRange}
      onSort={(columnId, additive) => {
        if (grouping && columnId.startsWith('key_')) {
          store.toggleSort(columnId.slice(4), additive)
        } else if (!grouping) {
          store.toggleSort(columnId, additive)
        }
      }}
      onResize={store.resizeColumn}
      onAutoFit={store.autoFitColumn}
      onTogglePin={store.togglePin}
      onHide={store.hideColumn}
      onReorder={store.reorderColumn}
    />
  )
}

function Toast({ toast }: { toast: ReturnType<typeof useStore.getState>['toast'] }) {
  if (!toast) return null
  const Icon = toast.kind === 'error' ? AlertTriangle : toast.kind === 'good' ? CheckCircle2 : Info
  const hue =
    toast.kind === 'error' ? 'var(--critical)' : toast.kind === 'good' ? 'var(--good)' : 'var(--accent)'

  return (
    <div
      role="status"
      aria-live="polite"
      className={clsx(
        'df-card-raised df-pop fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2.5',
        'px-4 py-2.5 shadow-[var(--e3)]',
      )}
    >
      <Icon size={15} style={{ color: hue }} />
      <span className="text-2xs font-medium text-ink-1">{toast.message}</span>
    </div>
  )
}
