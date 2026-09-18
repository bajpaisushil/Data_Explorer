'use client'
import clsx from 'clsx'

export interface SparklineProps {
  values: number[]
  width?: number
  height?: number
  kind?: 'bar' | 'line'
  className?: string
}

/**
 * Inline SVG rather than canvas: one of these sits in every column header, so
 * sixty of them must cost close to nothing. Draws in currentColor so the
 * caller controls the tone.
 */
export function Sparkline({ values, width = 64, height = 20, kind = 'bar', className }: SparklineProps) {
  const n = values.length
  if (!n) return <svg width={width} height={height} className={className} aria-hidden />

  let max = 0
  for (let i = 0; i < n; i++) {
    const v = values[i]
    if (Number.isFinite(v) && v > max) max = v
  }
  // An all-zero column still renders a flat baseline rather than nothing.
  const scale = max > 0 ? (height - 2) / max : 0

  if (kind === 'line') {
    const step = n > 1 ? width / (n - 1) : 0
    let d = ''
    for (let i = 0; i < n; i++) {
      const v = Number.isFinite(values[i]) ? values[i] : 0
      const x = n > 1 ? i * step : width / 2
      const y = height - 1 - v * scale
      d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    }
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={clsx('overflow-visible', className)}
        aria-hidden
      >
        <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    )
  }

  const slot = width / n
  const barW = Math.max(1, slot - 1)

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      {values.map((v, i) => {
        const value = Number.isFinite(v) ? v : 0
        const h = Math.max(value > 0 ? 1 : 0.5, value * scale)
        return (
          <rect
            key={i}
            x={i * slot}
            y={height - h}
            width={barW}
            height={h}
            rx={Math.min(1.5, barW / 2)}
            fill="currentColor"
          />
        )
      })}
    </svg>
  )
}
