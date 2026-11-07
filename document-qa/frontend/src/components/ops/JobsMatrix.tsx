import type { OpsOverview } from '@/types'

const STAGES = ['extract', 'chunk', 'embed', 'index', 'retire', 'sync_acl', 'purge']
const STATUSES = ['pending', 'running', 'succeeded', 'poisoned', 'cancelled']

export function JobsMatrix({ jobs, runningByWorker }: { jobs: OpsOverview['jobs']; runningByWorker: OpsOverview['runningByWorker'] }) {
  const count = (stage: string, status: string) => jobs.find((j) => j.stage === stage && j.status === status)?.n ?? 0
  return (
    <section className="card" aria-label="Jobs">
      <div className="flex items-baseline justify-between border-b border-slate-100 px-4 py-2">
        <h2 className="panel-title">Jobs by stage and status</h2>
        <span className="text-xs text-slate-500">
          running now: {runningByWorker.length === 0 ? 'none' : runningByWorker.map((w) => `${w.worker} ${w.running}`).join(' · ')}
        </span>
      </div>
      <table className="w-full" aria-label="Jobs by stage">
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th className="th">Stage</th>
            {STATUSES.map((s) => (
              <th key={s} className="th text-right">
                {s}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {STAGES.map((stage) => (
            <tr key={stage}>
              <td className="td font-medium">{stage}</td>
              {STATUSES.map((status) => {
                const n = count(stage, status)
                const tone = n === 0 ? 'text-slate-300' : status === 'poisoned' ? 'font-semibold text-rose-800' : status === 'running' ? 'text-indigo-700' : ''
                return (
                  <td key={status} className={`td num text-right ${tone}`}>
                    {n}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
