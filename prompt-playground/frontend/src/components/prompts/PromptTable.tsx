import { Link } from '@tanstack/react-router'
import { StatusDot } from '@/components/shared'
import { timeAgo } from '@/lib/format'
import type { PromptListItem } from '@/types'

export function PromptTable({ prompts }: { prompts: PromptListItem[] }) {
  if (prompts.length === 0) {
    return <div className="card p-10 text-center text-sm text-slate-500">No prompts yet. Create one to start experimenting.</div>
  }
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2.5 font-semibold">Prompt</th>
            <th className="px-4 py-2.5 font-semibold">Version</th>
            <th className="px-4 py-2.5 font-semibold">Runs</th>
            <th className="px-4 py-2.5 font-semibold">Last run</th>
            <th className="px-4 py-2.5 font-semibold">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {prompts.map((p) => (
            <tr key={p.id} className="hover:bg-slate-50">
              <td className="px-4 py-3">
                <Link to="/prompts/$promptId" params={{ promptId: p.id }} className="font-medium text-slate-900 hover:text-accent-700">
                  {p.title}
                </Link>
                {p.description && <div className="mt-0.5 line-clamp-1 text-xs text-slate-500">{p.description}</div>}
              </td>
              <td className="px-4 py-3">
                {p.headVersion > 0 ? <span className="chip bg-slate-100 text-slate-700">v{p.headVersion}</span> : <span className="text-xs text-slate-400">unsaved</span>}
              </td>
              <td className="px-4 py-3 tabular-nums text-slate-700">{p.runCount}</td>
              <td className="px-4 py-3">
                {p.lastRun ? (
                  <span className="flex items-center gap-2 text-slate-700">
                    <StatusDot status={p.lastRun.status} />
                    <span className="font-mono text-xs">{p.lastRun.model}</span>
                    <span className="text-xs text-slate-500">{timeAgo(p.lastRun.createdAt)}</span>
                  </span>
                ) : (
                  <span className="text-xs text-slate-400">never</span>
                )}
              </td>
              <td className="px-4 py-3 text-xs text-slate-500">
                {timeAgo(p.updatedAt)} by {p.updatedBy.displayName}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
