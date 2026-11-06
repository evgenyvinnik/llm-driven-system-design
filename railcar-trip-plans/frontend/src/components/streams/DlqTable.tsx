import { useState } from 'react'
import { RedriveIcon } from '@/components/icons'
import { fmtClock } from '@/lib/format'
import { api } from '@/services/api'
import type { DlqEntry } from '@/types'

/** Dead letters with why they failed; admins redrive them onto the group's retry stream. */
export function DlqTable({ entries, canRedrive, onChanged }: { entries: DlqEntry[]; canRedrive: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  if (entries.length === 0) return <p className="px-4 py-6 text-center text-sm text-slate-500">No dead letters. Poison messages land here after their retries run out.</p>
  return (
    <table className="w-full" aria-label="Dead letters">
      <thead className="border-b border-slate-200 bg-slate-50">
        <tr>
          <th className="th">Group</th>
          <th className="th">Event</th>
          <th className="th">Key</th>
          <th className="th">Why it failed</th>
          <th className="th text-right">Deliveries</th>
          <th className="th">Dead-lettered</th>
          {canRedrive && <th className="th" />}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {entries.map((d) => (
          <tr key={`${d.group}-${d.id}`}>
            <td className="td whitespace-nowrap font-mono text-sm">{d.group}</td>
            <td className="td">
              <div className="text-sm font-medium">{d.type}</div>
              <div className="mono text-slate-400">{d.eventId.slice(0, 8)} · from {d.stream}</div>
            </td>
            <td className="td font-mono text-sm">{d.key}</td>
            <td className="td max-w-md text-sm text-red-700">{d.error}</td>
            <td className="td text-right font-mono">{d.deliveries}</td>
            <td className="td mono whitespace-nowrap">{fmtClock(d.deadAt)}</td>
            {canRedrive && (
              <td className="td">
                <button
                  type="button"
                  className="btn-secondary !px-2 !py-1 text-xs"
                  disabled={busy === d.id}
                  onClick={async () => {
                    setBusy(d.id)
                    await api.redrive(d.group, d.id).catch(() => undefined)
                    setBusy(null)
                    onChanged()
                  }}
                >
                  <RedriveIcon className="h-3.5 w-3.5" /> Redrive
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
