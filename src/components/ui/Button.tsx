'use client'
import clsx from 'clsx'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'default' | 'soft' | 'ghost' | 'danger'
type Size = 'xs' | 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
  trailing?: ReactNode
  active?: boolean
  block?: boolean
}

const VARIANTS: Record<Variant, string> = {
  primary: 'text-accent-ink df-press df-press-accent',
  default: 'bg-surface-1 text-ink-1 hover:bg-surface-1 df-press',
  soft: 'bg-surface-2 text-ink-2 hover:text-ink-1 hover:bg-surface-3 df-press',
  ghost: 'bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink-1',
  danger: 'bg-transparent text-critical hover:bg-critical/10',
}

const SIZES: Record<Size, string> = {
  xs: 'h-7 px-2.5 gap-1.5 text-2xs rounded-lg',
  sm: 'h-8 px-3 gap-1.5 text-2xs rounded-lg',
  md: 'h-10 px-4 gap-2 text-[13px] rounded-xl',
  lg: 'h-12 px-6 gap-2.5 text-sm rounded-2xl',
}

export function Button({
  variant = 'default',
  size = 'sm',
  icon,
  trailing,
  active,
  block,
  className,
  children,
  style,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      style={variant === 'primary' ? { backgroundImage: 'var(--grad-accent)', ...style } : style}
      className={clsx(
        'inline-flex items-center justify-center font-medium whitespace-nowrap select-none',
        'transition-colors duration-100 disabled:opacity-40 disabled:pointer-events-none',
        SIZES[size],
        VARIANTS[variant],
        active && variant !== 'primary' && 'bg-accent-soft text-accent',
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
      {trailing}
    </button>
  )
}

export function IconButton({
  label,
  size = 'sm',
  className,
  ...rest
}: ButtonProps & { label: string }) {
  const square = size === 'xs' ? 'w-7' : size === 'sm' ? 'w-8' : size === 'md' ? 'w-10' : 'w-12'
  return (
    <Button
      aria-label={label}
      title={label}
      size={size}
      variant={rest.variant ?? 'ghost'}
      className={clsx(square, 'px-0', className)}
      {...rest}
    />
  )
}

/** A rounded status/label pill. `hue` is any CSS colour, usually a token var. */
export function Pill({
  hue,
  icon,
  children,
  className,
  title,
}: {
  hue?: string
  icon?: ReactNode
  children: ReactNode
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      style={hue ? ({ ['--tint-hue' as string]: hue }) : undefined}
      className={clsx(
        'df-tint inline-flex items-center gap-1 rounded-full px-2 py-0.5',
        'text-2xs font-semibold whitespace-nowrap',
        className,
      )}
    >
      {icon}
      {children}
    </span>
  )
}

/** Rounded, gradient-filled progress bar. `value` is 0-1, or -1 for indeterminate. */
export function ProgressBar({ value, className }: { value: number; className?: string }) {
  const indeterminate = value < 0
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(value * 100)}
      className={clsx('df-sunken h-2.5 w-full overflow-hidden rounded-full', className)}
    >
      <div
        className={clsx('h-full rounded-full transition-[width] duration-200', indeterminate && 'df-shimmer-bar')}
        style={{
          width: indeterminate ? '38%' : `${Math.max(2, Math.min(100, value * 100))}%`,
          backgroundImage: 'var(--grad-accent)',
          boxShadow: '0 1px 4px var(--accent-glow), var(--hl-accent)',
          animation: indeterminate ? 'df-indeterminate 1.3s ease-in-out infinite' : undefined,
        }}
      />
    </div>
  )
}

/** Pill toggle switch. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-6 w-10 shrink-0 rounded-full transition-colors duration-150',
        'disabled:opacity-40 disabled:pointer-events-none',
        checked ? 'bg-accent' : 'bg-surface-3',
      )}
      style={{
        backgroundImage: checked ? 'var(--grad-accent)' : undefined,
        boxShadow: checked ? '0 2px 8px -2px var(--accent-glow), var(--hl-accent)' : 'var(--e-press)',
      }}
    >
      <span
        className={clsx(
          'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all duration-150',
          checked ? 'left-[1.125rem]' : 'left-0.5',
        )}
        style={{ boxShadow: '0 1px 3px rgba(48,40,82,0.3)' }}
      />
    </button>
  )
}
