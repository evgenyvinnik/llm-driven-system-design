import { clock } from '@/lib/format'
import type { Transition } from '@/types'

export function Timeline({ transitions }: { transitions: Transition[] }) {
  return (
    <ol className="space-y-1.5 p-4 text-xs" aria-label="Timeline">
      {transitions.map((t) => (
        <li key={t.id} className="flex gap-3">
          <span className="num w-20 shrink-0 text-slate-500">{clock(t.at)}</span>
          <span>
            <span className="font-medium text-slate-800">{t.from ? `${t.from} → ${t.to}` : t.to}</span>
            {t.actor && <span className="text-slate-500"> ({t.actor})</span>}
            {t.reason && <span className="block text-slate-500">{t.reason}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}
