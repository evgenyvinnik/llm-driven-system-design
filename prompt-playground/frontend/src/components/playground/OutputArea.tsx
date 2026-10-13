import { useEffect, useMemo, useState } from 'react'
import { ErrorNote } from '@/components/shared'
import { api } from '@/services/api'
import { useRuns } from '@/stores/runs-store'
import { RunOutput } from './RunOutput'

interface Props {
  /** A run ID or a comparison ID. */
  selection: string | undefined
  promptTitle: string
  onShareRun: (runId: string) => void
}

const LABELS = ['A', 'B', 'C']

export function OutputArea({ selection, promptTitle, onShareRun }: Props) {
  const runs = useRuns((s) => s.runs)
  const follow = useRuns((s) => s.follow)
  const cancel = useRuns((s) => s.cancel)
  const [error, setError] = useState<string | null>(null)

  const group = useMemo(
    () =>
      selection
        ? Object.values(runs)
            .filter((r) => r.id === selection || r.comparisonId === selection)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        : [],
    [runs, selection],
  )

  // Deep links and history clicks: load the selected run (or comparison) if it is not in memory yet.
  const needsLoad = selection !== undefined && group.length === 0
  useEffect(() => {
    if (!selection || !needsLoad) return
    setError(null)
    api
      .getRun(selection)
      .then(({ run }) => {
        if (run.comparisonId) return api.comparison(run.comparisonId).then(({ runs }) => runs.forEach((r) => follow(r, promptTitle)))
        follow(run, promptTitle)
      })
      .catch(() =>
        api
          .comparison(selection)
          .then(({ runs }) => runs.forEach((r) => follow(r, promptTitle)))
          .catch(() => setError('That run could not be found.')),
      )
  }, [selection, needsLoad, follow, promptTitle])

  if (!selection) {
    return (
      <div className="card flex flex-1 flex-col items-center justify-center p-8 text-center">
        <p className="text-sm font-medium text-slate-700">Run the prompt to see output here.</p>
        <p className="mt-1 max-w-sm text-xs text-slate-500">
          Runs keep going if you switch prompts or close the tab; you’ll find them in the history below.
        </p>
      </div>
    )
  }
  if (error) return <ErrorNote message={error} />

  const comparing = group.length > 1
  return (
    <div className={`grid min-h-0 flex-1 gap-3 ${comparing ? (group.length === 3 ? 'grid-cols-3' : 'grid-cols-2') : 'grid-cols-1'}`}>
      {group.map((run, i) => (
        <RunOutput
          key={run.id}
          run={run}
          label={comparing ? LABELS[i] : undefined}
          onStop={() => void cancel(run.id)}
          onShare={() => onShareRun(run.id)}
        />
      ))}
    </div>
  )
}
