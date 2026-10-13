import { timeAgo } from '@/lib/format'
import type { AdminOverview } from '@/types'

export function FailuresList({ failures }: { failures: AdminOverview['recentFailures'] }) {
  return (
    <div className="card">
      <div className="border-b border-slate-100 px-4 py-2.5 panel-title">Recent failures</div>
      <ul className="divide-y divide-slate-100">
        {failures.map((f) => (
          <li key={f.id} className="px-4 py-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="chip bg-red-50 font-mono text-red-700">{f.errorCode ?? 'FAILED'}</span>
              <span className="font-mono text-slate-700">{f.model}</span>
              <span className="ml-auto text-slate-400">{timeAgo(f.createdAt)}</span>
            </div>
            <div className="mt-0.5 truncate text-slate-600">
              {f.promptTitle} — {f.errorMessage}
            </div>
          </li>
        ))}
        {failures.length === 0 && <li className="px-4 py-6 text-center text-xs text-slate-400">No failures.</li>}
      </ul>
    </div>
  )
}
