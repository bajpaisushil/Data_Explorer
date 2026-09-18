'use client'
import clsx from 'clsx'
import {
  Database,
  FileUp,
  HardDriveDownload,
  ShieldCheck,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Pill, ProgressBar } from '@/components/ui/Button'
import { Select } from '@/components/ui/Field'
import { SAMPLE_PRESETS } from '@/lib/sample'
import { formatBytes, formatCount } from '@/lib/format'
import { useStore } from '@/lib/state/store'

const ROW_CHOICES = [10_000, 100_000, 500_000, 1_000_000, 2_000_000]

const PRESET_HUE: Record<string, string> = {
  ecommerce: 'var(--series-2)',
  iot_sensors: 'var(--series-3)',
  web_events: 'var(--series-7)',
}

export function Dropzone() {
  const loadFile = useStore((s) => s.loadFile)
  const loadSample = useStore((s) => s.loadSample)
  const status = useStore((s) => s.status)
  const progress = useStore((s) => s.progress)
  const error = useStore((s) => s.error)
  const storedDatasets = useStore((s) => s.storedDatasets)
  const refreshStored = useStore((s) => s.refreshStoredDatasets)
  const openStored = useStore((s) => s.openStoredDataset)
  const deleteStored = useStore((s) => s.deleteStoredDataset)

  const [dragging, setDragging] = useState(false)
  const [rows, setRows] = useState(1_000_000)
  const inputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  useEffect(() => {
    void refreshStored()
  }, [refreshStored])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const file = e.dataTransfer.files?.[0]
      if (file) void loadFile(file)
    },
    [loadFile],
  )

  const busy = status === 'busy'

  if (busy) return <LoadingCard progress={progress} />

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-8 px-5 py-10">
      <header className="flex flex-col items-center gap-4 text-center">
        <div
          className="df-float grid h-16 w-16 place-items-center rounded-2xl"
          style={{
            backgroundImage: 'var(--grad-accent)',
            boxShadow: '0 10px 30px -8px var(--accent-glow), var(--hl-accent)',
          }}
        >
          <Database size={30} className="text-white" strokeWidth={2.2} />
        </div>
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight text-ink-1">DataForge</h1>
          <p className="max-w-lg text-sm text-ink-2">
            Drop in a CSV or JSON file with a million rows and explore it instantly — sort, filter,
            group, chart and profile it, all in this tab.
          </p>
        </div>
        <Pill hue="var(--good)" icon={<ShieldCheck size={12} />}>
          Nothing is uploaded — your data never leaves this machine
        </Pill>
      </header>

      <div
        onDragEnter={(e) => {
          e.preventDefault()
          dragDepth.current++
          setDragging(true)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault()
          dragDepth.current--
          if (dragDepth.current <= 0) setDragging(false)
        }}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        aria-label="Choose a data file, or drop one here"
        className={clsx(
          'df-card-raised group w-full cursor-pointer px-6 py-12 text-center transition-all duration-200',
          dragging
            ? 'scale-[1.01] shadow-[var(--e3)] ring-2 ring-accent'
            : 'hover:-translate-y-0.5 hover:shadow-[var(--e2)]',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.tsv,.txt,.json,.ndjson,.jsonl,text/csv,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void loadFile(file)
            e.target.value = ''
          }}
        />
        <div
          className={clsx(
            'mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl transition-transform duration-200',
            'bg-surface-2 group-hover:scale-105',
          )}
          style={{ boxShadow: 'var(--e1), var(--hl-top)' }}
        >
          <FileUp size={24} className={dragging ? 'text-accent' : 'text-ink-3'} strokeWidth={2.2} />
        </div>
        <p className="text-base font-semibold text-ink-1">
          {dragging ? 'Drop to explore it' : 'Drop a file here, or click to choose'}
        </p>
        <p className="mt-1.5 text-2xs text-ink-3">
          CSV · TSV · JSON · NDJSON — up to a few hundred megabytes
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="df-card w-full px-4 py-3 text-2xs text-critical"
          style={{ boxShadow: 'var(--e1), inset 0 0 0 1px color-mix(in oklab, var(--critical) 26%, transparent)' }}
        >
          {error}
        </div>
      )}

      <section className="w-full space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-1">
            <Sparkles size={15} className="text-accent" />
            No file handy? Generate one
          </h2>
          <label className="flex items-center gap-2 text-2xs text-ink-3">
            Rows
            <Select
              value={rows}
              onChange={(e) => setRows(Number(e.target.value))}
              className="w-32"
              aria-label="Number of rows to generate"
            >
              {ROW_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {formatCount(n)}
                </option>
              ))}
            </Select>
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {SAMPLE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => void loadSample(preset.id, rows)}
              className="df-card df-press flex flex-col gap-2 p-4 text-left"
            >
              <span className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: PRESET_HUE[preset.id] ?? 'var(--accent)' }}
                />
                <span className="text-[13px] font-semibold text-ink-1">{preset.name}</span>
              </span>
              <span className="text-2xs leading-relaxed text-ink-2">{preset.description}</span>
              <span className="mt-auto flex items-center gap-1.5 pt-1 text-2xs font-medium text-ink-3">
                <Zap size={11} />
                {preset.columns} columns
              </span>
            </button>
          ))}
        </div>
      </section>

      {storedDatasets.length > 0 && (
        <section className="w-full space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-1">
            <HardDriveDownload size={15} className="text-accent" />
            Saved in this browser
          </h2>
          <ul className="space-y-2">
            {storedDatasets.map((d) => (
              <li key={d.id} className="df-card flex items-center gap-3 px-4 py-3">
                <button
                  type="button"
                  onClick={() => void openStored(d.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <Database size={16} className="shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-2xs font-semibold text-ink-1">{d.name}</span>
                    <span className="block text-2xs text-ink-3">
                      {formatCount(d.rowCount)} rows · {formatBytes(d.bytes)}
                    </span>
                  </span>
                </button>
                <Button
                  variant="danger"
                  size="xs"
                  icon={<Trash2 size={13} />}
                  aria-label={`Delete ${d.name}`}
                  onClick={() => void deleteStored(d.id)}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

const PHASE_LABEL: Record<string, string> = {
  generating: 'Generating rows',
  reading: 'Reading the file',
  scanning: 'Scanning structure',
  parsing: 'Building columns',
  indexing: 'Indexing',
  querying: 'Querying',
  saving: 'Saving locally',
  loading: 'Loading from this browser',
}

function LoadingCard({ progress }: { progress: ReturnType<typeof useStore.getState>['progress'] }) {
  const ratio = progress?.ratio ?? -1
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-6 px-5 py-24">
      <div
        className="df-float grid h-16 w-16 place-items-center rounded-2xl"
        style={{
          backgroundImage: 'var(--grad-accent)',
          boxShadow: '0 10px 30px -8px var(--accent-glow), var(--hl-accent)',
        }}
      >
        <Database size={30} className="text-white" strokeWidth={2.2} />
      </div>
      <div className="w-full space-y-3 text-center">
        <p className="text-sm font-semibold text-ink-1">
          {PHASE_LABEL[progress?.phase ?? ''] ?? 'Working'}
        </p>
        <ProgressBar value={ratio} />
        <p className="tnum text-2xs text-ink-3">
          {progress?.rows != null && progress.rows > 0
            ? `${formatCount(progress.rows)} rows`
            : progress?.totalBytes
              ? `${formatBytes(progress.bytes ?? 0)} of ${formatBytes(progress.totalBytes)}`
              : 'Running in a background thread — the page stays responsive'}
        </p>
      </div>
    </div>
  )
}
