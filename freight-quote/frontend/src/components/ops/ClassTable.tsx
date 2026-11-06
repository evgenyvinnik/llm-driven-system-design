import { CLASS_LABEL, ms } from '@/lib/format'
import type { ClassOverview, ClientClass, Settings } from '@/types'

const CLASSES: ClientClass[] = ['portal', 'api', 'api_requote']

/** Outcomes by client class: shedding refuses re-quoting integrations first and people last. */
export function ClassTable({ quotes, settings }: { quotes: Record<ClientClass, ClassOverview>; settings: Settings }) {
  return (
    <section className="card overflow-hidden" aria-label="Traffic by client class">
      <div className="border-b border-slate-100 px-4 py-2.5 panel-title">Traffic by client class</div>
      <table className="w-full" aria-label="Client classes">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Class</th>
            <th className="th text-right">Admitted while</th>
            <th className="th text-right">Firm</th>
            <th className="th text-right">Indicative</th>
            <th className="th text-right">Unavailable</th>
            <th className="th text-right">Replayed</th>
            <th className="th text-right">Shed</th>
            <th className="th text-right">429</th>
            <th className="th text-right">p50</th>
            <th className="th text-right">p99</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {CLASSES.map((c) => {
            const q = quotes[c]
            return (
              <tr key={c}>
                <td className="td font-medium">{CLASS_LABEL[c]}</td>
                <td className="td whitespace-nowrap text-right tabular-nums text-slate-500">
                  {settings.shedding.enabled ? `< ${Math.floor(settings.shedding.maxInflight * settings.shedding.thresholds[c])} in flight` : 'always'}
                </td>
                <td className="td text-right tabular-nums">{q.firm}</td>
                <td className="td text-right tabular-nums">{q.indicative}</td>
                <td className="td text-right tabular-nums">{q.unavailable}</td>
                <td className="td text-right tabular-nums">{q.replayed}</td>
                <td className={`td text-right tabular-nums ${q.shed ? 'font-semibold text-amber-700' : ''}`}>{q.shed}</td>
                <td className={`td text-right tabular-nums ${q.rate_limited ? 'font-semibold text-amber-700' : ''}`}>{q.rate_limited}</td>
                <td className="td whitespace-nowrap text-right tabular-nums">{ms(q.p50)}</td>
                <td className="td whitespace-nowrap text-right tabular-nums">{ms(q.p99)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
