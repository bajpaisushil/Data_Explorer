'use client'
import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { drawChart, readTheme, setupCanvas, type HitMap, type HitPoint, type Theme } from './canvas'
import { formatCompact, formatDate, formatNumber, seriesVar } from '@/lib/format'
import type { ChartData } from '@/lib/types'

export interface ChartProps {
  data: ChartData
  height?: number
  className?: string
  onSelectCategory?: (label: string) => void
}

export function Chart({ data, height = 200, className, onSelectCategory }: ChartProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hitRef = useRef<HitMap | null>(null)
  const themeRef = useRef<Theme | null>(null)

  const [size, setSize] = useState({ width: 0, height })
  const [hover, setHover] = useState<HitPoint | null>(null)
  const [themeTick, setThemeTick] = useState(0)

  // Re-read the palette whenever the theme can change: the explicit stamp on
  // <html> and the OS setting are two independent sources.
  useEffect(() => {
    const bump = () => setThemeTick((t) => t + 1)
    const observer = new MutationObserver(bump)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', bump)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', bump)
    }
  }, [])

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = () => setSize({ width: host.clientWidth, height })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return () => ro.disconnect()
  }, [height])

  const paint = useCallback(
    (hoverPos: { x: number; y: number } | null) => {
      const canvas = canvasRef.current
      const host = hostRef.current
      if (!canvas || !host || size.width < 2) return
      const theme = readTheme(host)
      themeRef.current = theme
      const ctx = setupCanvas(canvas, size.width, size.height)
      if (!ctx) return
      hitRef.current = drawChart(ctx, data, theme, { width: size.width, height: size.height }, hoverPos)
    },
    [data, size.width, size.height],
  )

  useEffect(() => {
    paint(null)
  }, [paint, themeTick])

  const onPointer = (e: React.PointerEvent) => {
    const canvas = canvasRef.current
    if (!canvas || !hitRef.current) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const found = hitRef.current.hit(x, y)
    setHover(found)
    if (data.type === 'line' || data.type === 'histogram') paint({ x, y })
  }

  const leave = () => {
    setHover(null)
    paint(null)
  }

  const clickable = !!onSelectCategory && (data.type === 'bar' || data.type === 'pie')
  const multi = data.series.length > 1

  const formatX = (label: string) => label
  const empty = !data.series.length || data.series.every((s) => s.y.length === 0)

  return (
    <div
      ref={hostRef}
      className={clsx('relative w-full select-none', className)}
      style={{ height }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`${data.type} chart of ${data.yLabel} by ${data.xLabel}${
          data.truncated ? `, top categories of ${data.totalCategories}` : ''
        }`}
        className={clsx('block h-full w-full rounded-xl', clickable && hover && 'cursor-pointer')}
        onPointerMove={onPointer}
        onPointerLeave={leave}
        onClick={() => {
          if (clickable && hover && hover.label !== 'Other') onSelectCategory?.(hover.label)
        }}
      />

      {hover && (
        <div
          role="tooltip"
          className="df-card-raised pointer-events-none absolute z-10 max-w-52 px-2.5 py-1.5 shadow-[var(--e3)]"
          style={{
            left: Math.min(Math.max(8, hover.x + 12), Math.max(8, size.width - 150)),
            top: Math.max(4, hover.y - 46),
          }}
        >
          <p className="truncate text-2xs font-semibold text-ink-1">{formatX(hover.label)}</p>
          <p className="tnum text-2xs text-ink-2">
            {data.yLabel}: {formatNumber(hover.value, { maxFrac: 4 })}
          </p>
          {clickable && hover.label !== 'Other' && (
            <p className="mt-0.5 text-2xs text-ink-3">Click to filter</p>
          )}
        </div>
      )}

      {multi && (
        <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 pb-0.5">
          {data.series.map((s, i) => (
            <span key={s.name} className="flex items-center gap-1.5 text-2xs text-ink-2">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: s.name === 'Other' ? 'var(--ink-3)' : seriesVar(i) }}
              />
              {s.name}
            </span>
          ))}
        </div>
      )}

      {data.truncated && !empty && (
        <p className="absolute top-1 right-2 text-2xs text-ink-3">
          top {(data.xLabels?.length ?? 1) - 1} of {formatCompact(data.totalCategories)}
        </p>
      )}

      {/* The table view satisfies both screen readers and the contrast relief
          rule for the light-mode series slots that sit below 3:1. */}
      <table className="sr-only">
        <caption>
          {data.yLabel} by {data.xLabel}
        </caption>
        <thead>
          <tr>
            <th scope="col">{data.xLabel}</th>
            {data.series.map((s) => (
              <th key={s.name} scope="col">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: data.series[0]?.y.length ?? 0 }).map((_, row) => (
            <tr key={row}>
              <th scope="row">
                {data.xLabels
                  ? data.xLabels[row]
                  : data.x
                    ? data.xIsDate
                      ? formatDate(data.x[row])
                      : formatNumber(data.x[row], { maxFrac: 3 })
                    : row}
              </th>
              {data.series.map((s) => (
                <td key={s.name}>{formatNumber(s.y[row], { maxFrac: 4 })}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
