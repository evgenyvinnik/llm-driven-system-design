import { useCallback, useEffect, useState } from 'react'
import { StatusDot } from '@/components/shared'
import { timeAgo, versionLabel } from '@/lib/format'
import { api } from '@/services/api'
import { useRuns } from '@/stores/runs-store'
import { isTerminal, type Run } from '@/types'

interface Props {
  promptId: string
  selection: string | undefined
  onSelect: (selection: string) => void
  /** Bump to refetch after starting runs. */
  refreshKey: number
}

interface HistoryRow {
  key: string
  runs: Run[]
}

/** Runs of this prompt, newest first. Comparison runs collapse into one row. */
export function RunHistory({ promptId, selection, onSelect, refreshKey }: Props) {
  const live = useRuns((s) => s.runs)
  const [runs, setRuns] = useState<Run[]>([])
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(
    async (before?: string) => {
      setLoading(true)
      try {
        const page = await api.listRuns(promptId, before)
        setRuns((prev) => (before ? [...prev, ...page.runs] : page.runs))
        setNextBefore(page.nextBefore)
      } finally {
        setLoading(false)
      }
    },
    [promptId],
  )

  // Refetch when a run of this prompt finishes, so its output preview appears.
  const finished = Object.values(live).filter((r) => r.promptId === promptId && isTerminal(r.status)).length
  useEffect(() => {
    void load()
  }, [load, refreshKey, finished])

  // Live status from streams overrides the fetched (possibly stale) status.
  const merged = runs.map((r) => (live[r.id] ? { ...r, status: live[r.id].status } : r))
  const rows: HistoryRow[] = []
  for (const run of merged) {
    const key = run.comparisonId ?? run.id
    const existing = rows.find((row) => row.key === key)
    // The list is newest first; unshift keeps a comparison's runs oldest first, matching its A/B/C columns.
    if (existing) existing.runs.unshift(run)
    else rows.push({ key, runs: [run] })
  }

  return (
    <div className="card flex min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
        <span className="panel-title">History</span>
        <span className="text-xs text-slate-400">{runs.length} loaded</span>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto">
        {rows.map((row) => {
          const first = row.runs[0]
          const selected = selection === row.key
          return (
            <li key={row.key}>
              <button
                className={`flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-slate-50 ${selected ? 'bg-accent-50/60' : ''}`}
                onClick={() => onSelect(row.key)}
              >
                <div className="mt-1.5 flex gap-0.5">
                  {row.runs.map((r) => (
                    <StatusDot key={r.id} status={r.status} />
                  ))}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono font-medium text-slate-800">{row.runs.map((r) => r.model).join(' vs ')}</span>
                    <span className="text-slate-500">{versionLabel(first.version, first.savedVersion)}</span>
                    <span className="ml-auto shrink-0 text-slate-400">{timeAgo(first.createdAt)}</span>
                  </div>
                  <div className="truncate text-xs text-slate-500">
                    {first.createdBy.displayName} · {first.outputPreview || (first.status === 'failed' ? first.errorMessage : '…')}
                  </div>
                </div>
              </button>
            </li>
          )
        })}
        {rows.length === 0 && !loading && <li className="px-3 py-6 text-center text-xs text-slate-400">No runs yet.</li>}
      </ul>
      {nextBefore && (
        <button className="border-t border-slate-100 py-1.5 text-xs font-medium text-accent-700 hover:bg-slate-50" onClick={() => void load(nextBefore)} disabled={loading}>
          Load older runs
        </button>
      )}
    </div>
  )
}
