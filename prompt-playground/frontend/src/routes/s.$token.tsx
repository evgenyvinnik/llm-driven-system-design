import { useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { CopyIcon, TerminalIcon } from '@/components/icons'
import { ErrorNote, Loading, StatusBadge } from '@/components/shared'
import { formatCount, formatMs, timeAgo } from '@/lib/format'
import { api, ApiError } from '@/services/api'
import { useAuth } from '@/stores/auth-store'
import type { SharedView } from '@/types'

export const Route = createFileRoute('/s/$token')({ component: SharedPage })

/** Public, read-only view of one shared version or run. */
function SharedPage() {
  const { token } = Route.useParams()
  const status = useAuth((s) => s.status)
  const navigate = useNavigate()
  const [data, setData] = useState<SharedView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [forking, setForking] = useState(false)

  useEffect(() => {
    api
      .getShared(token)
      .then(setData)
      .catch((err) =>
        setError(err instanceof ApiError && err.status === 410 ? 'This link was revoked by its owner.' : 'This link does not exist.'),
      )
  }, [token])

  async function fork() {
    if (status !== 'authenticated') {
      void navigate({ to: '/login' })
      return
    }
    setForking(true)
    try {
      const { promptId } = await api.forkShared(token)
      void navigate({ to: '/prompts/$promptId', params: { promptId } })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not copy the prompt')
      setForking(false)
    }
  }

  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center gap-2 border-b border-slate-200 bg-white px-5 font-semibold">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent-600 text-white">
          <TerminalIcon />
        </span>
        Prompt Playground
        <span className="ml-2 chip bg-slate-100 font-normal text-slate-600">Shared, read-only</span>
        {status === 'authenticated' && (
          <Link to="/" className="btn-ghost ml-auto text-sm font-normal">
            Back to my prompts
          </Link>
        )}
      </header>
      <main className="mx-auto max-w-4xl px-6 py-8">
        {error && <ErrorNote message={error} />}
        {!data && !error && <Loading />}
        {data && <SharedBody data={data} onFork={() => void fork()} forking={forking} />}
      </main>
    </div>
  )
}

function SharedBody({ data, onFork, forking }: { data: SharedView; onFork: () => void; forking: boolean }) {
  const { run } = data
  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{data.prompt.title}</h1>
          <p className="text-sm text-slate-500">
            Shared by {data.share.sharedBy} {timeAgo(data.share.createdAt)} ·{' '}
            {data.version ? `version ${data.version}` : 'unsaved draft'}
            {run && ` · run on ${run.model}`}
          </p>
        </div>
        <button className="btn-primary" onClick={onFork} disabled={forking}>
          <CopyIcon /> Copy to my workspace
        </button>
      </div>
      <section className="grid gap-4 md:grid-cols-2">
        <Block title="System" text={data.snapshot.system || '(empty)'} />
        <Block title="User message" text={data.snapshot.template} />
      </section>
      {run && (
        <section className="mt-6 space-y-4">
          {Object.keys(run.variables).length > 0 && (
            <div className="card p-4">
              <div className="panel-title mb-2">Inputs</div>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                {Object.entries(run.variables).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="font-mono text-xs text-slate-500">{k}</dt>
                    <dd className="whitespace-pre-wrap text-slate-800">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          <div className="card">
            <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2">
              <span className="panel-title">Output</span>
              <StatusBadge status={run.status} />
              <span className="ml-auto text-xs text-slate-500">
                {run.config.model} · temp {run.config.temperature} · {formatCount(run.usage.outputTokens)} tokens ·{' '}
                {formatMs(run.usage.durationMs)}
              </span>
            </div>
            <p className="whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed text-slate-800">{run.output || 'No output.'}</p>
            {run.errorMessage && <p className="px-4 pb-3 text-xs text-red-700">{run.errorMessage}</p>}
          </div>
        </section>
      )}
    </>
  )
}

function Block({ title, text }: { title: string; text: string }) {
  return (
    <div className="card p-4">
      <div className="panel-title mb-2">{title}</div>
      <pre className="whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-slate-800">{text}</pre>
    </div>
  )
}
