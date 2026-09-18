/**
 * Canvas drawing for the explorer's charts.
 *
 * Colours are never hardcoded — they are resolved from the CSS custom
 * properties on the chart's own container, so the same code renders correctly
 * in light and dark without a second palette. Layout maths is kept in exported
 * helpers so it stays testable independently of the drawing.
 */

import type { ChartData } from '@/lib/types'
import { formatCompact, formatDate, formatNumber } from '@/lib/format'

export interface Theme {
  surface: string
  ink1: string
  ink2: string
  ink3: string
  line1: string
  line2: string
  series: string[]
  accent: string
}

export interface HitPoint {
  seriesIndex: number
  pointIndex: number
  label: string
  value: number
  x: number
  y: number
}

export interface HitMap {
  hit(x: number, y: number): HitPoint | null
}

const NO_HITS: HitMap = { hit: () => null }

export function readTheme(el: HTMLElement): Theme {
  const cs = getComputedStyle(el)
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  const series: string[] = []
  for (let i = 1; i <= 8; i++) series.push(get(`--series-${i}`, '#2a78d6'))
  return {
    surface: get('--surface-1', '#ffffff'),
    ink1: get('--ink-1', '#1a1826'),
    ink2: get('--ink-2', '#5b5674'),
    ink3: get('--ink-3', '#7a7591'),
    line1: get('--line-1', '#ece8f6'),
    line2: get('--line-2', '#ddd7ee'),
    series,
    accent: get('--accent', '#5a63e0'),
  }
}

export function setupCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1)
  canvas.width = Math.max(1, Math.round(width * dpr))
  canvas.height = Math.max(1, Math.round(height * dpr))
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  return ctx
}

const TICK_STEPS = [1, 2, 2.5, 5, 10]

export function niceTicks(min: number, max: number, target: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min === max) return [min]
  if (min > max) [min, max] = [max, min]

  const want = Math.max(2, Math.min(12, Math.round(target) || 5))
  const raw = (max - min) / want
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)))
  let step = magnitude * TICK_STEPS[TICK_STEPS.length - 1]
  for (const s of TICK_STEPS) {
    if (magnitude * s >= raw) {
      step = magnitude * s
      break
    }
  }

  const out: number[] = []
  const first = Math.ceil(min / step) * step
  // Guard against a pathological step producing an unbounded loop.
  for (let v = first, i = 0; v <= max + step * 1e-9 && i < 200; v += step, i++) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v)
  }
  return out
}

/* ------------------------------------------------------------------ paths */

/** Rounded only on the data end; the baseline end stays square and anchored. */
function barPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, w / 2, Math.abs(h)))
  ctx.beginPath()
  if (h >= 0) {
    ctx.moveTo(x, y + h)
    ctx.lineTo(x, y + radius)
    ctx.quadraticCurveTo(x, y, x + radius, y)
    ctx.lineTo(x + w - radius, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
    ctx.lineTo(x + w, y + h)
  } else {
    ctx.moveTo(x, y + h)
    ctx.lineTo(x, y - radius)
    ctx.quadraticCurveTo(x, y, x + radius, y)
    ctx.lineTo(x + w - radius, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y - radius)
    ctx.lineTo(x + w, y + h)
  }
  ctx.closePath()
}

