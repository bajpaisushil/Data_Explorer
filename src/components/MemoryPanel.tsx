'use client'
import clsx from 'clsx'
import { AlertTriangle, Cpu, Database, HardDrive, Loader2, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { SidePanel } from '@/components/SidePanel'
import { Button, Pill } from '@/components/ui/Button'
import { getEngine } from '@/lib/engine/client'
import type { MemoryReport, StorageReport } from '@/lib/engine/protocol'
import { formatBytes, formatCount, formatPercent } from '@/lib/format'
import { useStore } from '@/lib/state/store'

/**
 * Two questions, answered side by side: what this tab is holding in memory
 * right now, and what DataForge has actually written to disk. The second one
 * is the one that outlives the tab, so it is the one that gets delete buttons.
 */
export function MemoryPanel() {
  const setPanel = useStore((s) => s.setPanel)
  const meta = useStore((s) => s.meta)
  const notify = useStore((s) => s.notify)
  const refreshStored = useStore((s) => s.refreshStoredDatasets)

  // Tagged with the dataset it describes, so switching datasets invalidates
  // it by derivation rather than by an extra state reset.
  const [memory, setMemory] = useState<{ id: string; report: MemoryReport } | null>(null)
  const [storage, setStorage] = useState<StorageReport | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const loadStorage = useCallback(() => {
    getEngine()
      .request({ kind: 'storageReport' })
      .then(setStorage)
      .catch(() => setStorage(null))
  }, [])

  const datasetId = meta?.id ?? null
  const report = memory && memory.id === datasetId ? memory.report : null

  useEffect(() => {
    if (!datasetId) return
    let live = true
    getEngine()
      .request({ kind: 'memoryReport' })
      .then((r) => {
        if (live) setMemory({ id: datasetId, report: r })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [datasetId])

  useEffect(loadStorage, [loadStorage])

  const removeDataset = async (id: string, name: string) => {
    setBusy(id)
    try {
      await getEngine().request({ kind: 'deleteDataset', datasetId: id })
      loadStorage()
      await refreshStored()
      notify('good', `Deleted "${name}" from this browser`)
    } catch (err) {
      notify('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const clearEverything = async () => {
    setBusy('all')
    try {
      const res = await getEngine().request({ kind: 'clearStorage' })
      loadStorage()
      await refreshStored()
      setConfirmClear(false)
      notify('good', `Cleared ${res.datasets} saved dataset${res.datasets === 1 ? '' : 's'}`)
    } catch (err) {
      notify('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <SidePanel
      title="Memory & storage"
      subtitle="Everything here lives on this machine"
      onClose={() => setPanel(null)}
    >
      <div className="space-y-4">
        <section className="space-y-2">
          <SectionTitle icon={<Cpu size={13} />}>In this tab</SectionTitle>
          {!meta ? (
            <p className="df-sunken px-3 py-4 text-center text-2xs text-ink-3">No dataset loaded</p>
          ) : !report ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="df-skeleton h-6 w-full" />
              ))}
            </div>
          ) : (
            <InMemory report={report} />
          )}
        </section>

        <section className="space-y-2">
          <SectionTitle icon={<HardDrive size={13} />}>Saved in this browser</SectionTitle>

          {!storage ? (
            <div className="df-skeleton h-16 w-full rounded-xl" />
          ) : !storage.available ? (
            <p className="df-sunken flex items-start gap-2 px-3 py-3 text-2xs text-ink-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
              This browser blocks local storage, likely private browsing. Datasets still work — they
              just will not survive a refresh.
            </p>
          ) : (
            <>
              <QuotaCard report={storage} />

              {storage.datasets.length === 0 ? (
                <p className="df-sunken px-3 py-4 text-center text-2xs text-ink-3">
                  Nothing saved yet. Use “Save locally” to keep a dataset across refreshes.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {storage.datasets.map((d) => (
                    <li key={d.id} className="df-card flex items-center gap-2.5 px-3 py-2.5">
                      <Database size={15} className="shrink-0 text-ink-3" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-2xs font-semibold text-ink-1">{d.name}</span>
                        <span className="tnum block text-2xs text-ink-3">
                          {formatCount(d.rowCount)} rows · {formatBytes(d.bytes)}
                        </span>
                      </span>
                      <Button
                        size="xs"
                        variant="danger"
                        aria-label={`Delete ${d.name}`}
                        disabled={busy === d.id}
                        icon={
                          busy === d.id ? (
                            <Loader2 size={12} className="df-spin" />
                          ) : (
                            <Trash2 size={12} />
                          )
                        }
                        onClick={() => void removeDataset(d.id, d.name)}
                      >
                        Delete
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              {(storage.datasets.length > 0 || storage.views > 0) &&
                (confirmClear ? (
                  <div className="df-card df-pop space-y-2 p-3">
                    <p className="text-2xs text-ink-1">
                      Delete all {storage.datasets.length} saved dataset
                      {storage.datasets.length === 1 ? '' : 's'}
                      {storage.views > 0 && ` and ${storage.views} saved view${storage.views === 1 ? '' : 's'}`}?
                      This cannot be undone.
                    </p>
                    <div className="flex gap-1.5">
                      <Button
                        size="xs"
                        variant="soft"
                        onClick={() => setConfirmClear(false)}
                        disabled={busy === 'all'}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="xs"
                        variant="primary"
                        className="!bg-none !bg-critical"
                        disabled={busy === 'all'}
                        icon={busy === 'all' ? <Loader2 size={12} className="df-spin" /> : <Trash2 size={12} />}
                        onClick={() => void clearEverything()}
                      >
                        Delete everything
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="soft"
                    block
                    icon={<Trash2 size={13} />}
                    onClick={() => setConfirmClear(true)}
                  >
                    Clear all saved data
                  </Button>
                ))}
            </>
          )}
        </section>
      </div>
    </SidePanel>
  )
}

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-1.5 px-1 text-2xs font-semibold tracking-wider text-ink-3 uppercase">
      {icon}
      {children}
    </h3>
  )
}

function QuotaCard({ report }: { report: StorageReport }) {
  const used = report.quota > 0 ? report.usage / report.quota : 0
  const tight = used > 0.85

  return (
    <div className="df-card space-y-2.5 p-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="tnum text-base font-semibold text-ink-1">{formatBytes(report.usage)}</span>
        <span className="tnum text-2xs text-ink-3">
          of {report.quota > 0 ? formatBytes(report.quota) : 'unknown'} available
        </span>
      </div>

      <div className="df-sunken h-2.5 w-full overflow-hidden rounded-full">
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{
            width: `${Math.max(1, Math.min(100, used * 100))}%`,
            background: tight ? 'var(--critical)' : 'var(--grad-accent)',
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Pill hue={tight ? 'var(--critical)' : 'var(--accent)'}>
          {report.quota > 0 ? formatPercent(used, 1) : '—'} used
        </Pill>
        <Pill hue="var(--kind-date)">{formatBytes(report.datasetBytes)} in datasets</Pill>
        {report.views > 0 && <Pill hue="var(--kind-string)">{report.views} saved views</Pill>}
      </div>

      {tight && (
        <p className="flex items-start gap-1.5 text-2xs text-critical">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          Running low — saving another large dataset may fail.
        </p>
      )}
    </div>
  )
}

function InMemory({ report }: { report: MemoryReport }) {
  const saved = 1 - report.totalBytes / Math.max(1, report.naiveBytes)
  const max = Math.max(...report.columns.map((c) => c.bytes), 1)

  return (
    <div className="space-y-2">
      <div className="df-card grid grid-cols-2 gap-3 p-3.5">
        <Stat label="Rows" value={formatCount(report.rowCount)} />
        <Stat label="Column memory" value={formatBytes(report.totalBytes)} />
        <Stat label="As plain JS values" value={formatBytes(report.naiveBytes)} />
        <Stat label="Saved by columns" value={`${Math.max(0, Math.round(saved * 100))}%`} hue="var(--good)" />
      </div>

      <ul className="space-y-1.5">
        {report.columns
          .slice()
          .sort((a, b) => b.bytes - a.bytes)
          .map((c) => (
            <li key={c.columnId} className="df-card px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-2xs font-medium text-ink-1">{c.name}</span>
                <Pill hue="var(--kind-string)" className="font-mono">
                  {c.encoding}
                </Pill>
                <span className="tnum shrink-0 text-2xs text-ink-3">{formatBytes(c.bytes)}</span>
              </div>
              <div className="df-sunken mt-1.5 h-1.5 w-full overflow-hidden rounded-full">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(2, (c.bytes / max) * 100)}%`,
                    backgroundImage: 'var(--grad-accent)',
                  }}
                />
              </div>
            </li>
          ))}
      </ul>

      <p className="flex items-start gap-2 px-1 text-2xs leading-relaxed text-ink-3">
        <Cpu size={13} className="mt-0.5 shrink-0" />
        Values live in typed arrays inside a worker. Repeated text is dictionary-encoded, so a
        column of country names costs one integer per row instead of one string object.
      </p>
    </div>
  )
}

function Stat({ label, value, hue }: { label: string; value: string; hue?: string }) {
  return (
    <div>
      <p className="text-2xs text-ink-3">{label}</p>
      <p className={clsx('tnum text-base font-semibold')} style={{ color: hue ?? 'var(--ink-1)' }}>
        {value}
      </p>
    </div>
  )
}
