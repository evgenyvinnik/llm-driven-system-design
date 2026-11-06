import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { SagaStateBadge } from '@/components/shared/Badges'
import { Empty, ErrorNote, Loading, PageHeader, StatTile } from '@/components/shared/Loading'
import { fmtHours, fmtShort, hoursBetween, label } from '@/lib/format'
import { usePoll } from '@/lib/hooks'
import { api } from '@/services/api'

export const Route = createFileRoute('/replans')({ component: Replans })

const STATES = ['', 'started', 'reserved', 'awaiting_eta', 'completed', 'compensated', 'failed', 'superseded']

export function Replans() {
  const [state, setState] = useState('')
  const { data, error } = usePoll(() => api.replans(state || undefined), [state])
  const c = data?.counts ?? {}
  return (
    <div className="page">
      <PageHeader
        title="Replanning sagas"
        subtitle="The process manager: missed connection or cancelled train → reserve a seat on the next train with capacity → revise the plan (new version, optimistic concurrency) → wait for the ETA service → notify. If the chosen train is cancelled, the seat is released (compensation) and a child saga tries again."
      />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatTile label="In progress" value={(c.started ?? 0) + (c.reserved ?? 0) + (c.awaiting_eta ?? 0)} />
        <StatTile label="Completed" value={c.completed ?? 0} tone="good" />
        <StatTile label="Compensated" value={c.compensated ?? 0} tone={c.compensated ? 'warn' : 'default'} hint="chosen train cancelled or plan moved" />
        <StatTile label="Failed" value={c.failed ?? 0} tone={c.failed ? 'bad' : 'default'} hint="no capacity in horizon" />
        <StatTile label="Superseded" value={c.superseded ?? 0} hint="already replanned by someone else" />
      </div>
      <div className="mb-3 flex flex-wrap gap-1">
        {STATES.map((s) => (
          <button key={s} type="button" className={state === s ? 'tab-active' : 'tab'} onClick={() => setState(s)}>{s ? label(s) : 'all'}</button>
        ))}
      </div>
      {error && <ErrorNote message={error} />}
      <div className="card overflow-hidden">
        {!data ? (
          <Loading />
        ) : data.sagas.length === 0 ? (
          <Empty>No sagas.</Empty>
        ) : (
          <table className="w-full" aria-label="Replanning sagas">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Saga</th>
                <th className="th">Car</th>
                <th className="th">Trigger</th>
                <th className="th">Missed → chosen</th>
                <th className="th">Plan</th>
                <th className="th">Steps</th>
                <th className="th">ETA shift</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.sagas.map((s) => (
                <tr key={s.saga_id} className="hover:bg-slate-50">
                  <td className="td">
                    <div className="font-mono text-xs font-semibold">{s.saga_id}</div>
                    <SagaStateBadge state={s.state} />
                    {s.parent_saga_id && <div className="text-[11px] text-slate-500">attempt {s.attempt} after {s.parent_saga_id}</div>}
                  </td>
                  <td className="td">
                    <Link to="/cars/$carId" params={{ carId: s.car_id }} search={{ tab: 'plan' }} className="font-mono text-sm text-accent-700 hover:underline">{s.car_id}</Link>
                    <div className="text-xs text-slate-500">{s.shipper_name}</div>
                  </td>
                  <td className="td text-xs">{label(s.trigger_type)} at {s.yard_id}</td>
                  <td className="td whitespace-nowrap font-mono text-xs">
                    <div className="text-slate-500 line-through decoration-slate-400">{s.missed_run_id}</div>
                    <div className="text-slate-900">{s.chosen_run_id ?? '…'}</div>
                  </td>
                  <td className="td whitespace-nowrap text-xs">v{s.from_plan_version} → {s.to_plan_version ? `v${s.to_plan_version}` : '…'}</td>
                  <td className="td">
                    <div className="flex max-w-xs flex-wrap gap-1">
                      {s.steps.map((st, i) => (
                        <span key={i} className="chip bg-slate-100 text-slate-600" title={`${fmtShort(st.simAt)} ${JSON.stringify(st)}`}>{label(st.to)}</span>
                      ))}
                    </div>
                    {s.error && <div className="text-xs text-red-600">{s.error}</div>}
                  </td>
                  <td className="td text-sm">{s.eta_after && s.eta_before ? fmtHours(hoursBetween(s.eta_after.p50, s.eta_before.p50)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
