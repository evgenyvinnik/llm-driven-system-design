import { createFileRoute } from '@tanstack/react-router'
import { Chip } from '@/components/shared/Chips'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { reasonLabel } from '@/lib/format'
import { usePolling } from '@/lib/usePolling'
import { api } from '@/services/api'
import type { ReplayPolicyRow } from '@/types'

export const Route = createFileRoute('/metrics')({ component: MetricsPage })

const POLICY_LABEL: Record<ReplayPolicyRow['policy'], string> = {
  planner: 'Planner only',
  planner_overrides: 'Planner plus scripted yardmaster',
  baseline: 'Baseline rule of thumb',
}

function reasons(map: Record<string, number>): string {
  const entries = Object.entries(map)
  return entries.length ? entries.map(([k, n]) => `${reasonLabel(k)} ${n}`).join(', ') : 'none'
}

function MetricsPage() {
  const { data, error } = usePolling(api.shiftMetrics, 4000)
  const replay = usePolling(api.replay, 4000)
  if (error && !data) return <main className="page"><ErrorNote message={error} /></main>
  if (!data) return <Loading />
  const run = replay.data?.run
  return (
    <main className="page">
      <h1 className="text-lg font-semibold text-slate-900">Does the planner beat the yardmaster?</h1>
      <h2 className="text-base font-semibold text-slate-900">Per shift, from raw reports</h2>
      <div className="card overflow-x-auto">
        <table className="w-full" aria-label="Shift metrics">
          <thead>
            <tr>
              <th className="th">Shift</th>
              <th className="th text-right">On time</th>
              <th className="th text-right">Missed</th>
              <th className="th text-right">Moves per car</th>
              <th className="th text-right">Dwell</th>
              <th className="th text-right">Over capacity</th>
              <th className="th text-right">Overrides</th>
              <th className="th">Override reasons</th>
              <th className="th text-right">Plan versions</th>
            </tr>
          </thead>
          <tbody>
            {data.shifts.map((s) => (
              <tr key={s.shiftId} className="border-t border-slate-100">
                <td className="td">{s.shiftId} <Chip kind={s.status === 'open' ? 'info' : 'muted'}>{s.status}</Chip></td>
                <td className="td num text-right">{s.onTimePct === null ? '–' : `${s.onTimePct}%`} <span className="text-xs text-slate-400">({s.departedOnTime}/{s.trainsDue})</span></td>
                <td className="td num text-right">{s.missed}</td>
                <td className="td num text-right">{s.movesPerCar ?? '–'}</td>
                <td className="td num text-right">{s.avgDwellHours === null ? '–' : `${s.avgDwellHours} h`}</td>
                <td className="td num text-right">{s.capacityViolations}</td>
                <td className="td num text-right">{s.overrides}{s.overrideRatePer100Moves !== null ? <span className="text-xs text-slate-400"> ({s.overrideRatePer100Moves}/100 moves)</span> : null}</td>
                <td className="td text-xs">{reasons(s.overrideReasons)}</td>
                <td className="td num text-right">{s.planVersions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3">
        <h2 className="text-base font-semibold text-slate-900">The same seeded shifts under three policies</h2>
        <div className="flex-1" />
        <button type="button" className="btn-secondary" disabled={Boolean(replay.data?.active)} onClick={() => void api.runReplay().then(replay.refresh)}>
          {replay.data?.active ? 'Running…' : 'Run replay'}
        </button>
      </div>
      {!run && <p className="card p-4 text-sm text-slate-500">No replay yet. Run one.</p>}
      {run && (
        <div className="card overflow-x-auto">
          <table className="w-full" aria-label="Replay by policy">
            <thead>
              <tr>
                <th className="th">Policy</th>
                <th className="th text-right">On time</th>
                <th className="th text-right">Missed</th>
                <th className="th text-right">Cars out</th>
                <th className="th text-right">Stranded</th>
                <th className="th text-right">Moves per car</th>
                <th className="th text-right">Dwell</th>
                <th className="th text-right">Over capacity</th>
                <th className="th text-right">Moves disturbed</th>
                <th className="th">Overrides</th>
              </tr>
            </thead>
            <tbody>
              {run.summary.policies.map((p) => (
                <tr key={p.policy} className="border-t border-slate-100">
                  <td className="td font-medium">{POLICY_LABEL[p.policy]}</td>
                  <td className="td num text-right">{p.onTimePct}%</td>
                  <td className="td num text-right">{p.missed}</td>
                  <td className="td num text-right">{p.carsDeparted}</td>
                  <td className="td num text-right">{p.carsStranded}</td>
                  <td className="td num text-right">{p.movesPerCar}</td>
                  <td className="td num text-right">{p.avgDwellHours} h</td>
                  <td className="td num text-right">{p.capacityViolations}</td>
                  <td className="td num text-right">{p.disturbedMoves}</td>
                  <td className="td text-xs">{p.overrides}: {reasons(p.overrideReasons)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">Seeds {run.params.seeds.join(', ')}, {run.summary.policies[0]?.shifts} shifts each, {run.params.iterations} search iterations per solve. Every plan in every run was checked by the independent validator.</p>
        </div>
      )}
      <section className="card space-y-1 p-3 text-sm text-slate-700" aria-label="Limits of this comparison">
        <h2 className="panel-title">How far to trust this</h2>
        <p><strong>The yardmaster here is a script.</strong> It protects tight trains, follows a habit, and hears about one late train early on the radio. That models a guess about human behaviour. It doesn&apos;t measure anyone.</p>
        <p><strong>Selection effects.</strong> In a real yard, people override when a plan already looks wrong, so overridden shifts are harder shifts. Comparing them with shifts nobody touched flatters the planner.</p>
        <p><strong>A simulator only rewards what it models.</strong> Crew judgement, weather, power shortages and customer calls aren&apos;t here. A real test would run the planner in shadow on real shifts, then randomize which shifts see its plan.</p>
        <p><strong>Few seeds.</strong> Differences of one train across a handful of shifts are noise until many more seeds agree.</p>
      </section>
    </main>
  )
}
