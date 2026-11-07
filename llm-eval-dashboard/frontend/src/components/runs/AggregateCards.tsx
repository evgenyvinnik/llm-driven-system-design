import { CiBar } from '@/components/shared/CiBar'
import { ci, score } from '@/lib/format'
import type { RunScorer } from '@/types'

function ScorerCard({ s, selected, onSelect }: { s: RunScorer; selected: boolean; onSelect: () => void }) {
  const a = s.aggregate
  return (
    <button type="button" onClick={onSelect} className={`card w-full space-y-2 p-4 text-left ${selected ? 'ring-2 ring-accent-500' : 'hover:border-slate-300'}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-slate-800">
          {s.name} <span className="text-slate-500">v{s.version}</span>
        </div>
        {s.origin === 'rescore' && <span className="chip bg-violet-100 text-violet-800">re-scored</span>}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="num text-2xl font-semibold text-slate-900">{score(a.mean)}</span>
        <span className="num text-xs text-slate-500">95% CI {ci(a.ci)}</span>
      </div>
      <CiBar mean={a.mean} ci={a.ci} label={`${s.name} mean ${score(a.mean)} with interval ${ci(a.ci)}`} />
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600">
        <span>
          n = {a.scoredCases} of {a.totalCases} cases
        </span>
        <span className={a.erroredTasks > 0 ? 'font-medium text-rose-700' : 'text-slate-400'}>
          {a.erroredTasks} errored ({a.erroredCases} {a.erroredCases === 1 ? 'case' : 'cases'}) excluded
        </span>
        {a.partialCases > 0 && <span className="text-amber-700">{a.partialCases} partial</span>}
        {(a.unscoredTasks > 0 || s.coverage.pending > 0) && (
          <span className="text-amber-700">
            {s.coverage.pending > 0 ? `${s.coverage.pending} scoring…` : `${a.unscoredTasks} unscored`}
          </span>
        )}
        <span>{a.flakyCases} flaky</span>
        {a.bootstrapCi && <span className="text-slate-400">bootstrap {ci(a.bootstrapCi)}</span>}
      </div>
    </button>
  )
}

export function AggregateCards({ scorers, selected, onSelect }: { scorers: RunScorer[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Aggregates">
      {scorers.map((s) => (
        <ScorerCard key={s.scorerVersionId} s={s} selected={selected === s.scorerVersionId} onSelect={() => onSelect(s.scorerVersionId)} />
      ))}
    </div>
  )
}
