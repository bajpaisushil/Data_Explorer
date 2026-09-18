'use client'
import clsx from 'clsx'
import { ChevronDown, Table2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { EmptyNote } from '@/components/ViewsPanel'
import { SidePanel } from '@/components/SidePanel'
import { Sparkline } from '@/components/charts/Sparkline'
import { Pill } from '@/components/ui/Button'
import { getEngine } from '@/lib/engine/client'
import { formatCompact, formatCount, formatDate, formatNumber, kindColorVar, kindLabel, kindShort } from '@/lib/format'
import { useStore } from '@/lib/state/store'
import type { ColumnMeta, ColumnStats } from '@/lib/types'

export function ProfilePanel() {
  const meta = useStore((s) => s.meta)
  const profiles = useStore((s) => s.profiles)
  const result = useStore((s) => s.result)
  const setPanel = useStore((s) => s.setPanel)
  const [openId, setOpenId] = useState<string | null>(null)

  if (!meta) return null
  const loading = Object.keys(profiles).length === 0

  return (
    <SidePanel
      title="Data profile"
      subtitle={
        result
          ? `Computed over the ${formatCount(result.matched)} matching rows`
          : 'Computed over the current result set'
      }
      onClose={() => setPanel(null)}
    >
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="df-card h-16 p-3">
              <div className="df-skeleton h-3 w-24" />
              <div className="df-skeleton mt-2 h-2 w-full" />
            </div>
          ))}
        </div>
      ) : result && result.matched === 0 ? (
        <EmptyNote
          icon={<Table2 size={18} />}
          title="No rows match"
          body="Loosen a filter to see the profile come back."
        />
      ) : (
        <ul className="space-y-1.5">
          {meta.columns.map((col) => (
            <ColumnCard
              key={col.id}
              column={col}
              spark={profiles[col.id]?.spark ?? []}
              completeness={profiles[col.id]?.completeness ?? 0}
              open={openId === col.id}
              onToggle={() => setOpenId(openId === col.id ? null : col.id)}
            />
          ))}
        </ul>
      )}
    </SidePanel>
  )
}

function ColumnCard({
  column,
  spark,
  completeness,
  open,
  onToggle,
}: {
  column: ColumnMeta
  spark: number[]
  completeness: number
  open: boolean
  onToggle: () => void
}) {
  const complete = Math.round(completeness * 100)
  return (
    <li className="df-card overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-surface-2"
      >
        <Pill hue={kindColorVar(column.kind)} className="shrink-0 font-mono" title={kindLabel(column.kind)}>
          {kindShort(column.kind)}
        </Pill>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-2xs font-semibold text-ink-1">{column.name}</span>
          <span className="tnum block text-2xs text-ink-3">
            {complete}% filled
            {column.distinctCount >= 0 && ` · ${formatCompact(column.distinctCount)} distinct`}
          </span>
        </span>
        <span className="shrink-0 text-ink-3">
          <Sparkline values={spark} width={64} height={22} kind={column.kind === 'string' || column.kind === 'bool' ? 'bar' : 'line'} />
        </span>
        <ChevronDown
          size={14}
          className={clsx('shrink-0 text-ink-3 transition-transform', open && 'rotate-180')}
        />
      </button>

      <div className="df-sunken mx-3 mb-2 h-1.5 overflow-hidden rounded-full">
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{
            width: `${Math.max(1, complete)}%`,
            background: complete === 100 ? 'var(--good)' : 'var(--grad-accent)',
          }}
        />
      </div>

      {open && <ColumnDetail column={column} />}
    </li>
  )
}

function ColumnDetail({ column }: { column: ColumnMeta }) {
  // Tagged with the column id, so a response for a previously expanded column
  // can never be shown against this one.
  const [result, setResult] = useState<{ id: string; stats: ColumnStats | null; error: string | null }>({
    id: '',
    stats: null,
    error: null,
  })
  const fresh = result.id === column.id
  const stats = fresh ? result.stats : null
  const error = fresh ? result.error : null

  useEffect(() => {
    let live = true
    getEngine()
      .request({ kind: 'stats', columnId: column.id })
      .then((s) => {
        if (live) setResult({ id: column.id, stats: s, error: null })
      })
      .catch((e: Error) => {
        if (live) setResult({ id: column.id, stats: null, error: e.message })
      })
    return () => {
      live = false
    }
  }, [column.id])

  if (error) return <p className="px-3 pb-3 text-2xs text-critical">{error}</p>
  if (!stats) {
    return (
      <div className="space-y-1.5 px-3 pb-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="df-skeleton h-3 w-full" />
        ))}
      </div>
    )
  }

  const isDate = column.kind === 'date'
  const num = (v: number) => (isDate ? formatDate(v) : formatNumber(v, { maxFrac: 4 }))
  const shell = 'df-in grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 pb-3.5 text-2xs'

  // Discriminants are checked positively. QuantitativeStats carries a union
  // kind ('numeric' | 'date'), and TypeScript will not subtract a constituent
  // whose discriminant is itself a union, so testing for it last is what keeps
  // every branch correctly narrowed.
  if (stats.kind === 'categorical') {
    return (
      <dl className={shell}>
        <Row label="Distinct" value={stats.distinct < 0 ? 'many' : formatCount(stats.distinct)} />
        <Row label="Nulls" value={formatCount(stats.nulls)} />
        <Row label="Empty" value={formatCount(stats.emptyCount)} />
        <Row label="Avg length" value={formatNumber(stats.avgLength, { maxFrac: 1 })} />
        <div className="col-span-2 mt-1 space-y-1">
          <p className="text-2xs font-semibold text-ink-3 uppercase">Most common</p>
          {stats.top.slice(0, 8).map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-ink-1" title={t.value ?? 'null'}>
                {t.value === null ? (
                  <em className="text-ink-3">null</em>
                ) : (
                  t.value || <em className="text-ink-3">empty</em>
                )}
              </span>
              <span className="tnum text-ink-3">{formatCompact(t.count)}</span>
            </div>
          ))}
        </div>
      </dl>
    )
  }

  if (stats.kind === 'bool') {
    return (
      <dl className={shell}>
        <Row label="True" value={formatCount(stats.trueCount)} />
        <Row label="False" value={formatCount(stats.falseCount)} />
        <Row label="Nulls" value={formatCount(stats.nulls)} />
      </dl>
    )
  }

  return (
    <dl className={shell}>
      <Row label="Min" value={num(stats.min)} />
      <Row label="Max" value={num(stats.max)} />
      <Row label="Mean" value={num(stats.mean)} />
      <Row label="Median" value={num(stats.median)} />
      <Row label="p25" value={num(stats.p25)} />
      <Row label="p75" value={num(stats.p75)} />
      <Row label="p95" value={num(stats.p95)} />
      <Row label="Std dev" value={formatNumber(stats.stdev, { maxFrac: 4 })} />
      {!isDate && <Row label="Sum" value={formatCompact(stats.sum)} />}
      <Row label="Outliers" value={formatCount(stats.outlierCount)} />
      <Row label="Nulls" value={formatCount(stats.nulls)} />
      <Row label="Distinct" value={stats.distinct < 0 ? 'many' : formatCount(stats.distinct)} />
    </dl>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-ink-3">{label}</dt>
      <dd className="tnum truncate font-medium text-ink-1" title={value}>
        {value}
      </dd>
    </div>
  )
}