interface Plot {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

function axisText(ctx: CanvasRenderingContext2D, theme: Theme) {
  ctx.fillStyle = theme.ink3
  ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif'
}

function drawYAxis(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  plot: Plot,
  min: number,
  max: number,
): void {
  const ticks = niceTicks(min, max, Math.max(2, Math.floor(plot.height / 44)))
  axisText(ctx, theme)
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'

  for (const t of ticks) {
    const y = plot.bottom - ((t - min) / (max - min || 1)) * plot.height
    ctx.strokeStyle = theme.line1
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(plot.left, Math.round(y) + 0.5)
    ctx.lineTo(plot.right, Math.round(y) + 0.5)
    ctx.stroke()
    ctx.fillStyle = theme.ink3
    ctx.fillText(formatCompact(t), plot.left - 8, y)
  }
}

function seriesColor(theme: Theme, index: number, name: string): string {
  // "Other" is never a hue — it is the neutral ink, so it cannot be mistaken
  // for a real category.
  if (name === 'Other') return theme.ink3
  return index < 8 ? theme.series[index] : theme.ink3
}

/* ------------------------------------------------------------------- draw */

export function drawChart(
  ctx: CanvasRenderingContext2D,
  data: ChartData,
  theme: Theme,
  layout: { width: number; height: number },
  hover: { x: number; y: number } | null,
): HitMap {
  const { width, height } = layout
  ctx.clearRect(0, 0, width, height)

  const hasData = data.series.length > 0 && data.series.some((s) => s.y.length > 0)
  if (!hasData) {
    axisText(ctx, theme)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('No data to plot', width / 2, height / 2)
    return NO_HITS
  }

  if (data.type === 'pie') return drawDonut(ctx, data, theme, layout, hover)

  const compact = width < 420
  const plot: Plot = {
    left: compact ? 40 : 52,
    top: 10,
    right: width - 10,
    bottom: height - (data.xLabels ? 40 : 26),
    width: 0,
    height: 0,
  }
  plot.width = Math.max(1, plot.right - plot.left)
  plot.height = Math.max(1, plot.bottom - plot.top)

  let min = 0
  let max = -Infinity
  for (const s of data.series) {
    for (let i = 0; i < s.y.length; i++) {
      const v = s.y[i]
      if (!Number.isFinite(v)) continue
      if (v > max) max = v
      if (v < min) min = v
    }
  }
  if (!Number.isFinite(max)) max = 1
  if (max === min) max = min + 1
  // Headroom, so the tallest mark and its value label do not collide with the
  // top edge of the plot.
  max += (max - min) * 0.08

  drawYAxis(ctx, theme, plot, min, max)

  const scaleY = (v: number) => plot.bottom - ((v - min) / (max - min)) * plot.height

  // Baseline
  ctx.strokeStyle = theme.line2
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(plot.left, Math.round(scaleY(Math.max(0, min))) + 0.5)
  ctx.lineTo(plot.right, Math.round(scaleY(Math.max(0, min))) + 0.5)
  ctx.stroke()

  if (data.type === 'scatter') return drawScatter(ctx, data, theme, plot, scaleY, hover)
  if (data.type === 'line') return drawLine(ctx, data, theme, plot, scaleY, min, max, hover)
  return drawBars(ctx, data, theme, plot, scaleY, min, hover)
}

function drawBars(
  ctx: CanvasRenderingContext2D,
  data: ChartData,
  theme: Theme,
  plot: Plot,
  scaleY: (v: number) => number,
  min: number,
  hover: { x: number; y: number } | null,
): HitMap {
  const y = data.series[0].y
  const n = y.length
  const labels = data.xLabels ?? []
  const histogram = data.type === 'histogram'

  const slot = plot.width / Math.max(1, n)
  // A 2px gap of surface colour between adjacent bars keeps fills separable.
  const gap = histogram ? 2 : Math.min(10, Math.max(2, slot * 0.22))
  // With only two or three categories a full-width bar reads as a slab, so the
  // mark is capped and centred in its slot instead.
  const barW = Math.max(1, Math.min(slot - gap, histogram ? slot : 72))
  const barPad = (slot - barW) / 2
  const baseline = scaleY(Math.max(0, min))

  const hits: HitPoint[] = []

  for (let i = 0; i < n; i++) {
    const v = y[i]
    if (!Number.isFinite(v)) continue
    const x = plot.left + i * slot + barPad
    const top = scaleY(v)
    const h = top - baseline

    ctx.fillStyle = seriesColor(theme, 0, labels[i] === 'Other' ? 'Other' : data.series[0].name)
    if (labels[i] === 'Other') ctx.fillStyle = theme.ink3
    barPath(ctx, x, top, barW, h, histogram ? 4 : 8)
    ctx.fill()

    hits.push({
      seriesIndex: 0,
      pointIndex: i,
      label: labels[i] ?? formatAxisValue(data, data.x ? data.x[i] : i),
      value: v,
      x: x + barW / 2,
      y: top,
    })
  }

  // The relief rule: three light-mode slots sit below 3:1 on the light
  // surface, so bars carry a visible value whenever there is room for it.
  if (barW >= 26) {
    axisText(ctx, theme)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillStyle = theme.ink2
    for (const h of hits) {
      if (h.y > plot.top + 12) ctx.fillText(formatCompact(h.value), h.x, h.y - 4)
    }
  }

  drawCategoryAxis(ctx, theme, plot, data, n, slot)
  return makeHitMap(hits, 'nearest-x')
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  data: ChartData,
  theme: Theme,
  plot: Plot,
  scaleY: (v: number) => number,
  _min: number,
  _max: number,
  hover: { x: number; y: number } | null,
): HitMap {
  const xs = data.x
  const hits: HitPoint[] = []

  let xMin = 0
  let xMax = 1
  if (xs && xs.length) {
    xMin = xs[0]
    xMax = xs[xs.length - 1]
    if (xMax === xMin) xMax = xMin + 1
  }

  data.series.forEach((s, si) => {
    const n = s.y.length
    if (!n) return
    const scaleX = (i: number) =>
      xs && xs.length === n
        ? plot.left + ((xs[i] - xMin) / (xMax - xMin)) * plot.width
        : plot.left + (n === 1 ? plot.width / 2 : (i / (n - 1)) * plot.width)

    ctx.strokeStyle = seriesColor(theme, si, s.name)
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    let started = false
    for (let i = 0; i < n; i++) {
      const v = s.y[i]
      if (!Number.isFinite(v)) continue
      const px = scaleX(i)
      const py = scaleY(v)
      if (started) ctx.lineTo(px, py)
      else {
        ctx.moveTo(px, py)
        started = true
      }
      hits.push({ seriesIndex: si, pointIndex: i, label: formatAxisValue(data, xs ? xs[i] : i), value: v, x: px, y: py })
    }
    ctx.stroke()
  })

  if (hover) drawCrosshair(ctx, theme, plot, hover)
  drawQuantitativeAxis(ctx, theme, plot, data, xMin, xMax)
  return makeHitMap(hits, 'nearest-x')
}

function drawScatter(
  ctx: CanvasRenderingContext2D,
  data: ChartData,
  theme: Theme,
  plot: Plot,
  scaleY: (v: number) => number,
  _hover: { x: number; y: number } | null,
): HitMap {
  const xs = data.x
  if (!xs || !xs.length) return NO_HITS

  let xMin = Infinity
  let xMax = -Infinity
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < xMin) xMin = xs[i]
    if (xs[i] > xMax) xMax = xs[i]
  }
  if (!Number.isFinite(xMin)) return NO_HITS
  if (xMax === xMin) xMax = xMin + 1

  const s = data.series[0]
  const n = Math.min(xs.length, s.y.length)
  const dense = n > 3000
  const radius = dense ? 2.5 : 4

  ctx.globalAlpha = dense ? 0.45 : 0.75
  ctx.fillStyle = theme.series[0]
  ctx.strokeStyle = theme.surface
  ctx.lineWidth = 2

  const hits: HitPoint[] = []
  for (let i = 0; i < n; i++) {
    const px = plot.left + ((xs[i] - xMin) / (xMax - xMin)) * plot.width
    const py = scaleY(s.y[i])
    ctx.beginPath()
    ctx.arc(px, py, radius, 0, Math.PI * 2)
    ctx.fill()
    if (!dense) ctx.stroke()
    // Only a sampled subset needs hit testing; 20k entries would be wasteful.
    if (i % Math.max(1, Math.floor(n / 2000)) === 0) {
      hits.push({ seriesIndex: 0, pointIndex: i, label: formatAxisValue(data, xs[i]), value: s.y[i], x: px, y: py })
    }
  }
  ctx.globalAlpha = 1

  drawQuantitativeAxis(ctx, theme, plot, data, xMin, xMax)
  return makeHitMap(hits, 'nearest-xy')
}

