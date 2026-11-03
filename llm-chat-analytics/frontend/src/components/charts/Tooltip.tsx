import type { ReactNode } from 'react'

/** Floating tooltip positioned inside the chart container, clamped to its edges. */
export function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const w = 220
  const left = Math.min(Math.max(x - w / 2, 0), Math.max(width - w, 0))
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 rounded-md border bg-surface px-3 py-2 text-xs shadow-lg"
      style={{ left, top: Math.max(y - 8, 0), width: w, transform: 'translateY(-100%)', borderColor: 'var(--border)' }}
    >
      {children}
    </div>
  )
}

export function TooltipRow({ swatch, label, value }: { swatch?: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="flex items-center gap-1.5 text-ink-2">
        {swatch}
        {label}
      </span>
      <span className="tabular font-medium text-ink">{value}</span>
    </div>
  )
}

export const Swatch = ({ color, line = false }: { color: string; line?: boolean }) =>
  line ? (
    <span className="inline-block h-0.5 w-3 rounded" style={{ background: color }} />
  ) : (
    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
  )
