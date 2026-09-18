'use client'
import { BarChart3, Plus, Settings2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Chart } from '@/components/charts/Chart'
import { SidePanel } from '@/components/SidePanel'
import { EmptyNote } from '@/components/ViewsPanel'
import { Button, IconButton } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Field'
import { useStore } from '@/lib/state/store'
import { isQuantitative, type AggFn, type ChartSpec, type ChartType, type ColumnMeta } from '@/lib/types'

const TYPES: { id: ChartType; label: string }[] = [
  { id: 'bar', label: 'Bar' },
  { id: 'histogram', label: 'Histogram' },
  { id: 'line', label: 'Line' },
  { id: 'scatter', label: 'Scatter' },
  { id: 'pie', label: 'Donut' },
]

const AGGS: AggFn[] = ['count', 'sum', 'avg', 'min', 'max', 'median']

let chartSeq = 0

function defaultSpec(columns: ColumnMeta[]): ChartSpec | null {
  const categorical = columns.find((c) => c.kind === 'string' || c.kind === 'bool')
  const quantitative = columns.find((c) => c.kind === 'int' || c.kind === 'float')
  const x = categorical ?? quantitative ?? columns[0]
  if (!x) return null
  return {
    id: `chart_${++chartSeq}_${Date.now().toString(36)}`,
    title: categorical ? `Rows by ${x.name}` : `Distribution of ${x.name}`,
    type: categorical ? 'bar' : 'histogram',
    xColumnId: x.id,
    yColumnId: null,
    agg: 'count',
    bins: 30,
    limit: 12,
    seriesColumnId: null,
  }
}

export function ChartsPanel() {
  const meta = useStore((s) => s.meta)
  const charts = useStore((s) => s.charts)
  const chartData = useStore((s) => s.chartData)
  const addChart = useStore((s) => s.addChart)
  const removeChart = useStore((s) => s.removeChart)
  const setPanel = useStore((s) => s.setPanel)
  const addFilter = useStore((s) => s.addFilter)

  const [editing, setEditing] = useState<string | null>(null)

  if (!meta) return null

  return (
    <SidePanel
      title="Charts"
      subtitle="Built from the rows currently matching your filters"
      onClose={() => setPanel(null)}
      actions={
        <Button
          size="xs"
          variant="soft"
          icon={<Plus size={12} />}
          onClick={() => {
            const spec = defaultSpec(meta.columns)
            if (spec) addChart(spec)
          }}
        >
          Add
        </Button>
      }
    >
      {charts.length === 0 ? (
        <EmptyNote
          icon={<BarChart3 size={18} />}
          title="No charts yet"
          body="Add one to see the shape of the rows you have filtered down to. Click a bar to filter by it."
        />
      ) : (
        <ul className="space-y-2.5">
          {charts.map((spec) => (
            <li key={spec.id} className="df-card p-3">
              <div className="mb-1.5 flex items-center gap-1.5">
                <h3 className="min-w-0 flex-1 truncate text-2xs font-semibold text-ink-1">
                  {spec.title}
                </h3>
                <IconButton
                  label="Configure chart"
                  size="xs"
                  icon={<Settings2 size={12} />}
                  active={editing === spec.id}
                  onClick={() => setEditing(editing === spec.id ? null : spec.id)}
                />
                <IconButton
                  label="Remove chart"
                  size="xs"
                  variant="danger"
                  icon={<Trash2 size={12} />}
                  onClick={() => removeChart(spec.id)}
                />
              </div>

              {editing === spec.id && <ChartEditor spec={spec} columns={meta.columns} />}

              {chartData[spec.id] ? (
                <Chart
                  data={chartData[spec.id]}
                  height={190}
                  onSelectCategory={(label) => {
                    addFilter({
                      id: `f_chart_${Date.now().toString(36)}`,
                      columnId: spec.xColumnId,
                      op: 'eq',
                      value: label,
                      enabled: true,
                      caseSensitive: false,
                    })
                  }}
                />
              ) : (
                <div className="df-skeleton h-[190px] w-full rounded-xl" />
              )}
            </li>
          ))}
        </ul>
      )}
    </SidePanel>
  )
}

function ChartEditor({ spec, columns }: { spec: ChartSpec; columns: ColumnMeta[] }) {
  const updateChart = useStore((s) => s.updateChart)
  const measures = columns.filter((c) => isQuantitative(c.kind))
  const patch = (p: Partial<ChartSpec>) => updateChart(spec.id, p)

  return (
    <div className="df-sunken df-in mb-2.5 space-y-2 p-2.5">
      <Input
        value={spec.title}
        onChange={(e) => patch({ title: e.target.value })}
        aria-label="Chart title"
        placeholder="Title"
      />
      <div className="flex flex-wrap gap-1.5">
        {TYPES.map((t) => (
          <Button
            key={t.id}
            size="xs"
            variant={spec.type === t.id ? 'primary' : 'soft'}
            onClick={() => patch({ type: t.id })}
          >
            {t.label}
          </Button>
        ))}
      </div>
      <label className="block">
        <span className="text-2xs text-ink-3">X axis</span>
        <Select
          value={spec.xColumnId}
          onChange={(e) => patch({ xColumnId: e.target.value })}
          aria-label="X axis column"
        >
          {columns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </label>

      {spec.type !== 'histogram' && (
        <div className="flex gap-1.5">
          <label className="flex-1">
            <span className="text-2xs text-ink-3">Measure</span>
            <Select
              value={spec.yColumnId ?? ''}
              onChange={(e) => patch({ yColumnId: e.target.value || null })}
              aria-label="Measure column"
            >
              <option value="">Row count</option>
              {measures.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="w-24">
            <span className="text-2xs text-ink-3">Aggregate</span>
            <Select
              value={spec.agg}
              onChange={(e) => patch({ agg: e.target.value as AggFn })}
              disabled={!spec.yColumnId}
              aria-label="Aggregation"
            >
              {AGGS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </label>
        </div>
      )}

      {spec.type === 'histogram' ? (
        <label className="block">
          <span className="text-2xs text-ink-3">Bins: {spec.bins}</span>
          <input
            type="range"
            min={5}
            max={120}
            value={spec.bins}
            onChange={(e) => patch({ bins: Number(e.target.value) })}
            className="w-full accent-[var(--accent)]"
            aria-label="Bin count"
          />
        </label>
      ) : spec.type === 'bar' || spec.type === 'pie' ? (
        <label className="block">
          <span className="text-2xs text-ink-3">Top {spec.limit} categories</span>
          <input
            type="range"
            min={3}
            max={30}
            value={spec.limit}
            onChange={(e) => patch({ limit: Number(e.target.value) })}
            className="w-full accent-[var(--accent)]"
            aria-label="Category limit"
          />
        </label>
      ) : null}
    </div>
  )
}
