'use client'
import clsx from 'clsx'
import { ArrowDown, ArrowUp, EyeOff, MoreVertical, Pin, PinOff, Ruler } from 'lucide-react'
import { useRef } from 'react'
import { Sparkline } from '@/components/charts/Sparkline'
import { MenuItem, MenuSeparator, Popover } from '@/components/ui/Popover'
import { kindColorVar, kindLabel, kindShort } from '@/lib/format'
import type { ColumnMeta, SortSpec } from '@/lib/types'

const MIN_WIDTH = 56
const MAX_WIDTH = 800

export interface HeaderCellProps {
  column: ColumnMeta
  width: number
  pinned: boolean
  sortIndex: number
  sort: SortSpec | undefined
  spark?: number[]
  onSort: (additive: boolean) => void
  onResize: (width: number) => void
  onAutoFit: () => void
  onTogglePin: () => void
  onHide: () => void
  onDragStart: () => void
  onDrop: () => void
  dropTarget: boolean
}

export function HeaderCell({
  column,
  width,
  pinned,
  sortIndex,
  sort,
  spark,
  onSort,
  onResize,
  onAutoFit,
  onTogglePin,
  onHide,
  onDragStart,
  onDrop,
  dropTarget,
}: HeaderCellProps) {
  const startRef = useRef({ x: 0, width: 0 })

  const beginResize = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    startRef.current = { x: e.clientX, width }
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)

    const move = (ev: PointerEvent) => {
      const next = startRef.current.width + (ev.clientX - startRef.current.x)
      onResize(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, next)))
    }
    const up = () => {
      target.releasePointerCapture(e.pointerId)
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
  }

  return (
    <div
      role="columnheader"
      aria-sort={sort ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      style={{ width }}
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        onDrop()
      }}
      className={clsx(
        'group relative flex h-full shrink-0 items-center gap-1.5 px-2.5',
        dropTarget && 'bg-accent-soft',
      )}
    >
      <span
        className="h-4 shrink-0 rounded-full px-1.5 text-[9px] leading-4 font-bold"
        style={{
          color: kindColorVar(column.kind),
          background: `color-mix(in oklab, ${kindColorVar(column.kind)} 15%, transparent)`,
        }}
        title={kindLabel(column.kind)}
      >
        {kindShort(column.kind)}
      </span>

      <button
        type="button"
        onClick={(e) => onSort(e.shiftKey)}
        title={`${column.name} — click to sort, shift-click to add to the sort`}
        className="min-w-0 flex-1 truncate text-left text-2xs font-semibold text-ink-1"
      >
        {column.name}
      </button>

      {spark && spark.length > 1 && (
        <span className="hidden shrink-0 text-ink-3 opacity-50 lg:inline">
          <Sparkline values={spark} width={40} height={16} kind={column.kind === 'string' ? 'bar' : 'line'} />
        </span>
      )}

      {sort && (
        <span className="flex shrink-0 items-center gap-0.5 text-accent">
          {sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
          {sortIndex > 0 && <span className="text-[9px] font-bold">{sortIndex + 1}</span>}
        </span>
      )}

      <Popover
        align="end"
        trigger={({ toggle }) => (
          <button
            type="button"
            aria-label={`${column.name} options`}
            onClick={toggle}
            className="shrink-0 rounded-md p-0.5 text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-surface-3 hover:text-ink-1 focus-visible:opacity-100"
          >
            <MoreVertical size={13} />
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuItem
              icon={sort?.dir === 'asc' ? <ArrowDown size={13} /> : <ArrowUp size={13} />}
              onClick={() => {
                onSort(false)
                close()
              }}
            >
              {sort ? (sort.dir === 'asc' ? 'Sort descending' : 'Clear sort') : 'Sort ascending'}
            </MenuItem>
            <MenuItem icon={<ArrowUp size={13} />} onClick={() => { onSort(true); close() }}>
              Add to multi-sort
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={pinned ? <PinOff size={13} /> : <Pin size={13} />} onClick={() => { onTogglePin(); close() }}>
              {pinned ? 'Unpin column' : 'Pin to left'}
            </MenuItem>
            <MenuItem icon={<Ruler size={13} />} onClick={() => { onAutoFit(); close() }}>
              Fit to content
            </MenuItem>
            <MenuSeparator />
            <MenuItem destructive icon={<EyeOff size={13} />} onClick={() => { onHide(); close() }}>
              Hide column
            </MenuItem>
          </>
        )}
      </Popover>

      {/* Resize handle — pointer drag, double-click to auto-fit, and reachable
          from the keyboard because a mouse-only affordance is not enough. */}
      <div
        role="separator"
        aria-label={`Resize ${column.name}`}
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={beginResize}
        onDoubleClick={onAutoFit}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 1 : 8
          if (e.key === 'ArrowLeft') {
            e.preventDefault()
            onResize(Math.max(MIN_WIDTH, width - step))
          } else if (e.key === 'ArrowRight') {
            e.preventDefault()
            onResize(Math.min(MAX_WIDTH, width + step))
          }
        }}
        className="absolute top-1 right-0 bottom-1 w-2 cursor-col-resize touch-none"
      >
        <span className="absolute top-0 right-[3px] bottom-0 w-[2px] rounded-full bg-transparent transition-colors group-hover:bg-line-2 hover:!bg-accent" />
      </div>
    </div>
  )
}
