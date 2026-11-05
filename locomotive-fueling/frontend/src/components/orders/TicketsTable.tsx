import { Chip } from '@/components/shared/Chips'
import { gal, money, simTime } from '@/lib/format'
import type { TicketRow } from '@/types'

const TONE = { matched: 'good', discrepancy: 'bad', unmatched: 'info', unverified: 'warn' } as const

/** Fuel tickets reconciled against the level rise telemetry saw. */
export function TicketsTable({ tickets, totals }: { tickets: TicketRow[]; totals: { gallons: number; cost: number } }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="panel-title">Fuel tickets and reconciliation</div>
        <div className="num text-xs text-slate-500">
          {gal(totals.gallons)} delivered · {money(totals.cost)} billed
        </div>
      </div>
      <table className="w-full" aria-label="Fuel tickets">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Ticket</th>
            <th className="th">Train / place</th>
            <th className="th text-right">Billed</th>
            <th className="th text-right">Telemetry saw</th>
            <th className="th">Status</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((t) => (
            <tr key={t.id} className="border-t border-slate-100">
              <td className="td">
                <div className="font-mono text-xs text-slate-700">{t.id}</div>
                <div className="text-[11px] text-slate-500">{t.source === 'vendor' ? 'DTL vendor' : 'Fuel pad'} · {simTime(t.deliveredAt)}</div>
              </td>
              <td className="td text-sm">
                {t.symbol} · {t.locationName}
              </td>
              <td className="td num text-right">
                {gal(t.gallonsTotal)}
                <div className="text-[11px] text-slate-500">{money(t.gallonsTotal * t.pricePerGal + t.fee)}</div>
              </td>
              <td className="td num text-right">{gal(t.telemetryGallons)}</td>
              <td className="td">
                <Chip kind={TONE[t.status as keyof typeof TONE] ?? 'muted'}>{t.status === 'unmatched' ? 'Awaiting telemetry' : t.status}</Chip>
                {t.discrepancyGal !== null && t.status === 'discrepancy' && <div className="num mt-0.5 text-[11px] text-red-700">{Math.round(t.discrepancyGal)} gal short</div>}
              </td>
            </tr>
          ))}
          {tickets.length === 0 && (
            <tr>
              <td colSpan={5} className="td text-slate-500">
                No tickets yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
