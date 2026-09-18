'use client'
import {
  BarChart3,
  Bookmark,
  Columns3,
  Database,
  Download,
  Group,
  HardDriveDownload,
  Loader2,
  Monitor,
  Moon,
  Search,
  Sun,
  Table2,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button, IconButton, Pill } from '@/components/ui/Button'
import { MenuItem, MenuLabel, MenuSeparator, Popover } from '@/components/ui/Popover'
import { formatCount } from '@/lib/format'
import { useStore } from '@/lib/state/store'

export function TopBar() {
  const meta = useStore((s) => s.meta)
  const result = useStore((s) => s.result)
  const status = useStore((s) => s.status)
  const panel = useStore((s) => s.panel)
  const setPanel = useStore((s) => s.setPanel)
  const search = useStore((s) => s.query.search)
  const setSearch = useStore((s) => s.setSearch)
  const closeDataset = useStore((s) => s.closeDataset)
  const exportCsv = useStore((s) => s.exportCsv)
  const persistDataset = useStore((s) => s.persistDataset)
  const persisting = useStore((s) => s.persisting)

  const storeTerm = search?.term ?? ''
  const [term, setTerm] = useState(storeTerm)
  const [syncedTerm, setSyncedTerm] = useState(storeTerm)
  const searchRef = useRef<HTMLInputElement>(null)

  // The store can change the term without us typing — applying a saved view,
  // or clearing all filters. Adjusting during render is React's documented
  // way to mirror that, and avoids the extra pass an effect would cost.
  if (storeTerm !== syncedTerm) {
    setSyncedTerm(storeTerm)
    setTerm(storeTerm)
  }

  // "/" focuses search, the way every data tool people already know does it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
      if (e.key === '/' && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  if (!meta) return null

  return (
    <header className="flex flex-wrap items-center gap-2.5 px-3 py-2.5 sm:px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <div
          className="grid h-8 w-8 shrink-0 place-items-center rounded-xl"
          style={{
            backgroundImage: 'var(--grad-accent)',
            boxShadow: '0 4px 12px -3px var(--accent-glow), var(--hl-accent)',
          }}
        >
          <Database size={16} className="text-white" strokeWidth={2.4} />
        </div>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-ink-1" title={meta.name}>
            {meta.name}
          </p>
          <p className="tnum truncate text-2xs text-ink-3">
            {formatCount(meta.rowCount)} rows · {meta.columns.length} columns
          </p>
        </div>
      </div>

      <div className="relative min-w-40 flex-1 sm:max-w-md">
        <Search
          size={14}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3"
        />
        <input
          ref={searchRef}
          value={term}
          onChange={(e) => {
            setTerm(e.target.value)
            setSearch(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setTerm('')
              setSearch('')
              e.currentTarget.blur()
            }
          }}
          placeholder="Search every column…"
          aria-label="Search every column"
          className="df-sunken h-9 w-full rounded-full pr-16 pl-9 text-2xs text-ink-1 placeholder:text-ink-3 outline-none focus:shadow-[inset_0_1px_3px_rgba(48,40,82,0.08),0_0_0_2px_var(--accent-glow)]"
        />
        {term ? (
          <button
            type="button"
            onClick={() => {
              setTerm('')
              setSearch('')
            }}
            aria-label="Clear search"
            className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-full p-1 text-ink-3 hover:bg-surface-3 hover:text-ink-1"
          >
            <X size={13} />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded-md bg-surface-3 px-1.5 py-0.5 text-2xs font-medium text-ink-3">
            /
          </kbd>
        )}
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        {status === 'busy' && (
          <Pill hue="var(--accent)" icon={<Loader2 size={11} className="df-spin" />}>
            Working
          </Pill>
        )}

        <Button
          size="sm"
          variant="soft"
          active={panel === 'columns'}
          icon={<Columns3 size={14} />}
          onClick={() => setPanel('columns')}
        >
          <span className="hidden sm:inline">Columns</span>
        </Button>
        <Button
          size="sm"
          variant="soft"
          active={panel === 'profile'}
          icon={<Table2 size={14} />}
          onClick={() => setPanel('profile')}
        >
          <span className="hidden sm:inline">Profile</span>
        </Button>
        <Button
          size="sm"
          variant="soft"
          active={panel === 'charts'}
          icon={<BarChart3 size={14} />}
          onClick={() => setPanel('charts')}
        >
          <span className="hidden sm:inline">Charts</span>
        </Button>
        <Button
          size="sm"
          variant="soft"
          active={panel === 'views'}
          icon={<Bookmark size={14} />}
          onClick={() => setPanel('views')}
        >
          <span className="hidden md:inline">Views</span>
        </Button>

        <ThemeMenu />

        <Popover
          align="end"
          trigger={({ toggle }) => (
            <IconButton label="More actions" variant="soft" onClick={toggle} icon={<Group size={14} />} />
          )}
        >
          {(close) => (
            <>
              <MenuLabel>This dataset</MenuLabel>
              <MenuItem
                icon={<Download size={13} />}
                disabled={!result}
                onClick={() => {
                  close()
                  void exportCsv()
                }}
              >
                Export filtered rows as CSV
              </MenuItem>
              <MenuItem
                icon={<HardDriveDownload size={13} />}
                disabled={persisting}
                onClick={() => {
                  close()
                  void persistDataset()
                }}
              >
                {persisting ? 'Saving…' : 'Save to this browser'}
              </MenuItem>
              <MenuItem icon={<Database size={13} />} onClick={() => { close(); setPanel('memory') }}>
                Memory &amp; storage
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                destructive
                icon={<X size={13} />}
                onClick={() => {
                  close()
                  closeDataset()
                }}
              >
                Close dataset
              </MenuItem>
            </>
          )}
        </Popover>
      </div>
    </header>
  )
}

function ThemeMenu() {
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor

  return (
    <Popover
      align="end"
      trigger={({ toggle }) => (
        <IconButton label="Theme" variant="soft" onClick={toggle} icon={<Icon size={14} />} />
      )}
      panelClassName="min-w-40"
    >
      {(close) => (
        <>
          <MenuLabel>Theme</MenuLabel>
          {(['light', 'dark', 'system'] as const).map((t) => (
            <MenuItem
              key={t}
              icon={t === 'light' ? <Sun size={13} /> : t === 'dark' ? <Moon size={13} /> : <Monitor size={13} />}
              onClick={() => {
                setTheme(t)
                close()
              }}
              className={theme === t ? 'bg-accent-soft text-accent' : undefined}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </MenuItem>
          ))}
        </>
      )}
    </Popover>
  )
}