function drawDonut(
  ctx: CanvasRenderingContext2D,
  data: ChartData,
  theme: Theme,
  layout: { width: number; height: number },
  _hover: { x: number; y: number } | null,
): HitMap {
  const { width, height } = layout
  const y = data.series[0].y
  const labels = data.xLabels ?? []
  let total = 0
  for (let i = 0; i < y.length; i++) if (Number.isFinite(y[i])) total += y[i]
  if (total <= 0) return NO_HITS

  const cx = width / 2
  const cy = height / 2
  const outer = Math.max(10, Math.min(width, height) / 2 - 12)
  const inner = outer * 0.58

  // Descending, clockwise from 12 o'clock.
  let angle = -Math.PI / 2
  const hits: HitPoint[] = []
  const gapAngle = Math.min(0.03, (Math.PI * 2) / Math.max(8, y.length * 4))

  for (let i = 0; i < y.length; i++) {
    const v = y[i]
    if (!Number.isFinite(v) || v <= 0) continue
    const sweep = (v / total) * Math.PI * 2
    const a0 = angle + gapAngle / 2
    const a1 = angle + sweep - gapAngle / 2

    if (a1 > a0) {
      ctx.fillStyle = labels[i] === 'Other' ? theme.ink3 : seriesColor(theme, i, labels[i] ?? '')
      ctx.beginPath()
      ctx.arc(cx, cy, outer, a0, a1)
      ctx.arc(cx, cy, inner, a1, a0, true)
      ctx.closePath()
      ctx.fill()
    }

    const mid = angle + sweep / 2
    hits.push({
      seriesIndex: 0,
      pointIndex: i,
      label: labels[i] ?? String(i),
      value: v,
      x: cx + Math.cos(mid) * ((outer + inner) / 2),
      y: cy + Math.sin(mid) * ((outer + inner) / 2),
    })
    angle += sweep
  }

  axisText(ctx, theme)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = theme.ink1
  ctx.font = '600 15px system-ui, -apple-system, "Segoe UI", sans-serif'
  ctx.fillText(formatCompact(total), cx, cy - 6)
  axisText(ctx, theme)
  ctx.textAlign = 'center'
  ctx.fillText('total', cx, cy + 10)

  return makeHitMap(hits, 'nearest-xy')
}

