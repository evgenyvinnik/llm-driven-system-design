import { timeAgo } from '@/lib/format'
import type { AdminOverview } from '@/types'

export function ExecutorsPanel({ executors, topUsers }: Pick<AdminOverview, 'executors' | 'topUsers'>) {
  return (
    <div className="card">
      <div className="border-b border-slate-100 px-4 py-2.5 panel-title">Executors</div>
      <ul className="divide-y divide-slate-100 text-xs">
        {executors.map((e) => (
          <li key={e.id} className="flex items-center gap-2 px-4 py-2">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
            <span className="font-mono text-slate-800">{e.id}</span>
            <span className="ml-auto tabular-nums text-slate-600">
              {e.inFlight} / {e.concurrency} slots
            </span>
            <span className="text-slate-400">seen {timeAgo(e.lastSeen)}</span>
          </li>
        ))}
        {executors.length === 0 && <li className="px-4 py-4 text-center text-red-700">No executor heartbeats. Runs will queue.</li>}
      </ul>
      <div className="border-y border-slate-100 px-4 py-2.5 panel-title">Top users by tokens · 24h</div>
      <ul className="divide-y divide-slate-100 text-xs">
        {topUsers.map((u) => (
          <li key={u.displayName} className="flex items-center px-4 py-2 text-slate-700">
            {u.displayName}
            <span className="ml-auto tabular-nums">
              {u.runs} runs · {u.tokens.toLocaleString()} tokens
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
