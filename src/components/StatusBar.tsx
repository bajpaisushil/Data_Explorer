'use client'
import { Download, HardDriveDownload, ShieldCheck, Timer } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { formatCount, formatDuration } from '@/lib/format'
import { useStore } from '@/lib/state/store'

export function StatusBar() {
  const result = useStore((s) => s.result)
  const meta = useStore((s) => s.meta)
  const exportCsv = useStore((s) => s.exportCsv)
  const persistDataset = useStore((s) => s.persistDataset)
  const persisting = useStore((s) => s.persisting)

  if (!meta) return null

  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2 text-2xs text-ink-3">
      <span className="inline-flex items-center gap-1.5 font-medium text-good">
        <ShieldCheck size={12} />
        Local only
      </span>

      {result && (
        <>
          <span className="tnum">
            {formatCount(result.matched)} of {formatCount(result.total)} rows
          </span>
          {result.groupCount != null && (
            <span className="tnum">{formatCount(result.groupCount)} groups</span>
          )}
          <span className="tnum inline-flex items-center gap-1">
            <Timer size={12} />
            {formatDuration(result.elapsedMs)}
          </span>
        </>
      )}

      <span className="ml-auto flex items-center gap-1.5">
        <Button
          size="xs"
          variant="ghost"
          icon={<HardDriveDownload size={12} />}
          disabled={persisting}
          onClick={() => void persistDataset()}
        >
          {persisting ? 'Saving…' : 'Save locally'}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          icon={<Download size={12} />}
          disabled={!result}
          onClick={() => void exportCsv()}
        >
          Export CSV
        </Button>
      </span>
    </footer>
  )
}
