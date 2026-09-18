'use client'
import { Download, HardDrive, HardDriveDownload, ShieldCheck, Timer } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { getEngine } from '@/lib/engine/client'
import type { StorageReport } from '@/lib/engine/protocol'
import { formatBytes, formatCount, formatDuration } from '@/lib/format'
import { useStore } from '@/lib/state/store'

export function StatusBar() {
  const result = useStore((s) => s.result)
  const meta = useStore((s) => s.meta)
  const persisting = useStore((s) => s.persisting)
  const storedDatasets = useStore((s) => s.storedDatasets)
  const exportCsv = useStore((s) => s.exportCsv)
  const persistDataset = useStore((s) => s.persistDataset)
  const setPanel = useStore((s) => s.setPanel)

  const [storage, setStorage] = useState<StorageReport | null>(null)

  const refresh = useCallback(() => {
    getEngine()
      .request({ kind: 'storageReport' })
      .then(setStorage)
      .catch(() => setStorage(null))
  }, [])

  // Re-read after anything that could change what is on disk.
  useEffect(refresh, [refresh, storedDatasets, persisting])

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

      {storage?.available && (
        <button
          type="button"
          onClick={() => setPanel('memory')}
          title="Open memory and storage"
          className="tnum inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 hover:bg-surface-2 hover:text-ink-1"
        >
          <HardDrive size={12} />
          {formatBytes(storage.usage)} stored
          {storage.datasets.length > 0 && ` · ${storage.datasets.length} saved`}
        </button>
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
