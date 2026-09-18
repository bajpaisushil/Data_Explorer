'use client'
/**
 * Virtualized data grid.
 *
 * Rows and columns are both virtualized: the DOM holds roughly one screenful
 * regardless of whether the result set is 50 rows or 5,000,000, and a 200-column
 * CSV only mounts the columns actually on screen.
 *
 * THE MAX-HEIGHT PROBLEM. A million rows at 32px is 32,000,000px of scroll
 * height, which is past the element-height ceiling in several engines (Firefox
 * caps around 17.8M). So the scroll spacer is capped at MAX_SPACER and the
 * browser's scrollTop is mapped proportionally onto the true virtual offset:
 *
 *     virtual = scrollTop / (spacer - viewport) * (total - viewport)
 *
 * That mapping is exact at both ends — scrollTop 0 lands on row 0, and a fully
 * scrolled container lands precisely on the last row — so the only thing lost
 * is scroll *resolution* in the extreme middle, where one pixel covers more
 * than one row. Rows are therefore positioned against the viewport (a sticky,
 * zero-height layer) rather than inside the spacer, since the two coordinate
 * spaces diverge once scaling kicks in.
 */
import clsx from 'clsx'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { HeaderCell } from './HeaderCell'
import { useVariableVirtualRange } from './useVirtualRange'
import { formatCell } from '@/lib/format'
import type { CellValue, ColumnMeta, ColumnViewState, RowWindow, SortSpec } from '@/lib/types'

export const GRID_OVERSCAN = 8

/** Comfortably below the element-height ceiling of every current engine. */
const MAX_SPACER = 8_000_000
const HEADER_HEIGHT = 38
const DEFAULT_ROW_HEIGHT = 32

export interface DataGridProps {
  columns: ColumnMeta[]
  columnState: Record<string, ColumnViewState>
  rowCount: number
  window: RowWindow | null
  loading: boolean
  sorts: SortSpec[]
  sparks?: Record<string, number[]>
  highlight?: string
  onRangeChange: (start: number, end: number) => void
  onSort: (columnId: string, additive: boolean) => void
  onResize: (columnId: string, width: number) => void
  onAutoFit: (columnId: string) => void
  onTogglePin: (columnId: string) => void
  onHide: (columnId: string) => void
  onReorder: (columnId: string, toIndex: number) => void
  onCellClick?: (rowId: number, columnId: string, value: CellValue) => void
  rowHeight?: number
}

