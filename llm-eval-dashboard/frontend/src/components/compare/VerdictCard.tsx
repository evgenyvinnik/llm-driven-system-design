import { CiBar } from '@/components/shared/CiBar'
import { ci, score, signed } from '@/lib/format'
import type { Comparison, VerdictCode } from '@/types'

const TONE: Record<VerdictCode, string> = {
  improvement: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  regression: 'border-rose-300 bg-rose-50 text-rose-900',
  not_significant: 'border-slate-300 bg-white text-slate-900',
  confounded: 'border-amber-300 bg-amber-50 text-amber-900',
  not_claimable: 'border-amber-300 bg-amber-50 text-amber-900',
  indicative_only: 'border-amber-300 bg-amber-50 text-amber-900',
  not_comparable: 'border-rose-300 bg-rose-50 text-rose-900',
  insufficient_data: 'border-slate-300 bg-white text-slate-900',
}

export function VerdictCard({ c, onRescore }: { c: Comparison; onRescore: (runId: string, scorerVersionId: string) => void }) {
  const p = c.paired
  const u = c.unpaired
  const suggestion = c.provenance.scorer.rescoreSuggestion
  return (
    <div className={`rounded-lg border-2 p-5 ${TONE[c.verdict.code]}`} aria-label="Verdict">
      <div className="text-[11px] font-semibold uppercase tracking-wide opacity-70">{c.verdict.code.replace(/_/g, ' ')} · {c.scorer.name}{c.provenance.scorer.commonVersion ? ` v${c.provenance.scorer.commonVersion}` : ''}</div>
      <div className="mt-1 text-lg font-semibold">{c.verdict.headline}</div>
      <p className="mt-1 text-sm opacity-80">{c.verdict.detail}</p>
      {p && (
        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-5">
          <Metric label="Mean A" value={score(p.meanA)} />
          <Metric label="Mean B" value={score(p.meanB)} />
          <Metric label="Paired Δ (B − A)" value={signed(p.meanDiff)} hint={`95% CI ${ci(p.ci, true)}`} />
          <Metric label="Win / loss / tie" value={`${p.wins} / ${p.losses} / ${p.ties}`} hint={`${p.n} paired cases`} />
          <Metric label="Excluded" value={`${c.excludedCases} of ${c.totalCases}`} hint="errored or unscored in A or B" />
        </div>
      )}
      {p && (
        <div className="mt-3">
          <CiBar mean={p.meanDiff} ci={p.ci} diverging label={`paired difference ${signed(p.meanDiff)} with interval ${ci(p.ci, true)}`} />
          <div className="flex justify-between text-[10px] text-slate-500">
            <span>−1 (B worse)</span>
            <span>0</span>
            <span>+1 (B better)</span>
          </div>
          <div className="text-[11px] opacity-70">bootstrap over cases {ci(p.bootstrapCi, true)}</div>
        </div>
      )}
      {u && (
        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-5">
          <Metric label="Mean A (shared)" value={score(u.meanA)} />
          <Metric label="Mean B (shared)" value={score(u.meanB)} />
          <Metric label="Welch Δ" value={signed(u.meanDiff)} hint={`95% CI ${ci(u.ci, true)}`} />
          <Metric label="Shared unchanged" value={String(u.sharedCases)} hint={`${u.changed} changed, ${u.onlyA} only in A, ${u.onlyB} only in B`} />
          <Metric label="Pairing" value="impossible" hint="dataset versions differ" />
        </div>
      )}
      {suggestion && (
        <button type="button" className="btn-primary mt-4" onClick={() => onRescore(suggestion.runId, suggestion.scorerVersionId)}>
          Re-score {suggestion.runId === c.a.id ? 'A' : 'B'} with v{suggestion.version} (no new generations)
        </button>
      )}
    </div>
  )
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide opacity-60">{label}</div>
      <div className="num text-xl font-semibold">{value}</div>
      {hint && <div className="num text-[11px] opacity-70">{hint}</div>}
    </div>
  )
}
