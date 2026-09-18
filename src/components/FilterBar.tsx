'use client'
import clsx from 'clsx'
import { Filter as FilterIcon, Group, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button, IconButton, Pill } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Field'
import { MenuItem, MenuLabel, MenuSeparator, Popover } from '@/components/ui/Popover'
import { getEngine } from '@/lib/engine/client'
import { formatCount, kindColorVar } from '@/lib/format'
import { useStore } from '@/lib/state/store'
import {
  isQuantitative,
  type AggFn,
  type ColumnMeta,
  type Filter,
  type FilterOp,
  type ValueCount,
} from '@/lib/types'

const OP_LABEL: Record<FilterOp, string> = {
  eq: 'is',
  ne: 'is not',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'between',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  endsWith: 'ends with',
  in: 'is any of',
  notIn: 'is none of',
  regex: 'matches regex',
  isEmpty: 'is empty',
  isTrue: 'is true',
  isFalse: 'is false',
  isNull: 'is null',
  notNull: 'is not null',
}

const QUANT_OPS: FilterOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull', 'notNull']
const STRING_OPS: FilterOp[] = [
  'contains',
  'notContains',
  'eq',
  'ne',
  'startsWith',
  'endsWith',
  'in',
  'notIn',
  'regex',
  'isEmpty',
  'isNull',
  'notNull',
]
const BOOL_OPS: FilterOp[] = ['isTrue', 'isFalse', 'isNull', 'notNull']

const NO_OPERAND = new Set<FilterOp>(['isNull', 'notNull', 'isEmpty', 'isTrue', 'isFalse'])

function opsFor(kind: ColumnMeta['kind']): FilterOp[] {
  if (kind === 'bool') return BOOL_OPS
  if (kind === 'string') return STRING_OPS
  return QUANT_OPS
}

let filterSeq = 0
const nextId = () => `f${++filterSeq}_${Date.now().toString(36)}`

export function FilterBar() {
  const meta = useStore((s) => s.meta)
  const filters = useStore((s) => s.query.filters)
  const group = useStore((s) => s.query.group)
  const result = useStore((s) => s.result)
  const search = useStore((s) => s.query.search)
  const removeFilter = useStore((s) => s.removeFilter)
  const clearFilters = useStore((s) => s.clearFilters)

  if (!meta) return null

  const byId = new Map(meta.columns.map((c) => [c.id, c]))
  const hasAny = filters.length > 0 || !!search || !!group

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 pb-2.5 sm:px-4">
      <Popover
        trigger={({ toggle }) => (
          <Button size="sm" variant="soft" icon={<Plus size={13} />} onClick={toggle}>
            Filter
          </Button>
        )}
        panelClassName="w-80 p-3"
      >
        {(close) => <FilterComposer columns={meta.columns} onDone={close} />}
      </Popover>

      <GroupControl columns={meta.columns} />

      {filters.map((f) => {
        const col = byId.get(f.columnId)
        if (!col) return null
        return <FilterChip key={f.id} filter={f} column={col} onRemove={() => removeFilter(f.id)} />
      })}

      {search && (
        <Pill hue="var(--accent)" icon={<FilterIcon size={11} />}>
          search “{search.term}”
        </Pill>
      )}

      {hasAny && (
        <Button size="xs" variant="ghost" onClick={clearFilters}>
          Clear all
        </Button>
      )}

      {result && (
        <span className="tnum ml-auto text-2xs text-ink-3">
          {result.matched === result.total ? (
            <>{formatCount(result.total)} rows</>
          ) : (
            <>
              <span className="font-semibold text-ink-1">{formatCount(result.matched)}</span> of{' '}
              {formatCount(result.total)} rows
            </>
          )}
        </span>
      )}
    </div>
  )
}