export function DataGrid({
  columns,
  columnState,
  rowCount,
  window: rowWindow,
  loading,
  sorts,
  sparks,
  highlight,
  onRangeChange,
  onSort,
  onResize,
  onAutoFit,
  onTogglePin,
  onHide,
  onReorder,
  onCellClick,
  rowHeight = DEFAULT_ROW_HEIGHT,
}: DataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef(0)
  const lastRangeRef = useRef('')

  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [scroll, setScroll] = useState({ top: 0, left: 0 })
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [focus, setFocus] = useState({ row: 0, col: 0 })

  const pinned = useMemo(() => columns.filter((c) => columnState[c.id]?.pinned), [columns, columnState])
  const scrolling = useMemo(() => columns.filter((c) => !columnState[c.id]?.pinned), [columns, columnState])

  const widthOf = useCallback(
    (c: ColumnMeta) => columnState[c.id]?.width ?? 140,
    [columnState],
  )

  const pinnedWidth = useMemo(() => pinned.reduce((sum, c) => sum + widthOf(c), 0), [pinned, widthOf])
  const scrollSizes = useMemo(() => scrolling.map(widthOf), [scrolling, widthOf])

  const colRange = useVariableVirtualRange({
    sizes: scrollSizes,
    viewport: Math.max(0, viewport.width - pinnedWidth),
    scroll: scroll.left,
    overscan: 2,
  })

  /* ------------------------------------------------------ vertical mapping */

  const totalHeight = rowCount * rowHeight
  const spacerHeight = Math.min(totalHeight, MAX_SPACER)
  const scaled = spacerHeight < totalHeight

  const bodyViewport = Math.max(0, viewport.height - HEADER_HEIGHT)
  const virtualTop = useMemo(() => {
    if (!scaled) return scroll.top
    // The denominator is the browser's OWN scroll range, which is
    // scrollHeight - clientHeight; the numerator maps onto the row area, which
    // is the viewport minus the sticky header. Mixing the two leaves the last
    // few rows unreachable at full scroll.
    const spacerRange = Math.max(1, spacerHeight - viewport.height)
    const virtualRange = Math.max(0, totalHeight - bodyViewport)
    return Math.min(virtualRange, (scroll.top / spacerRange) * virtualRange)
  }, [scaled, scroll.top, spacerHeight, viewport.height, bodyViewport, totalHeight])

  /** Inverse of the mapping above, for programmatic scrolling. */
  const toScrollTop = useCallback(
    (wantVirtualTop: number) => {
      if (!scaled) return wantVirtualTop
      const virtualRange = Math.max(1, totalHeight - bodyViewport)
      const spacerRange = Math.max(0, spacerHeight - viewport.height)
      return (wantVirtualTop / virtualRange) * spacerRange
    },
    [scaled, totalHeight, bodyViewport, spacerHeight, viewport.height],
  )

  const firstRow = Math.max(0, Math.floor(virtualTop / rowHeight) - GRID_OVERSCAN)
  const visibleRows = Math.ceil(bodyViewport / rowHeight) + GRID_OVERSCAN * 2
  const lastRow = Math.min(rowCount, firstRow + visibleRows + 1)

  /* --------------------------------------------------------------- layout */

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setViewport({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Scroll position lives in a ref and is committed once per frame, so a flick
  // scroll produces one React render per frame rather than one per event.
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      setScroll({ top: el.scrollTop, left: el.scrollLeft })
    })
  }, [])

  useEffect(() => () => cancelAnimationFrame(frameRef.current), [])

  // Ask for data only when the range actually changes.
  useEffect(() => {
    if (rowCount === 0) return
    const key = `${firstRow}:${lastRow}`
    if (key === lastRangeRef.current) return
    lastRangeRef.current = key
    onRangeChange(firstRow, lastRow)
  }, [firstRow, lastRow, rowCount, onRangeChange])

  /* ------------------------------------------------------------- keyboard */

  const move = useCallback(
    (dRow: number, dCol: number, absolute?: 'first' | 'last') => {
      setFocus((f) => {
        const row = absolute === 'first' ? 0 : absolute === 'last' ? rowCount - 1 : f.row + dRow
        const next = {
          row: Math.max(0, Math.min(rowCount - 1, row)),
          col: Math.max(0, Math.min(columns.length - 1, f.col + dCol)),
        }
        const el = scrollRef.current
        if (el) {
          const targetTop = next.row * rowHeight
          if (targetTop < virtualTop) {
            el.scrollTop = toScrollTop(targetTop)
          } else if (targetTop > virtualTop + bodyViewport - rowHeight) {
            el.scrollTop = toScrollTop(targetTop - bodyViewport + rowHeight)
          }
        }
        return next
      })
    },
    [rowCount, columns.length, rowHeight, virtualTop, bodyViewport, toScrollTop],
  )

  const onKeyDown = (e: React.KeyboardEvent) => {
    const page = Math.max(1, Math.floor(bodyViewport / rowHeight) - 1)
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1, 0); break
      case 'ArrowUp': e.preventDefault(); move(-1, 0); break
      case 'ArrowRight': e.preventDefault(); move(0, 1); break
      case 'ArrowLeft': e.preventDefault(); move(0, -1); break
      case 'PageDown': e.preventDefault(); move(page, 0); break
      case 'PageUp': e.preventDefault(); move(-page, 0); break
      case 'Home':
        e.preventDefault()
        if (e.ctrlKey || e.metaKey) move(0, 0, 'first')
        else setFocus((f) => ({ ...f, col: 0 }))
        break
      case 'End':
        e.preventDefault()
        if (e.ctrlKey || e.metaKey) move(0, 0, 'last')
        else setFocus((f) => ({ ...f, col: columns.length - 1 }))
        break
      default:
        return
    }
  }

  /* ----------------------------------------------------------------- data */

  const windowStart = rowWindow?.offset ?? 0
  const windowEnd = windowStart + (rowWindow?.rowIds.length ?? 0)
  const columnPos = useMemo(() => {
    const map = new Map<string, number>()
    rowWindow?.columnIds.forEach((id, i) => map.set(id, i))
    return map
  }, [rowWindow])

  const valueAt = useCallback(
    (row: number, columnId: string): CellValue | undefined => {
      if (!rowWindow || row < windowStart || row >= windowEnd) return undefined
      const ci = columnPos.get(columnId)
      if (ci === undefined) return undefined
      return rowWindow.columns[ci]?.[row - windowStart]
    },
    [rowWindow, windowStart, windowEnd, columnPos],
  )

  const colIndexOf = useMemo(() => {
    const map = new Map<string, number>()
    columns.forEach((c, i) => map.set(c.id, i))
    return map
  }, [columns])

  const sortIndexOf = useCallback(
    (columnId: string) => sorts.findIndex((s) => s.columnId === columnId),
    [sorts],
  )

  const renderHeader = (list: ColumnMeta[], offset: number) =>
    list.map((c, i) => {
      const idx = sortIndexOf(c.id)
      return (
        <HeaderCell
          key={c.id}
          column={c}
          width={widthOf(c)}
          pinned={!!columnState[c.id]?.pinned}
          sortIndex={idx}
          sort={idx >= 0 ? sorts[idx] : undefined}
          spark={sparks?.[c.id]}
          onSort={(additive) => onSort(c.id, additive)}
          onResize={(w) => onResize(c.id, w)}
          onAutoFit={() => onAutoFit(c.id)}
          onTogglePin={() => onTogglePin(c.id)}
          onHide={() => onHide(c.id)}
          onDragStart={() => setDragId(c.id)}
          onDrop={() => {
            if (dragId && dragId !== c.id) onReorder(dragId, offset + i)
            setDragId(null)
            setDropIndex(null)
          }}
          dropTarget={dropIndex === offset + i}
        />
      )
    })

  const rows: number[] = []
  for (let r = firstRow; r < lastRow; r++) rows.push(r)

  const shadow = scroll.left > 0 && pinned.length > 0

  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-rowcount={rowCount}
      aria-colcount={columns.length}
      tabIndex={0}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      className="relative h-full w-full overflow-auto outline-none"
    >
      {/* Header: sticky in both axes so pinned columns stay put horizontally. */}
      <div
        role="row"
        aria-rowindex={1}
        className="sticky top-0 z-30 flex w-max min-w-full bg-surface-1/95 backdrop-blur"
        style={{ height: HEADER_HEIGHT }}
      >
        {pinned.length > 0 && (
          <div
            className={clsx('sticky left-0 z-10 flex bg-surface-1/95', shadow && 'shadow-[6px_0_12px_-8px_rgba(48,40,82,0.45)]')}
            style={{ width: pinnedWidth }}
          >
            {renderHeader(pinned, 0)}
          </div>
        )}
        <div className="flex" style={{ width: colRange.totalSize }}>
          <div style={{ width: colRange.offsetBefore }} />
          {renderHeader(scrolling.slice(colRange.start, colRange.end), pinned.length + colRange.start)}
        </div>
      </div>
      <div className="sticky top-0 z-20 h-px w-full bg-line-1" style={{ marginTop: -1 }} />

      {rowCount === 0 ? (
        <div className="flex items-center justify-center py-16">
          <p className="text-2xs text-ink-3">{loading ? 'Working…' : 'No rows match these filters'}</p>
        </div>
      ) : (
        rows.map((r) => {
          // Position in the viewport, then translate into content coordinates by
          // adding scrollTop. Once the spacer is scaled these two spaces diverge,
          // so rows must be anchored to the viewport rather than to the spacer.
          const viewportTop = HEADER_HEIGHT + r * rowHeight - virtualTop
          if (viewportTop < -rowHeight || viewportTop > viewport.height + rowHeight) return null
          return (
            <Row
              key={r}
              rowIndex={r}
              top={scroll.top + viewportTop}
              height={rowHeight}
              pinned={pinned}
              scrolling={scrolling.slice(colRange.start, colRange.end)}
              offsetBefore={colRange.offsetBefore}
              pinnedWidth={pinnedWidth}
              totalWidth={colRange.totalSize}
              widthOf={widthOf}
              valueAt={valueAt}
              loaded={r >= windowStart && r < windowEnd}
              highlight={highlight}
              shadow={shadow}
              focusedCol={focus.row === r ? focus.col : -1}
              colIndexOf={colIndexOf}
              onCellClick={onCellClick}
              rowId={rowWindow && r >= windowStart && r < windowEnd ? rowWindow.rowIds[r - windowStart] : r}
            />
          )
        })
      )}

      {/* Gives the container its scroll range; rows float above it. */}
      <div
        style={{
          height: Math.max(spacerHeight - HEADER_HEIGHT, 1),
          width: pinnedWidth + colRange.totalSize,
        }}
      />
    </div>
  )
}

