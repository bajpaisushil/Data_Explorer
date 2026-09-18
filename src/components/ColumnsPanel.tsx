'use client'
import { Eye, EyeOff, GripVertical, Pin, PinOff } from 'lucide-react'
import { useState } from 'react'
import { SidePanel } from '@/components/SidePanel'
import { Button, IconButton, Pill } from '@/components/ui/Button'
import { Input } from '@/components/ui/Field'
import { kindColorVar, kindShort } from '@/lib/format'
import { useStore } from '@/lib/state/store'

export function ColumnsPanel() {
  const meta = useStore((s) => s.meta)
  const columnOrder = useStore((s) => s.columnOrder)
  const columnState = useStore((s) => s.columnState)
  const hideColumn = useStore((s) => s.hideColumn)
  const showColumn = useStore((s) => s.showColumn)
  const showAll = useStore((s) => s.showAllColumns)
  const togglePin = useStore((s) => s.togglePin)
  const reorder = useStore((s) => s.reorderColumn)
  const setPanel = useStore((s) => s.setPanel)

  const [term, setTerm] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)

  if (!meta) return null
  const byId = new Map(meta.columns.map((c) => [c.id, c]))
  const rows = columnOrder
    .map((id) => byId.get(id))
    .filter((c) => !!c)
    .filter((c) => c.name.toLowerCase().includes(term.toLowerCase()))
  const hiddenCount = columnOrder.filter((id) => columnState[id]?.hidden).length

  return (
    <SidePanel
      title="Columns"
      subtitle={`${columnOrder.length - hiddenCount} of ${columnOrder.length} shown`}
      onClose={() => setPanel(null)}
      actions={
        hiddenCount > 0 ? (
          <Button size="xs" variant="soft" onClick={showAll}>
            Show all
          </Button>
        ) : null
      }
    >
      <div className="sticky top-0 z-10 bg-surface-1/90 pb-2 backdrop-blur">
        <Input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Find a column…"
          aria-label="Find a column"
        />
      </div>

      <ul className="space-y-1">
        {rows.map((col, index) => {
          const state = columnState[col.id]
          const hidden = state?.hidden ?? false
          return (
            <li
              key={col.id}
              draggable
              onDragStart={() => setDragId(col.id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId && dragId !== col.id) reorder(dragId, index)
                setDragId(null)
              }}
              className={
                'group flex items-center gap-2 rounded-xl px-2 py-1.5 transition-colors ' +
                (dragId === col.id ? 'opacity-40 ' : '') +
                'hover:bg-surface-2'
              }
            >
              <GripVertical size={13} className="shrink-0 cursor-grab text-ink-3" />
              <Pill hue={kindColorVar(col.kind)} className="shrink-0 font-mono">
                {kindShort(col.kind)}
              </Pill>
              <span
                className={'min-w-0 flex-1 truncate text-2xs ' + (hidden ? 'text-ink-3 line-through' : 'text-ink-1')}
                title={col.name}
              >
                {col.name}
              </span>
              <IconButton
                label={state?.pinned ? `Unpin ${col.name}` : `Pin ${col.name}`}
                size="xs"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                icon={state?.pinned ? <Pin size={12} className="text-accent" /> : <PinOff size={12} />}
                onClick={() => togglePin(col.id)}
              />
              <IconButton
                label={hidden ? `Show ${col.name}` : `Hide ${col.name}`}
                size="xs"
                icon={hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                onClick={() => (hidden ? showColumn(col.id) : hideColumn(col.id))}
              />
            </li>
          )
        })}
      </ul>
    </SidePanel>
  )
}
