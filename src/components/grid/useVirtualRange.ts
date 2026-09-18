'use client'
import { useMemo } from 'react'

export interface VirtualRange {
  start: number
  end: number
  offsetBefore: number
  totalSize: number
}

/** Fixed-size virtualization: the row case. */
export function useVirtualRange(opts: {
  count: number
  itemSize: number
  viewport: number
  scroll: number
  overscan: number
}): VirtualRange {
  const { count, itemSize, viewport, scroll, overscan } = opts
  return useMemo(() => {
    const totalSize = count * itemSize
    if (count <= 0 || itemSize <= 0) return { start: 0, end: 0, offsetBefore: 0, totalSize: 0 }

    const first = Math.max(0, Math.floor(scroll / itemSize) - overscan)
    const visible = Math.ceil(viewport / itemSize) + overscan * 2
    const last = Math.min(count, first + visible + 1)

    return { start: first, end: last, offsetBefore: first * itemSize, totalSize }
  }, [count, itemSize, viewport, scroll, overscan])
}

/** Variable-size virtualization: the column case, where widths differ. */
export function useVariableVirtualRange(opts: {
  sizes: number[]
  viewport: number
  scroll: number
  overscan: number
}): VirtualRange & { starts: number[] } {
  const { sizes, viewport, scroll, overscan } = opts
  return useMemo(() => {
    const n = sizes.length
    const starts = new Array<number>(n + 1)
    starts[0] = 0
    for (let i = 0; i < n; i++) starts[i + 1] = starts[i] + sizes[i]
    const totalSize = starts[n] ?? 0

    if (n === 0) return { start: 0, end: 0, offsetBefore: 0, totalSize: 0, starts }

    // Binary search for the first column whose right edge is past the scroll.
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (starts[mid + 1] <= scroll) lo = mid + 1
      else hi = mid
    }
    const first = Math.max(0, lo - overscan)

    let last = first
    const limit = scroll + viewport
    while (last < n && starts[last] < limit) last++
    last = Math.min(n, last + overscan)

    return { start: first, end: last, offsetBefore: starts[first], totalSize, starts }
  }, [sizes, viewport, scroll, overscan])
}