/* -------------------------------------------------------------------- row */

interface RowProps {
  rowIndex: number
  rowId: number
  top: number
  height: number
  pinned: ColumnMeta[]
  scrolling: ColumnMeta[]
  offsetBefore: number
  pinnedWidth: number
  totalWidth: number
  widthOf: (c: ColumnMeta) => number
  valueAt: (row: number, columnId: string) => CellValue | undefined
  loaded: boolean
  highlight?: string
  shadow: boolean
  focusedCol: number
  colIndexOf: Map<string, number>
  onCellClick?: (rowId: number, columnId: string, value: CellValue) => void
}

const Row = memo(function Row({
  rowIndex,
  rowId,
  top,
  height,
  pinned,
  scrolling,
  offsetBefore,
  pinnedWidth,
  totalWidth,
  widthOf,
  valueAt,
  loaded,
  highlight,
  shadow,
  focusedCol,
  colIndexOf,
  onCellClick,
}: RowProps) {
  const cell = (c: ColumnMeta, colIndex: number) => (
    <Cell
      key={c.id}
      column={c}
      width={widthOf(c)}
      value={valueAt(rowIndex, c.id)}
      loaded={loaded}
      highlight={highlight}
      focused={focusedCol === colIndex}
      onClick={onCellClick ? () => onCellClick(rowId, c.id, valueAt(rowIndex, c.id) ?? null) : undefined}
    />
  )

  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 2}
      className="group/row absolute flex w-max min-w-full hover:bg-surface-2"
      style={{ top, height }}
    >
      {pinned.length > 0 && (
        <div
          className={clsx(
            'sticky left-0 z-10 flex bg-surface-1 group-hover/row:bg-surface-2',
            shadow && 'shadow-[6px_0_12px_-8px_rgba(48,40,82,0.45)]',
          )}
          style={{ width: pinnedWidth, height }}
        >
          {pinned.map((c) => cell(c, colIndexOf.get(c.id) ?? -1))}
        </div>
      )}
      <div className="flex" style={{ width: totalWidth }}>
        <div style={{ width: offsetBefore }} />
        {scrolling.map((c) => cell(c, colIndexOf.get(c.id) ?? -1))}
      </div>
    </div>
  )
})

