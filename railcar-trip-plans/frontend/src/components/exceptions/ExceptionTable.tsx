import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { SeverityBadge } from '@/components/shared/Badges'
import { fmtTime, label, relative } from '@/lib/format'
import { api, ApiError } from '@/services/api'
import type { ExceptionRow } from '@/types'

function ResolveButton({ x, onDone }: { x: ExceptionRow; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  if (!open) return <button type="button" className="btn-secondary !px-2 !py-1 text-xs" onClick={() => setOpen(true)}>Resolve</button>
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={async (e) => {
        e.preventDefault()
        try {
          await api.resolveException(x.exception_id, x.version, note || 'Handled by operations')
          setOpen(false)
          onDone()
        } catch (err) {
          setError(err instanceof ApiError && err.status === 409 ? 'Changed meanwhile; refresh' : 'Failed')
        }
      }}
    >
      <input className="input !w-40 !py-1 text-xs" placeholder="note" value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
      <button className="btn-primary !px-2 !py-1 text-xs" type="submit">Save</button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </form>
  )
}

export function ExceptionTable({ rows, now, canAct, onChanged }: { rows: ExceptionRow[]; now: string; canAct: boolean; onChanged: () => void }) {
  return (
    <table className="w-full" aria-label="Exceptions">
      <thead className="border-b border-slate-200 bg-slate-50">
        <tr>
          <th className="th">Severity</th>
          <th className="th">Type</th>
          <th className="th">Car</th>
          <th className="th">What</th>
          <th className="th">Yard</th>
          <th className="th">Opened (event time)</th>
          <th className="th">Status</th>
          {canAct && <th className="th" />}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((x) => (
          <tr key={x.exception_id} className="hover:bg-slate-50">
            <td className="td"><SeverityBadge severity={x.severity} /></td>
            <td className="td whitespace-nowrap font-medium">{label(x.type)}</td>
            <td className="td">
              <Link to="/cars/$carId" params={{ carId: x.car_id }} search={{ tab: 'plan' }} className="font-mono text-sm text-accent-700 hover:underline">{x.car_id}</Link>
              <div className="text-xs text-slate-500">{x.shipper_name ?? '—'}</div>
            </td>
            <td className="td max-w-md text-sm">{x.summary}</td>
            <td className="td">{x.yard_id ?? '—'}</td>
            <td className="td whitespace-nowrap text-xs">
              {fmtTime(x.opened_at)}
              <div className="text-slate-400">{relative(x.opened_at, now)}</div>
            </td>
            <td className="td text-xs">
              {x.status === 'open' ? <span className="chip bg-red-50 text-red-700">open</span> : <span className="chip bg-slate-100 text-slate-600" title={x.resolution ?? ''}>resolved by {x.resolved_by}</span>}
              {x.resolution && <div className="mt-0.5 max-w-[220px] truncate text-slate-500" title={x.resolution}>{x.resolution}</div>}
            </td>
            {canAct && <td className="td">{x.status === 'open' && <ResolveButton x={x} onDone={onChanged} />}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
