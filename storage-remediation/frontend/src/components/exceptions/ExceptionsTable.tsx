import { Link } from '@tanstack/react-router'
import { SeverityBadge } from '@/components/shared'
import { relativeTime, shortDate } from '@/lib/format'
import type { ExceptionRecord, User } from '@/types'

const STATUS: Record<string, string> = {
  pending: 'bg-accent-50 text-accent-800',
  approved: 'bg-green-50 text-green-800',
  rejected: 'bg-slate-100 text-slate-600',
  expired: 'bg-amber-50 text-amber-800',
  revoked: 'bg-slate-100 text-slate-600',
}

function Expiry({ e }: { e: ExceptionRecord }) {
  if (e.status === 'pending') return <span className="text-slate-500">{e.requestedDays} days once approved</span>
  if (!e.expiresAt) return <span className="text-slate-400">—</span>
  const left = Date.parse(e.expiresAt) - Date.now()
  if (e.status === 'expired' || left <= 0) return <span className="text-amber-800">expired {relativeTime(e.expiresAt)} · finding reopened</span>
  return <span className={left < 7 * 86_400_000 ? 'font-medium text-amber-800' : 'text-slate-600'}>expires {relativeTime(e.expiresAt)}</span>
}

interface Props {
  rows: ExceptionRecord[]
  user: User
  onDecide: (id: string, decision: 'approve' | 'reject') => void
  onRevoke: (id: string) => void
}

export function ExceptionsTable({ rows, user, onDecide, onRevoke }: Props) {
  if (rows.length === 0) return <div className="card p-8 text-center text-sm text-slate-500">No exceptions.</div>
  const canDecide = user.role === 'approver' || user.role === 'security'
  return (
    <div className="card overflow-x-auto">
      <table className="w-full" aria-label="Exceptions">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Account / control</th>
            <th className="th">Status</th>
            <th className="th">Justification</th>
            <th className="th">Requested</th>
            <th className="th">Decision</th>
            <th className="th">Expiry</th>
            <th className="th text-right">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((e) => (
            <tr key={e.id}>
              <td className="td">
                <Link to="/accounts/$name" params={{ name: e.accountName }} className="font-mono text-[13px] text-accent-700 hover:underline">{e.accountName}</Link>
                <div className="text-xs text-slate-500"><span className="font-mono">{e.controlId}</span> {e.controlTitle}</div>
                <div className="mt-0.5 flex gap-1">{e.severity && <SeverityBadge severity={e.severity} />}<span className="chip bg-slate-100 text-slate-600">{e.owner ?? 'no owner'}</span></div>
              </td>
              <td className="td"><span className={`chip ${STATUS[e.status]}`}>{e.status}</span></td>
              <td className="td max-w-sm text-xs text-slate-600">{e.justification}</td>
              <td className="td text-xs text-slate-600">{e.requestedByName}<div className="text-slate-400">{shortDate(e.createdAt)}</div></td>
              <td className="td text-xs text-slate-600">{e.decidedByName ?? '—'}{e.decisionNote && <div className="text-slate-500">“{e.decisionNote}”</div>}</td>
              <td className="td text-xs"><Expiry e={e} /></td>
              <td className="td text-right">
                <div className="flex justify-end gap-1.5">
                  {e.status === 'pending' && canDecide && e.requestedBy !== user.id && (
                    <>
                      <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={() => onDecide(e.id, 'approve')}>Approve</button>
                      <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => onDecide(e.id, 'reject')}>Reject</button>
                    </>
                  )}
                  {(e.status === 'pending' || e.status === 'approved') && (user.role === 'security' || e.requestedBy === user.id) && (
                    <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => onRevoke(e.id)}>Revoke</button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
