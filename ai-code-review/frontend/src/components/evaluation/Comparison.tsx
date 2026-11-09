import { pct } from '@/lib/format'
import type { EvaluationSummary, PipelineMetrics } from '@/types'

function Matrix({ m }: { m: PipelineMetrics }) {
  const c = m.confusion
  const cell = (n: number, tone: string) => <td className={`num border border-slate-200 px-3 py-2 text-center text-lg font-semibold ${tone}`}>{n}</td>
  return (
    <table aria-label={`Confusion matrix, ${m.pipeline}`} className="w-full text-sm">
      <thead>
        <tr><th className="th" /><th className="th text-center">Approved</th><th className="th text-center">Sent to a person</th></tr>
      </thead>
      <tbody>
        <tr><th className="th">Dangerous</th>{cell(c.dangerousApproved, c.dangerousApproved > 0 ? 'bg-rose-100 text-rose-800' : 'bg-emerald-50 text-emerald-800')}{cell(c.dangerousEscalated, 'text-slate-700')}</tr>
        <tr><th className="th">Safe</th>{cell(c.safeApproved, 'text-slate-700')}{cell(c.safeEscalated, 'bg-amber-50 text-amber-800')}</tr>
      </tbody>
    </table>
  )
}

function Column({ title, subtitle, m }: { title: string; subtitle: string; m: PipelineMetrics }) {
  const d = m.dangerous
  const fe = m.falseEscalations
  return (
    <section aria-label={title} className="card space-y-3 p-4">
      <div>
        <h2 className="font-semibold text-slate-900">{title}</h2>
        <p className="text-xs text-slate-500">{subtitle}</p>
      </div>
      <div>
        <div className={`num text-4xl font-semibold ${d.falseApprovals > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{d.falseApprovals}<span className="text-lg text-slate-400"> / {d.total}</span></div>
        <div className="text-sm text-slate-600">dangerous false approvals</div>
        <div className="text-xs text-slate-500">95% upper bound {pct(d.upperBound95)}{d.ruleOfThree !== null ? `, rule of three ${pct(d.ruleOfThree)}` : ''}</div>
      </div>
      <Matrix m={m} />
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <dt className="text-slate-500">False escalations</dt><dd className="num text-right">{fe.count} / {fe.total}</dd>
        <dt className="text-slate-500">In-scope false escalations</dt><dd className="num text-right">{fe.inScopeCount} / {fe.inScopeTotal}</dd>
        <dt className="text-slate-500">Approved without a person</dt><dd className="num text-right">{pct(m.automationRate)}</dd>
        <dt className="text-slate-500">Injections approved</dt><dd className="num text-right">{m.injection.approved} / {m.injection.total}</dd>
        <dt className="text-slate-500">...of which dangerous</dt><dd className="num text-right">{m.injection.dangerousApproved}</dd>
      </dl>
    </section>
  )
}

export function Comparison({ summary }: { summary: EvaluationSummary }) {
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <Column title="Model only" subtitle="The proposed design: the model's word is the decision." m={summary.modelOnly} />
      <Column title="Model + gate" subtitle="The corrected design in narrow_auto. Same corpus, same model." m={summary.modelPlusGate} />
    </div>
  )
}
