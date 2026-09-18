'use client'
import { Cpu } from 'lucide-react'
import { useEffect, useState } from 'react'
import { SidePanel } from '@/components/SidePanel'
import { Pill } from '@/components/ui/Button'
import { getEngine } from '@/lib/engine/client'
import type { MemoryReport } from '@/lib/engine/protocol'
import { formatBytes, formatCount } from '@/lib/format'
import { useStore } from '@/lib/state/store'

/** Shows what the columnar layout actually bought, in bytes. */
export function MemoryPanel() {
  const setPanel = useStore((s) => s.setPanel)
  const meta = useStore((s) => s.meta)
  const [report, setReport] = useState<MemoryReport | null>(null)

  useEffect(() => {
    let live = true
    getEngine()
      .request({ kind: 'memoryReport' })
      .then((r) => {
        if (live) setReport(r)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [meta?.id])

  const saved = report ? 1 - report.totalBytes / Math.max(1, report.naiveBytes) : 0
  const max = report ? Math.max(...report.columns.map((c) => c.bytes), 1) : 1

  return (
    <SidePanel
      title="Memory"
      subtitle="How the dataset is held in this tab"
      onClose={() => setPanel(null)}
    >
      {!report ? (
        <div className="space-y-2 p-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="df-skeleton h-6 w-full" />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="df-card grid grid-cols-2 gap-3 p-3.5">
            <Stat label="Rows" value={formatCount(report.rowCount)} />
            <Stat label="Column memory" value={formatBytes(report.totalBytes)} />
            <Stat label="As plain JS values" value={formatBytes(report.naiveBytes)} />
            <Stat
              label="Saved"
              value={`${Math.max(0, Math.round(saved * 100))}%`}
              hue="var(--good)"
            />
          </div>

          <ul className="space-y-1.5">
            {report.columns
              .slice()
              .sort((a, b) => b.bytes - a.bytes)
              .map((c) => (
                <li key={c.columnId} className="df-card px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-2xs font-medium text-ink-1">
                      {c.name}
                    </span>
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
      )}
    </SidePanel>
  )
}

function Stat({ label, value, hue }: { label: string; value: string; hue?: string }) {
  return (
    <div>
      <p className="text-2xs text-ink-3">{label}</p>
      <p className="tnum text-base font-semibold" style={{ color: hue ?? 'var(--ink-1)' }}>
        {value}
      </p>
    </div>
  )
}
