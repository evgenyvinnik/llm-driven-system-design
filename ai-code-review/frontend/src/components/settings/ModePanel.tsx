import { useState } from 'react'
import { ModeChip, ToneIcon } from '@/components/shared/Chips'
import { ErrorNote } from '@/components/shared/Loading'
import { ago, humanize } from '@/lib/format'
import { api } from '@/services/api'
import type { RepoDetail } from '@/types'

export function ModePanel({ detail, editable, onChange }: { detail: RepoDetail; editable: boolean; onChange: () => void }) {
  const { repo, promotion, shadow, modeChanges } = detail
  const [error, setError] = useState<string | null>(null)
  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work')
    }
    onChange()
  }
  return (
    <section className="card space-y-4 p-4" aria-label="Mode">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="panel-title">Mode</h2>
          <ModeChip mode={repo.mode} killSwitch={repo.killSwitch} />
        </div>
        {editable && (
          <div className="flex flex-wrap gap-2">
            {repo.mode === 'observe' && <button type="button" className="btn-primary" onClick={() => void act(() => api.promote(repo.id))}>Promote to narrow auto</button>}
            {repo.mode === 'narrow_auto' && <button type="button" className="btn-secondary" onClick={() => void act(() => api.demote(repo.id, 'Demoted by hand from the console'))}>Demote to observe</button>}
            <button type="button" className="btn-danger" onClick={() => void act(() => api.killSwitch(repo.id, !repo.killSwitch))}>{repo.killSwitch ? 'Turn kill switch off' : 'Kill switch: stop approvals'}</button>
          </div>
        )}
      </div>
      {error && <ErrorNote message={error} />}
      {repo.demotedReason && <p className="text-sm text-rose-800">Demoted {ago(repo.demotedAt)}: {repo.demotedReason}</p>}
      <p className="text-xs text-slate-500">Observe comments and logs a shadow decision, and never approves. Narrow auto approves only what is in scope and passes every rule. Shadow decisions so far: {shadow.decisions}, with {shadow.agreed} of {shadow.labeled} labeled agreeing with people.</p>
      <div className="overflow-x-auto">
        <table aria-label="Promotion checks" className="w-full">
          <thead><tr><th className="th" /><th className="th">Promotion check</th><th className="th">Required</th><th className="th">Found</th></tr></thead>
          <tbody>
            {promotion.checks.map((c) => (
              <tr key={c.id} className="border-t border-slate-100">
                <td className="td w-6"><ToneIcon ok={c.passed} /></td>
                <td className="td font-medium">{humanize(c.id)}</td>
                <td className="td text-xs">{c.required}</td>
                <td className="td num text-xs">{c.actual}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {modeChanges.length > 0 && (
        <div>
          <h3 className="panel-title mb-1">History</h3>
          <ul className="space-y-1 text-xs text-slate-600" aria-label="Mode history">
            {modeChanges.map((m) => <li key={m.id} className="break-words"><b>{humanize(m.kind)}</b> by {m.actor}, {ago(m.createdAt)}: {m.reason}</li>)}
          </ul>
        </div>
      )}
    </section>
  )
}
