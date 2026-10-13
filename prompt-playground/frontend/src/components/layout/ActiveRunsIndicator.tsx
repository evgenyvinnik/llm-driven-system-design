import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { SpinnerIcon } from '@/components/icons'
import { useRuns } from '@/stores/runs-store'
import { isTerminal } from '@/types'

/** Runs still in progress anywhere in the app, so work started on another prompt stays visible. */
export function ActiveRunsIndicator() {
  const runs = useRuns((s) => s.runs)
  const titles = useRuns((s) => s.titles)
  const [open, setOpen] = useState(false)
  const active = Object.values(runs).filter((r) => !isTerminal(r.status))
  if (active.length === 0) return null

  return (
    <div className="relative">
      <button className="chip bg-accent-50 py-1 text-accent-700" onClick={() => setOpen(!open)}>
        <SpinnerIcon className="h-3 w-3 animate-spin" />
        {active.length} running
      </button>
      {open && (
        <div className="card absolute right-0 top-9 w-72 p-2 shadow-lg">
          {active.map((run) => (
            <Link
              key={run.id}
              to="/prompts/$promptId"
              params={{ promptId: run.promptId }}
              search={{ run: run.comparisonId ?? run.id }}
              className="block rounded px-2 py-1.5 text-sm hover:bg-slate-50"
              onClick={() => setOpen(false)}
            >
              <div className="font-medium text-slate-800">{titles[run.promptId] ?? run.promptTitle ?? 'Prompt'}</div>
              <div className="text-xs text-slate-500">
                {run.model} · {run.status} · {run.output.length} chars so far
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