/* ------------------------------------------------------------------- axes */

function formatAxisValue(data: ChartData, v: number): string {
  if (data.xIsDate) return formatDate(v, 'auto')
  return formatNumber(v, { maxFrac: 3 })
}

function drawCategoryAxis(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  plot: Plot,
  data: ChartData,
  n: number,
  slot: number,
) {
  axisText(ctx, theme)
  ctx.textBaseline = 'top'
  ctx.textAlign = 'center'

  const labels = data.xLabels
  if (!labels) {
    // Histogram: label the bin edges instead of every bar.
    if (!data.x || !data.x.length) return
    const steps = Math.max(2, Math.min(6, Math.floor(plot.width / 80)))
    for (let s = 0; s <= steps; s++) {
      const i = Math.round((s / steps) * (n - 1))
      const x = plot.left + i * slot + slot / 2
      ctx.fillText(formatAxisValue(data, data.x[i]), x, plot.bottom + 8)
    }
    return
  }

  // Skip labels rather than let them collide.
  let stride = 1
  ctx.save()
  while (stride < n) {
    let widest = 0
    for (let i = 0; i < n; i += stride) widest = Math.max(widest, ctx.measureText(labels[i] ?? '').width)
    if (widest + 10 <= slot * stride) break
    stride++
  }

  for (let i = 0; i < n; i += stride) {
    const label = labels[i] ?? ''
    const x = plot.left + i * slot + slot / 2
    const maxWidth = slot * stride - 6
    let text = label
    if (ctx.measureText(text).width > maxWidth) {
      while (text.length > 1 && ctx.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1)
      text = `${text}…`
    }
    ctx.fillStyle = label === 'Other' ? theme.ink3 : theme.ink3
    ctx.fillText(text, x, plot.bottom + 8)
  }
  ctx.restore()
}

function drawQuantitativeAxis(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  plot: Plot,
  data: ChartData,
  xMin: number,
  xMax: number,
) {
  axisText(ctx, theme)
  ctx.textBaseline = 'top'
  ctx.textAlign = 'center'
  const ticks = niceTicks(xMin, xMax, Math.max(2, Math.floor(plot.width / 90)))
  for (const t of ticks) {
    const x = plot.left + ((t - xMin) / (xMax - xMin || 1)) * plot.width
    ctx.fillText(formatAxisValue(data, t), x, plot.bottom + 8)
  }
}

function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  plot: Plot,
  hover: { x: number; y: number },
) {
  if (hover.x < plot.left || hover.x > plot.right) return
  ctx.strokeStyle = theme.line2
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(Math.round(hover.x) + 0.5, plot.top)
  ctx.lineTo(Math.round(hover.x) + 0.5, plot.bottom)
  ctx.stroke()
  ctx.setLineDash([])
}

function makeHitMap(hits: HitPoint[], mode: 'nearest-x' | 'nearest-xy'): HitMap {
  if (!hits.length) return NO_HITS
  return {
    hit(x, y) {
      let best: HitPoint | null = null
      let bestDist = Infinity
      for (const h of hits) {
        const dx = h.x - x
        const dy = h.y - y
        const dist = mode === 'nearest-x' ? Math.abs(dx) : Math.sqrt(dx * dx + dy * dy)
        if (dist < bestDist) {
          bestDist = dist
          best = h
        }
      }
      // A hit target larger than the mark itself.
      return bestDist <= (mode === 'nearest-x' ? 40 : 18) ? best : null
    },
  }
}