/* ------------------------------------------------------------------- cell */

interface CellProps {
  column: ColumnMeta
  width: number
  value: CellValue | undefined
  loaded: boolean
  highlight?: string
  focused: boolean
  onClick?: () => void
}

const Cell = memo(function Cell({ column, width, value, loaded, highlight, focused, onClick }: CellProps) {
  const numeric = column.kind === 'int' || column.kind === 'float' || column.kind === 'date'

  if (!loaded) {
    return (
      <div role="gridcell" style={{ width }} className="flex shrink-0 items-center px-2.5">
        <span className="df-skeleton h-2.5 w-full max-w-24" />
      </div>
    )
  }

  let body: React.ReactNode
  if (value === null || value === undefined) {
    // A null must not look like an empty string — they mean different things.
    body = (
      <span className="text-ink-3" title="null">
        ·
      </span>
    )
  } else if (value === '') {
    body = (
      <span className="inline-block h-px w-3 bg-line-2 align-middle" title="empty string" />
    )
  } else {
    const text = formatCell(value, column.kind)
    body = highlight ? highlightText(text, highlight) : text
  }

  return (
    <div
      role="gridcell"
      onClick={onClick}
      style={{ width }}
      title={value === null || value === undefined ? 'null' : String(value)}
      className={clsx(
        'flex shrink-0 items-center overflow-hidden px-2.5 whitespace-nowrap',
        numeric ? 'tnum justify-end text-ink-1' : 'justify-start text-ink-1',
        focused && 'rounded-md ring-2 ring-accent ring-inset',
        onClick && 'cursor-pointer',
      )}
    >
      <span className="truncate">{body}</span>
    </div>
  )
})

/** Split on the search term without constructing a RegExp per cell. */
function highlightText(text: string, term: string): React.ReactNode {
  if (!term) return text
  const haystack = text.toLowerCase()
  const needle = term.toLowerCase()
  let index = haystack.indexOf(needle)
  if (index < 0) return text

  const parts: React.ReactNode[] = []
  let cursor = 0
  let key = 0
  while (index >= 0 && key < 20) {
    if (index > cursor) parts.push(text.slice(cursor, index))
    parts.push(
      <mark key={key++} className="rounded bg-accent-soft px-0.5 text-ink-1">
        {text.slice(index, index + term.length)}
      </mark>,
    )
    cursor = index + term.length
    index = haystack.indexOf(needle, cursor)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}
