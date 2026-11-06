import type { GroupSummary } from '@/types'

const ROLE: Record<string, string> = {
  completer: 'QuoteRequested → firm quote (retries, DLQ)',
  webhooks: 'FirmQuoteCompleted → signed callback',
  projector: 'every event → analytics projection',
  invalidator: 'TariffPublished / FuelSurchargeChanged → cache + re-price',
}

export function GroupTable({ groups, lengths }: { groups: GroupSummary[]; lengths: Record<string, number> }) {
  return (
    <section className="card overflow-hidden" aria-label="Consumer groups">
      <div className="border-b border-slate-100 px-4 py-2.5 panel-title">Consumer groups (Valkey Streams)</div>
      <table className="w-full" aria-label="Consumer lag">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Group</th>
            <th className="th">Does</th>
            <th className="th">Streams (lag each)</th>
            <th className="th text-right">Consumers</th>
            <th className="th text-right">Lag</th>
            <th className="th text-right">Pending</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {groups.map((g) => (
            <tr key={g.group}>
              <td className="td font-mono text-xs font-semibold">{g.group}</td>
              <td className="td text-xs text-slate-500">{ROLE[g.group]}</td>
              <td className="td font-mono text-[11px] text-slate-500">
                <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {g.streams.map((s) => (
                    <span key={s.stream} title={`${lengths[s.stream] ?? 0} entries in ${s.stream}`}>
                      {s.stream.replace('fq:events:', '').replace('fq:redrive:', 'redrive:').replace('fq:ext:', 'ext:')}
                      <span className={s.lag ? 'text-amber-700' : 'text-slate-400'}> {s.lag ?? '?'}</span>
                    </span>
                  ))}
                </div>
              </td>
              <td className="td text-right tabular-nums">{g.consumers}</td>
              <td className={`td text-right tabular-nums ${g.lag > 0 ? 'font-semibold text-amber-700' : ''}`}>{g.lag}</td>
              <td className={`td text-right tabular-nums ${g.pending > 0 ? 'font-semibold text-amber-700' : ''}`}>{g.pending}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
