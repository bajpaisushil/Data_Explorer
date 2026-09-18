'use client'
import clsx from 'clsx'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { IconButton } from '@/components/ui/Button'

export function SidePanel({
  title,
  subtitle,
  onClose,
  children,
  actions,
  className,
}: {
  title: string
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <aside
      className={clsx(
        'df-card-raised df-in flex min-h-0 w-full flex-col overflow-hidden lg:w-[22rem] xl:w-[24rem]',
        className,
      )}
      aria-label={title}
    >
      <div className="flex items-start gap-2 px-4 pt-3.5 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-ink-1">{title}</h2>
          {subtitle && <p className="mt-0.5 text-2xs text-ink-3">{subtitle}</p>}
        </div>
        {actions}
        <IconButton label="Close panel" size="xs" icon={<X size={14} />} onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">{children}</div>
    </aside>
  )
}
