import type { ReactNode } from 'react'

export function StatTile({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: string; icon?: ReactNode }) {
  return (
    <div className="card flex items-start gap-3 px-4 py-3">
      {icon && <div className="mt-0.5 text-slate-400">{icon}</div>}
      <div>
        <div className="panel-title">{label}</div>
        <div className="num mt-0.5 text-xl font-semibold text-slate-900">{value}</div>
        {hint && <div className="text-xs text-slate-500">{hint}</div>}
      </div>
    </div>
  )
}
