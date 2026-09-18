'use client'
import clsx from 'clsx'
import type { InputHTMLAttributes, SelectHTMLAttributes } from 'react'

const BASE =
  'h-8 w-full rounded-lg bg-surface-2 px-3 text-2xs text-ink-1 placeholder:text-ink-3 ' +
  'shadow-[var(--e-press)] transition-shadow duration-120 outline-none ' +
  'focus:shadow-[var(--e-press),0_0_0_2px_var(--accent-glow)] disabled:opacity-40'

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={clsx(BASE, className)} {...rest} />
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx(BASE, 'cursor-pointer pr-7 appearance-none', className)} {...rest}>
      {children}
    </select>
  )
}

export function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={clsx('text-2xs font-semibold text-ink-3 uppercase tracking-wider', className)}>
      {children}
    </span>
  )
}
