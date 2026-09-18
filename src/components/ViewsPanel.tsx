'use client'
import { Bookmark, BookmarkPlus, Clock, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { SidePanel } from '@/components/SidePanel'
import { Button, IconButton } from '@/components/ui/Button'
import { Input } from '@/components/ui/Field'
import { useStore } from '@/lib/state/store'

export function ViewsPanel() {
  const views = useStore((s) => s.savedViews)
  const refresh = useStore((s) => s.refreshSavedViews)
  const save = useStore((s) => s.saveCurrentView)
  const apply = useStore((s) => s.applyView)
  const remove = useStore((s) => s.deleteSavedView)
  const setPanel = useStore((s) => s.setPanel)
  const filters = useStore((s) => s.query.filters)
  const sorts = useStore((s) => s.query.sorts)

  const [name, setName] = useState('')

  useEffect(() => {
    void refresh()
  }, [refresh])

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    void save(trimmed)
    setName('')
  }

  return (
    <SidePanel
      title="Saved views"
      subtitle="Filters, sorting, column layout and charts, remembered together"
      onClose={() => setPanel(null)}
    >
      <div className="df-card mb-3 space-y-2 p-3">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Name this view…"
          aria-label="Name this view"
        />
        <Button
          variant="primary"
          size="sm"
          block
          icon={<BookmarkPlus size={13} />}
          disabled={!name.trim()}
          onClick={submit}
        >
          Save current view
        </Button>
        <p className="text-2xs text-ink-3">
          {filters.length} filter{filters.length === 1 ? '' : 's'} · {sorts.length} sort
          {sorts.length === 1 ? '' : 's'}
        </p>
      </div>

      {views.length === 0 ? (
        <EmptyNote
          icon={<Bookmark size={18} />}
          title="No saved views yet"
          body="Set up a filter and sort you like, then save it here. Views live in this browser only."
        />
      ) : (
        <ul className="space-y-1.5">
          {views.map((v) => (
            <li key={v.id} className="df-card group flex items-center gap-2 px-3 py-2.5">
              <button
                type="button"
                onClick={() => apply(v)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block truncate text-2xs font-semibold text-ink-1">{v.name}</span>
                <span className="flex items-center gap-1 text-2xs text-ink-3">
                  <Clock size={10} />
                  {new Date(v.createdAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                  })}
                  {' · '}
                  {v.query.filters.length} filter{v.query.filters.length === 1 ? '' : 's'}
                </span>
              </button>
              <IconButton
                label={`Delete view ${v.name}`}
                size="xs"
                variant="danger"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                icon={<Trash2 size={12} />}
                onClick={() => void remove(v.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </SidePanel>
  )
}

export function EmptyNote({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode
  title: string
  body: string
}) {
  return (
    <div className="df-sunken flex flex-col items-center gap-2 px-5 py-8 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-2xl bg-surface-1 text-ink-3 shadow-[var(--e1)]">
        {icon}
      </span>
      <p className="text-2xs font-semibold text-ink-1">{title}</p>
      <p className="max-w-56 text-2xs leading-relaxed text-ink-3">{body}</p>
    </div>
  )
}
