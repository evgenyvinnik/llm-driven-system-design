import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { DeliveriesTable } from '@/components/fixtures/DeliveriesTable'
import { ScenarioCard } from '@/components/fixtures/ScenarioCard'
import { AlertIcon, ZapOffIcon } from '@/components/icons'
import { EmptyNote, ErrorNote, Loading, Panel } from '@/components/shared/Feedback'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import type { Delivery } from '@/types'

export const Route = createFileRoute('/fixtures')({ component: Fixtures })

interface Result {
  text: string
  runId?: string | null
  tone: 'ok' | 'warn'
}

function Fixtures() {
  const repos = usePoll(api.repos, 0)
  const scenarios = usePoll(api.scenarios, 0)
  const deliveries = usePoll(api.deliveries, 2000)
  const runners = usePoll(api.runners, 2000)
  const [repoId, setRepoId] = useState<string | null>(null)
  const [results, setResults] = useState<Result[]>([])
  const [error, setError] = useState<string | null>(null)

  const manageable = (repos.data ?? []).filter((r) => r.role === 'maintainer')
  useEffect(() => {
    if (!repoId && manageable[0]) setRepoId(manageable[0].id)
  }, [repoId, manageable])

  const note = (r: Result) => setResults((prev) => [r, ...prev].slice(0, 6))

  async function act(fn: () => Promise<Result>) {
    setError(null)
    try {
      note(await fn())
      deliveries.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work')
    }
  }

  if (!repos.data || !scenarios.data) return <Loading />
  const disabled = manageable.length === 0 || !repoId
  const redeliver = (d: Delivery) =>
    void act(async () => {
      const res = await api.redeliver(d.repoId, d.deliveryId)
      return { text: `Sent delivery ${d.deliveryId.slice(0, 13)} again: HTTP ${res.httpStatus}, ${res.duplicate ? 'recognized as a duplicate, returning the existing' : 'created'} run #${res.runNumber}`, runId: res.runId, tone: 'ok' }
    })

  return (
    <div className="page">
      <div>
        <h1 className="h1">Fixture panel</h1>
        <p className="mt-1 text-sm text-slate-600">
          Stands in for a Git host. Each button commits a fixed scenario to the fixture store and sends a real, signed webhook over HTTP. Scenarios come from a catalog in the code, because runners execute them as local processes: nothing typed here reaches a shell.
        </p>
      </div>
      {manageable.length === 0 && <ErrorNote message="You are not a maintainer of any repository, so you can look but not send events." />}
      {error && <ErrorNote message={error} />}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="label !mb-0">Repository</span>
          <select className="input w-56" value={repoId ?? ''} onChange={(e) => setRepoId(e.target.value)} aria-label="Repository">
            {manageable.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn-secondary"
          disabled={disabled}
          onClick={() =>
            void act(async () => {
              const res = await api.badSignature(repoId as string)
              return { text: `Sent an event with a wrong HMAC: HTTP ${res.httpStatus} ${res.response.error?.code ?? ''}. No delivery was recorded.`, tone: 'warn' }
            })
          }
        >
          <AlertIcon className="h-4 w-4" /> Send a bad signature
        </button>
      </div>
      {results.length > 0 && (
        <ul className="card divide-y divide-slate-100 text-sm" aria-label="Results">
          {results.map((r, i) => (
            <li key={i} className={`px-3 py-2 ${r.tone === 'warn' ? 'text-amber-900' : 'text-slate-700'}`}>
              {r.text}{' '}
              {r.runId && (
                <Link to="/runs/$runId" params={{ runId: r.runId }} className="link">
                  Open the run
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3" aria-label="Scenarios">
        {scenarios.data.map((s) => (
          <ScenarioCard
            key={s.name}
            scenario={s}
            disabled={disabled}
            onTrigger={(kill) =>
              void act(async () => {
                const res = await api.trigger(repoId as string, s.name, kill)
                return { text: `${s.title}: HTTP ${res.httpStatus}${res.runId ? `, run #${res.runNumber}` : `, ${res.outcome}`}${kill ? `, runner armed to die on "${s.killableStep}"` : ''}.`, runId: res.runId, tone: 'ok' }
              })
            }
          />
        ))}
      </div>
      <Panel title="Kill a runner" label="Kill a runner">
        <div className="flex flex-wrap gap-2 p-3">
          {runners.data?.runners.map((r) => (
            <button key={r.id} type="button" className="btn-danger" disabled={!r.online} title="Its next heartbeat tells it to SIGKILL itself. Its jobs keep their leases until they expire." onClick={() => void act(async () => (await api.killRunner(r.id), { text: `${r.name} will SIGKILL itself on its next heartbeat. The local supervisor restarts it a few seconds later.`, tone: 'warn' }))}>
              <ZapOffIcon className="h-4 w-4" /> {r.name} {r.jobs.length > 0 ? `(${r.jobs.length} running)` : '(idle)'}
            </button>
          ))}
          {runners.data?.runners.length === 0 && <span className="text-sm text-slate-500">No runners are registered.</span>}
        </div>
      </Panel>
      <Panel title="Recent deliveries" label="Recent deliveries" aside={<span className="text-xs text-slate-500">the same delivery id always returns the same run</span>}>
        {deliveries.data && deliveries.data.length > 0 ? <DeliveriesTable deliveries={deliveries.data} canRedeliver={(id) => manageable.some((r) => r.id === id)} onRedeliver={redeliver} /> : <div className="p-4"><EmptyNote>No deliveries yet.</EmptyNote></div>}
      </Panel>
    </div>
  )
}
