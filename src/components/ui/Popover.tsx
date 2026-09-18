'use client'
import clsx from 'clsx'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export interface PopoverProps {
  trigger: (props: { open: boolean; toggle: () => void; id: string }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'start' | 'end'
  className?: string
  panelClassName?: string
}

/**
 * Anchored menu with click-outside and Escape handling. Positioned with
 * `fixed` off the trigger's rect so it escapes the grid's overflow clipping.
 */
export function Popover({ trigger, children, align = 'start', className, panelClassName }: PopoverProps) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    const measure = () => setRect(anchorRef.current?.getBoundingClientRect() ?? null)
    measure()

    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (anchorRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open])

  const close = () => setOpen(false)

  // Keep the panel on screen: flip above when it would overflow the viewport.
  const panelStyle = rect
    ? (() => {
        const below = window.innerHeight - rect.bottom
        const flip = below < 280 && rect.top > below
        return {
          left: align === 'end' ? undefined : Math.max(8, Math.min(rect.left, window.innerWidth - 300)),
          right: align === 'end' ? Math.max(8, window.innerWidth - rect.right) : undefined,
          top: flip ? undefined : rect.bottom + 4,
          bottom: flip ? window.innerHeight - rect.top + 4 : undefined,
          maxHeight: flip ? rect.top - 16 : below - 16,
        }
      })()
    : undefined

  return (
    <div ref={anchorRef} className={clsx('relative', className)}>
      {trigger({ open, toggle: () => setOpen((v) => !v), id })}
      {open && (
        <div
          ref={panelRef}
          id={id}
          role="menu"
          style={panelStyle}
          className={clsx(
            'df-pop df-card-raised fixed z-50 min-w-52 overflow-y-auto p-1.5',
            'shadow-[var(--e3)]',
            panelClassName,
          )}
        >
          {children(close)}
        </div>
      )}
    </div>
  )
}

export function MenuItem({
  icon,
  children,
  destructive,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode; destructive?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={clsx(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-2xs font-medium',
        'transition-colors duration-100 hover:bg-surface-2 active:bg-surface-3',
        'disabled:opacity-40 disabled:pointer-events-none',
        destructive ? 'text-critical hover:bg-critical/10' : 'text-ink-1',
        className,
      )}
      {...rest}
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  )
}

export function MenuSeparator() {
  return <div className="my-1.5 h-px bg-line-1" />
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-2 pb-1 text-2xs font-semibold text-ink-3 uppercase tracking-wider">{children}</div>
}
