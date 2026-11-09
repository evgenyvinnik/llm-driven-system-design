import { useEffect, useState } from 'react'
import { ToneIcon } from '@/components/shared/Chips'
import { ErrorNote } from '@/components/shared/Loading'
import { api, type VerifyResult } from '@/services/api'

export function VerifyPanel() {
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    setError(null)
    try {
      setResult(await api.verify())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The check failed')
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void run()
  }, [])

  return (
    <section aria-label="Tamper check" className="card p-4">
      <div className="flex items-center justify-between">
        <h2 className="panel-title">Tamper check</h2>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run()}>{busy ? 'Checking…' : 'Verify the chains'}</button>
      </div>
      {error && <div className="mt-2"><ErrorNote message={error} /></div>}
      {result && (
        <ul className="mt-2 space-y-1 text-sm">
          {result.chains.map((c) => (
            <li key={c.repoId}>
              <div className="flex items-center gap-2">
                <ToneIcon ok={c.ok} />
                <span className="font-medium text-slate-800">{c.repo}</span>
                <span className="text-slate-500">{c.checked} entries, {c.ok ? 'every hash and link verifies' : `${c.problems.length} problem(s)`}</span>
              </div>
              {c.problems.slice(0, 3).map((p, i) => <div key={i} className="ml-6 text-xs font-medium text-rose-700">Entry {p.seq}: {p.detail}</div>)}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