function FilterChip({
  filter,
  column,
  onRemove,
}: {
  filter: Filter
  column: ColumnMeta
  onRemove: () => void
}) {
  const updateFilter = useStore((s) => s.updateFilter)

  return (
    <span
      style={{ ['--tint-hue' as string]: kindColorVar(column.kind) }}
      className={clsx(
        'df-tint df-press inline-flex max-w-full items-center gap-1.5 rounded-full py-1 pr-1 pl-2.5 text-2xs',
        !filter.enabled && 'opacity-50',
      )}
    >
      <button
        type="button"
        onClick={() => updateFilter(filter.id, { enabled: !filter.enabled })}
        title={filter.enabled ? 'Disable this filter' : 'Enable this filter'}
        className="min-w-0 truncate font-semibold"
      >
        {column.name} <span className="font-normal opacity-80">{describe(filter)}</span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter on ${column.name}`}
        className="grid h-5 w-5 shrink-0 place-items-center rounded-full hover:bg-black/10"
      >
        <X size={11} />
      </button>
    </span>
  )
}

function describe(f: Filter): string {
  const label = OP_LABEL[f.op]
  if (NO_OPERAND.has(f.op)) return label
  if (f.op === 'between') return `${label} ${f.value ?? ''} – ${f.value2 ?? ''}`
  if (f.op === 'in' || f.op === 'notIn') {
    const n = f.values?.length ?? 0
    return `${label} ${n} value${n === 1 ? '' : 's'}`
  }
  return `${label} ${f.value ?? ''}`
}

function FilterComposer({ columns, onDone }: { columns: ColumnMeta[]; onDone: () => void }) {
  const addFilter = useStore((s) => s.addFilter)
  const [columnId, setColumnId] = useState(columns[0]?.id ?? '')
  const column = columns.find((c) => c.id === columnId) ?? columns[0]
  const ops = useMemo(() => (column ? opsFor(column.kind) : []), [column])
  const [op, setOp] = useState<FilterOp>(ops[0])
  const [value, setValue] = useState('')
  const [value2, setValue2] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [lastColumnId, setLastColumnId] = useState(columnId)

  // Switching column invalidates the operator and operands.
  if (columnId !== lastColumnId) {
    setLastColumnId(columnId)
    setOp(ops[0])
    setValue('')
    setValue2('')
    setPicked([])
  }

  if (!column) return null

  const isList = op === 'in' || op === 'notIn'
  const needsOperand = !NO_OPERAND.has(op)
  const isDate = column.kind === 'date'
  const isNum = isQuantitative(column.kind) && !isDate

  const submit = () => {
    const filter: Filter = { id: nextId(), columnId, op, enabled: true, caseSensitive: false }
    if (isList) {
      if (!picked.length) return
      filter.values = picked
    } else if (needsOperand) {
      if (value === '') return
      filter.value = isNum ? Number(value) : isDate ? Date.parse(value) : value
      if (op === 'between') {
        filter.value2 = isNum ? Number(value2) : isDate ? Date.parse(value2) : value2
      }
    }
    addFilter(filter)
    onDone()
  }

  return (
    <div className="space-y-2.5">
      <MenuLabel>Add a filter</MenuLabel>
      <Select value={columnId} onChange={(e) => setColumnId(e.target.value)} aria-label="Column">
        {columns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      <Select value={op} onChange={(e) => setOp(e.target.value as FilterOp)} aria-label="Condition">
        {ops.map((o) => (
          <option key={o} value={o}>
            {OP_LABEL[o]}
          </option>
        ))}
      </Select>

      {isList ? (
        <ValuePicker columnId={columnId} picked={picked} onChange={setPicked} />
      ) : needsOperand ? (
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            type={isNum ? 'number' : isDate ? 'date' : 'text'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Value"
            aria-label="Value"
          />
          {op === 'between' && (
            <>
              <span className="text-2xs text-ink-3">to</span>
              <Input
                type={isNum ? 'number' : isDate ? 'date' : 'text'}
                value={value2}
                onChange={(e) => setValue2(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder="Value"
                aria-label="Upper bound"
              />
            </>
          )}
        </div>
      ) : null}

      <Button variant="primary" size="sm" block onClick={submit}>
        Apply filter
      </Button>
    </div>
  )
}

function ValuePicker({
  columnId,
  picked,
  onChange,
}: {
  columnId: string
  picked: string[]
  onChange: (next: string[]) => void
}) {
  const [term, setTerm] = useState('')
  // Results are tagged with the request they answer, so "loading" is derived
  // rather than a second piece of state that can drift out of sync.
  const requestKey = `${columnId}\u0000${term}`
  const [data, setData] = useState<{ key: string; values: ValueCount[] }>({ key: '', values: [] })
  const loading = data.key !== requestKey
  const values = data.values

  useEffect(() => {
    let live = true
    getEngine()
      .request({ kind: 'distinct', columnId, limit: 200, search: term, global: true })
      .then((v) => {
        if (live) setData({ key: requestKey, values: v })
      })
      .catch(() => {
        if (live) setData({ key: requestKey, values: [] })
      })
    return () => {
      live = false
    }
  }, [columnId, term, requestKey])

  const toggle = (v: string) =>
    onChange(picked.includes(v) ? picked.filter((p) => p !== v) : [...picked, v])

  return (
    <div className="space-y-2">
      <Input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Find a value…"
        aria-label="Find a value"
      />
      <div className="df-sunken max-h-52 overflow-y-auto p-1">
        {loading ? (
          <div className="space-y-1.5 p-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="df-skeleton h-4 w-full" />
            ))}
          </div>
        ) : values.length === 0 ? (
          <p className="p-3 text-center text-2xs text-ink-3">No values</p>
        ) : (
          values.map((v, i) => (
            <label
              key={`${i}-${v.value ?? 'null'}`}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2"
            >
              <input
                type="checkbox"
                checked={picked.includes(v.value ?? '')}
                onChange={() => toggle(v.value ?? '')}
                className="h-3.5 w-3.5 rounded accent-[var(--accent)]"
              />
              <span className="min-w-0 flex-1 truncate text-2xs text-ink-1">
                {v.value === null ? (
                  <em className="text-ink-3">null</em>
                ) : v.value === '' ? (
                  <em className="text-ink-3">empty</em>
                ) : (
                  v.value
                )}
              </span>
              <span className="tnum text-2xs text-ink-3">{formatCount(v.count)}</span>
            </label>
          ))
        )}
      </div>
      {picked.length > 0 && (
        <p className="text-2xs text-ink-3">
          {picked.length} selected ·{' '}
          <button type="button" className="underline" onClick={() => onChange([])}>
            clear
          </button>
        </p>
      )}
    </div>
  )
}

const AGGS: AggFn[] = ['count', 'sum', 'avg', 'min', 'max', 'median', 'distinct', 'nulls']

function GroupControl({ columns }: { columns: ColumnMeta[] }) {
  const group = useStore((s) => s.query.group)
  const setGroup = useStore((s) => s.setGroup)

  const active = !!group?.columnIds.length
  const groupable = columns.filter((c) => c.kind !== 'float')
  const measures = columns.filter((c) => isQuantitative(c.kind))

  return (
    <Popover
      trigger={({ toggle }) => (
        <Button size="sm" variant="soft" active={active} icon={<Group size={13} />} onClick={toggle}>
          {active
            ? group.columnIds.map((id) => columns.find((c) => c.id === id)?.name ?? id).join(' › ')
            : 'Group'}
        </Button>
      )}
      panelClassName="w-72 p-3"
    >
      {(close) => (
        <div className="space-y-2.5">
          <MenuLabel>Group rows by</MenuLabel>
          <div className="df-sunken max-h-44 overflow-y-auto p-1">
            {groupable.map((c) => {
              const checked = group?.columnIds.includes(c.id) ?? false
              return (
                <label
                  key={c.id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const ids = group?.columnIds ?? []
                      const next = checked ? ids.filter((i) => i !== c.id) : [...ids, c.id]
                      setGroup(next.length ? { columnIds: next, aggs: group?.aggs ?? [] } : null)
                    }}
                    className="h-3.5 w-3.5 rounded accent-[var(--accent)]"
                  />
                  <span className="truncate text-2xs text-ink-1">{c.name}</span>
                </label>
              )
            })}
          </div>

          {group && active && (
            <>
              <MenuSeparator />
              <MenuLabel>Measures</MenuLabel>
              {group.aggs.map((a, i) => (
                <div key={a.id} className="flex items-center gap-1.5">
                  <Select
                    value={a.fn}
                    onChange={(e) => {
                      const aggs = [...group.aggs]
                      aggs[i] = { ...a, fn: e.target.value as AggFn }
                      setGroup({ ...group, aggs })
                    }}
                    className="w-24"
                    aria-label="Aggregation"
                  >
                    {AGGS.map((fn) => (
                      <option key={fn} value={fn}>
                        {fn}
                      </option>
                    ))}
                  </Select>
                  <Select
                    value={a.columnId}
                    onChange={(e) => {
                      const aggs = [...group.aggs]
                      aggs[i] = { ...a, columnId: e.target.value }
                      setGroup({ ...group, aggs })
                    }}
                    aria-label="Measure column"
                  >
                    {columns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                  <IconButton
                    label="Remove measure"
                    size="xs"
                    icon={<X size={12} />}
                    onClick={() => setGroup({ ...group, aggs: group.aggs.filter((x) => x.id !== a.id) })}
                  />
                </div>
              ))}
              <Button
                size="xs"
                variant="soft"
                block
                icon={<Plus size={12} />}
                disabled={!measures.length}
                onClick={() =>
                  setGroup({
                    ...group,
                    aggs: [...group.aggs, { id: nextId(), columnId: measures[0].id, fn: 'sum' }],
                  })
                }
              >
                Add measure
              </Button>
              <MenuItem
                destructive
                icon={<X size={13} />}
                onClick={() => {
                  setGroup(null)
                  close()
                }}
              >
                Stop grouping
              </MenuItem>
            </>
          )}
        </div>
      )}
    </Popover>
  )
}
