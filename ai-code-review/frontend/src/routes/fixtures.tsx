import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { OpenFixture, PrActions } from '@/components/fixtures/PullActions'
import { SwitchPanel } from '@/components/fixtures/SwitchPanel'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import { canAdmin, useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/fixtures')({ component: Fixtures })

function Fixtures() {
  const user = useAuthStore((s) => s.user)
  const editable = canAdmin(user)
  const [picked, setPicked] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const repos = usePoll(() => api.repos(), 15000)
  const repo = picked ?? repos.data?.repos[0]?.fullName ?? null
  const catalog = usePoll(() => api.catalog(), 60000)
  const prs = usePoll(() => (repo ? api.prs({ repo }) : Promise.resolve({ prs: [] })), 3000, [repo])
  const system = usePoll(() => api.system(), 3000)

  async function run(label: string, fn: () => Promise<unknown>) {
    setError(null)
    setMessage(null)
    try {
      await fn()
      setMessage(label)
      prs.reload()
      system.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work')
    }
  }

  return (
    <div className="page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="h1">Fixture panel</h1>
          <p className="max-w-2xl text-sm text-slate-500">Drives the fixture Git host and the mock model, so the whole story can be demoed from the browser. {editable ? '' : 'Sign in as a repo admin (carol) to use these controls.'}</p>
        </div>
        <select aria-label="Repository" className="input !w-56" value={repo ?? ''} onChange={(e) => setPicked(e.target.value)}>
          {repos.data?.repos.map((r) => <option key={r.id} value={r.fullName}>{r.fullName} ({r.mode === 'narrow_auto' ? 'narrow auto' : 'observe'})</option>)}
        </select>
      </div>
      {message && <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</div>}
      {error && <ErrorNote message={error} />}
      {repo && catalog.data && prs.data ? (
        <>
          <OpenFixture repo={repo} catalog={catalog.data.fixtures} disabled={!editable} run={run} />
          <PrActions repo={repo} prs={prs.data.prs} disabled={!editable} run={run} />
        </>
      ) : <Loading />}
      {system.data && <SwitchPanel system={system.data} disabled={!editable} run={run} />}
    </div>
  )
}
