import { CheckIcon, WrenchIcon, XIcon } from '@/components/icons'
import { EvidenceBadge, SeverityBadge } from '@/components/shared'
import { relativeTime, valueText } from '@/lib/format'
import type { AccountDetail } from '@/types'

interface Props {
  controls: AccountDetail['controls']
  canAct: boolean
  busy: string | null
  onFix: (controlId: string) => void
  onRequestException: (controlId: string) => void
}

export function ConfigTable({ controls, canAct, busy, onFix, onRequestException }: Props) {
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-800">Configuration vs controls</div>
      <table className="w-full" aria-label="Controls">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Control</th>
            <th className="th">Current</th>
            <th className="th">Desired</th>
            <th className="th">Finding</th>
            <th className="th">Evidence</th>
            {canAct && <th className="th text-right">Action</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {controls.map((c) => {
            const f = c.finding
            const open = f?.status === 'open'
            return (
              <tr key={c.controlId}>
                <td className="td">
                  <span className="font-mono text-xs text-slate-500">{c.controlId}</span> {c.title}
                  <div className="font-mono text-[11px] text-slate-400">{c.property}</div>
                </td>
                <td className="td">
                  <span className={`inline-flex items-center gap-1 font-mono text-xs ${c.compliant === false ? 'text-red-700' : 'text-slate-700'}`}>
                    {c.compliant === true && <CheckIcon className="h-3.5 w-3.5 text-status-good" />}
                    {c.compliant === false && <XIcon className="h-3.5 w-3.5 text-status-critical" />}
                    {valueText(c.current)}
                  </span>
                </td>
                <td className="td font-mono text-xs text-slate-500">{c.desired}</td>
                <td className="td">
                  {f && f.status !== 'resolved' ? (
                    <div className="space-y-0.5">
                      <SeverityBadge severity={f.severity} />
                      <div className="text-xs text-slate-500">{f.status === 'exempt' ? 'exempt' : `risk ${f.riskScore} · due ${relativeTime(f.dueAt)}`}</div>
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400">{f?.status === 'resolved' ? 'resolved' : '—'}</span>
                  )}
                </td>
                <td className="td max-w-[16rem]">
                  {f && f.status !== 'resolved' && c.breaking ? (
                    <>
                      <EvidenceBadge value={f.evidenceClass} />
                      <div className="mt-0.5 text-xs text-slate-500">{f.evidenceReason}</div>
                    </>
                  ) : f && f.status !== 'resolved' ? (
                    <span className="text-xs text-slate-500">additive change</span>
                  ) : null}
                </td>
                {canAct && (
                  <td className="td text-right">
                    {open && (
                      <div className="flex justify-end gap-1.5">
                        <button type="button" className="btn-primary px-2 py-1 text-xs" disabled={busy !== null} onClick={() => onFix(c.controlId)} title="Runs through the executor: re-read, If-Match write, bake, automatic rollback">
                          <WrenchIcon className="h-3.5 w-3.5" /> {busy === c.controlId ? 'Starting…' : 'Fix now'}
                        </button>
                        <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => onRequestException(c.controlId)}>Request exception</button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
