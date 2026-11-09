import { Chip } from '@/components/shared/Chips'
import type { Run } from '@/types'

const SEV = { critical: 'bad', warning: 'warn', info: 'mute' } as const

export function ModelPanel({ run }: { run: Run | undefined }) {
  if (!run) return null
  const o = run.parsedOutput
  return (
    <section aria-label="Model assessment" className="card p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="panel-title">Model opinion (untrusted data)</h2>
        <span className="text-xs text-slate-500">{run.modelVersion}</span>
      </div>
      {o ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            <Chip tone={o.verdict === 'approve' ? 'good' : 'bad'}>{o.verdict.replace('_', ' ')}</Chip>
            <Chip tone={o.risk === 'low' ? 'mute' : 'warn'}>{o.risk} risk</Chip>
            <Chip>{o.confidence.toFixed(2)} confidence</Chip>
          </div>
          <p className="mt-2 text-sm text-slate-700">{o.summary}</p>
          {o.findings.length > 0 && (
            <ul className="mt-3 space-y-2">
              {o.findings.map((f, i) => (
                <li key={i} className="text-sm">
                  <Chip tone={SEV[f.severity]}>{f.severity}</Chip> <span className="font-medium text-slate-800">{f.title}</span>
                  {f.path && <code className="code ml-1">{f.path}</code>}
                  <div className="text-xs text-slate-500">{f.detail}</div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <div className="text-sm">
          <Chip tone="bad">{(run.modelOutcome ?? run.status).replace(/_/g, ' ')}</Chip>
          {run.errorDetail && <p className="mt-2 break-words text-slate-600">{run.errorDetail}</p>}
          {run.rawOutput && <pre className="mt-2 max-h-40 overflow-auto rounded bg-slate-100 p-2 font-mono text-xs text-slate-700">{run.rawOutput}</pre>}
        </div>
      )}
      {run.scannerHits.length > 0 && (
        <div className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-600">
          <span className="font-semibold">Injection scanner (a signal, not the defense):</span>
          <ul className="mt-1 space-y-1">{run.scannerHits.slice(0, 4).map((h, i) => <li key={i}><code className="code">{h.source}</code> {h.pattern.replace(/_/g, ' ')}: “{h.excerpt}”</li>)}</ul>
        </div>
      )}
    </section>
  )
}
