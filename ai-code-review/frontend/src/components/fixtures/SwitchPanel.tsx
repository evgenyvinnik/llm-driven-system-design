import { api } from '@/services/api'
import type { SystemView } from '@/types'

const CHAOS: [string, string][] = [
  ['malformed', 'Malformed output'],
  ['schema_violation', 'Schema violation'],
  ['hostile_text', 'Hostile text'],
  ['timeout', 'Timeout'],
  ['overloaded', 'Overloaded (529)'],
  ['rate_limited', 'Rate limited (429)'],
  ['disconnect', 'Mid-stream disconnect'],
]

export function SwitchPanel({ system, disabled, run }: { system: SystemView; disabled: boolean; run: (label: string, fn: () => Promise<unknown>) => Promise<unknown> }) {
  const m = system.model?.settings
  const h = system.host
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <section className="card space-y-2 p-4" aria-label="Mock model">
        <h2 className="panel-title">Mock model</h2>
        {!m ? <p className="text-sm text-rose-700">The mock model is not reachable. Reviews are failing closed.</p> : (
          <>
            <ul className="space-y-1">
              {CHAOS.map(([id, label]) => (
                <li key={id} className="flex items-center justify-between text-sm">
                  <span className="text-slate-700">{label} <span className="num text-xs text-slate-400">armed {m.chaos[id] ?? 0}</span></span>
                  <button type="button" className="btn-secondary !py-0.5" disabled={disabled} onClick={() => void run(`Armed ${label}`, () => api.patchModel({ chaos: { [id]: (m.chaos[id] ?? 0) + 1 } }))}>Arm next call</button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2 text-sm">
              <span className="text-slate-600">Outage (failure rate {m.failureRate * 100}%)</span>
              <button type="button" className="btn-danger !py-0.5" disabled={disabled} onClick={() => void run(m.failureRate > 0 ? 'Outage ended' : 'Outage started', () => api.patchModel({ failureRate: m.failureRate > 0 ? 0 : 1 }))}>{m.failureRate > 0 ? 'End outage' : 'Start outage'}</button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-slate-600">Time to first token {m.ttftMs} ms</span>
              {[250, 2000].map((t) => <button key={t} type="button" className="btn-secondary !py-0.5" disabled={disabled} onClick={() => void run(`Time to first token is ${t} ms`, () => api.patchModel({ ttftMs: t }))}>{t} ms</button>)}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-slate-600">{m.followInjections ? 'Obeys injections, on purpose' : 'Ignores injections'}</span>
              <button type="button" className="btn-secondary !py-0.5" disabled={disabled} onClick={() => void run('Toggled injection susceptibility', () => api.patchModel({ followInjections: !m.followInjections }))}>Toggle</button>
            </div>
            {system.model && <p className="text-xs text-slate-500">{system.model.stats.calls} calls, {system.model.stats.active} in flight.</p>}
          </>
        )}
      </section>
      <section className="card space-y-2 p-4" aria-label="Git host">
        <h2 className="panel-title">Fixture Git host</h2>
        {!h ? <p className="text-sm text-rose-700">The fixture host is not reachable.</p> : (
          <ul className="space-y-1.5 text-sm">
            <li className="flex items-center justify-between"><span>Drop next webhook <span className="num text-xs text-slate-400">armed {h.dropNext}</span></span><button type="button" className="btn-secondary !py-0.5" disabled={disabled} onClick={() => void run('The next webhook will be lost', () => api.patchHost({ dropNext: h.dropNext + 1 }))}>Arm</button></li>
            <li className="flex items-center justify-between"><span>Deliver next webhook twice <span className="num text-xs text-slate-400">armed {h.duplicateNext}</span></span><button type="button" className="btn-secondary !py-0.5" disabled={disabled} onClick={() => void run('The next webhook will arrive twice', () => api.patchHost({ duplicateNext: h.duplicateNext + 1 }))}>Arm</button></li>
            <li className="flex items-center justify-between"><span>Hold each review before the lock <span className="num text-xs text-slate-400">{h.reviewDelayMs} ms</span></span><button type="button" className="btn-secondary !py-0.5" disabled={disabled} onClick={() => void run(h.reviewDelayMs > 0 ? 'Reviews are immediate' : 'Reviews are held for 3 s: push now to see the compare-and-swap', () => api.patchHost({ reviewDelayMs: h.reviewDelayMs > 0 ? 0 : 3000 }))}>{h.reviewDelayMs > 0 ? 'Off' : '3 s'}</button></li>
          </ul>
        )}
      </section>
    </div>
  )
}
