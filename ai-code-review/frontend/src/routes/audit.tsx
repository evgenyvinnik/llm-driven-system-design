import { createFileRoute } from '@tanstack/react-router'
import { Fragment, useState } from 'react'
import { VerifyPanel } from '@/components/audit/VerifyPanel'
import { Sha } from '@/components/shared/Chips'
import { Empty, ErrorNote, Loading } from '@/components/shared/Loading'
import { ago, humanize } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/audit')({ component: Audit })

function Audit() {
  const [repo, setRepo] = useState('')
  const [kind, setKind] = useState('')
  const [actor, setActor] = useState('')
  const [pr, setPr] = useState('')
  const [sha, setSha] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const repos = usePoll(() => api.repos(), 15000)
  const { data, error, loading } = usePoll(() => api.audit({ repo, kind, actor, pr, sha, limit: 100 }), 4000, [repo, kind, actor, pr, sha])
  return (
    <div className="page !max-w-7xl">
      <div>
        <h1 className="h1">Audit log</h1>
        <p className="text-sm text-slate-500">Append-only and hash-chained per repository: inputs, model version, raw and parsed output, tools, policy version, every rule result, the decision and the actor.</p>
      </div>
      <VerifyPanel />
      <div className="flex flex-wrap items-center gap-2" aria-label="Filters">
        <select aria-label="Repository" className="input !w-48" value={repo} onChange={(e) => setRepo(e.target.value)}>
          <option value="">All repositories</option>
          {repos.data?.repos.map((r) => <option key={r.id} value={r.fullName}>{r.fullName}</option>)}
        </select>
        <select aria-label="Kind" className="input !w-52" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All kinds</option>
          {data?.kinds.map((k) => <option key={k.kind} value={k.kind}>{humanize(k.kind)} ({k.n})</option>)}
        </select>
        <input aria-label="Actor" className="input !w-32" placeholder="Actor" value={actor} onChange={(e) => setActor(e.target.value)} />
        <input aria-label="Pull request" className="input !w-24" placeholder="PR #" value={pr} onChange={(e) => setPr(e.target.value.replace(/\D/g, ''))} />
        <input aria-label="SHA" className="input !w-40" placeholder="SHA prefix" value={sha} onChange={(e) => setSha(e.target.value.trim())} />
      </div>
      {error && <ErrorNote message={error} />}
      {loading && !data ? <Loading /> : data && data.entries.length > 0 ? (
        <div className="card overflow-x-auto">
          <table aria-label="Audit log" className="w-full">
            <thead><tr><th className="th">Entry</th><th className="th">When</th><th className="th">Kind</th><th className="th">Actor</th><th className="th">PR</th><th className="th">SHA</th><th className="th">Hash</th></tr></thead>
            <tbody>
              {data.entries.map((e) => {
                const key = `${e.repoId}-${e.seq}`
                return (
                  <Fragment key={key}>
                    <tr className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => setOpen(open === key ? null : key)}>
                      <td className="td num whitespace-nowrap text-xs text-slate-500">{e.repo} #{e.seq}</td>
                      <td className="td whitespace-nowrap text-xs">{ago(e.createdAt)}</td>
                      <td className="td font-medium">{humanize(e.kind)}</td>
                      <td className="td">{e.actor}</td>
                      <td className="td num">{e.prNumber ?? '—'}</td>
                      <td className="td"><Sha sha={e.headSha} /></td>
                      <td className="td"><code className="font-mono text-xs text-slate-400">{e.hash.slice(0, 12)}</code></td>
                    </tr>
                    {open === key && (
                      <tr><td colSpan={7} className="bg-slate-50 px-3 py-2">
                        <div className="mb-1 font-mono text-xs text-slate-500">prev {e.prevHash.slice(0, 20)}… hash {e.hash.slice(0, 20)}…</div>
                        <pre className="max-h-80 overflow-auto font-mono text-xs text-slate-700">{JSON.stringify(e.payload, null, 2)}</pre>
                      </td></tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : <Empty>No entries match.</Empty>}
    </div>
  )
}
