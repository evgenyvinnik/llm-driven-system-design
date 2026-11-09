import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Chip, ModeChip, OutcomeChip, Sha } from '@/components/shared/Chips'
import { Empty, ErrorNote, Loading } from '@/components/shared/Loading'
import { ago } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import type { PrRow } from '@/types'

export const Route = createFileRoute('/prs/')({ component: PrQueue })

const OUTCOMES = ['auto_approved', 'escalated', 'shadow', 'waiting_ci', 'human_approved', 'human_rejected']

function ModelCell({ pr }: { pr: PrRow }) {
  if (!pr.run) return <span className="text-slate-400">—</span>
  if (pr.run.modelVerdict) return <span>{pr.run.modelVerdict.replace('_', ' ')} {pr.run.modelConfidence !== null && <span className="num text-slate-400">{pr.run.modelConfidence.toFixed(2)}</span>}</span>
  return <span className="text-slate-500">{(pr.run.modelOutcome ?? pr.run.status).replace(/_/g, ' ')}</span>
}

function Row({ pr }: { pr: PrRow }) {
  const [owner, repo] = pr.repo.fullName.split('/')
  const d = pr.decision
  return (
    <tr className="border-t border-slate-100 hover:bg-slate-50">
      <td className="td">
        <Link to="/prs/$owner/$repo/$number" params={{ owner, repo, number: String(pr.number) }} className="font-medium text-accent-700 hover:underline">
          #{pr.number} {pr.title}
        </Link>
        <div className="mt-0.5 text-xs text-slate-500">{pr.repo.fullName} · {pr.author} · {ago(pr.updatedAt)}{pr.state !== 'open' && ` · ${pr.state}`}</div>
      </td>
      <td className="td"><ModeChip mode={pr.repo.mode} killSwitch={pr.repo.killSwitch} /></td>
      <td className="td"><Sha sha={pr.headSha} /></td>
      <td className="td text-xs"><ModelCell pr={pr} /></td>
      <td className="td">
        {d ? <OutcomeChip outcome={d.outcome} invalidated={d.state !== 'active'} /> : <Chip>{pr.run?.status ?? 'queued'}</Chip>}
        {d?.modelOverruled && <div className="mt-1"><Chip tone="warn">model overruled</Chip></div>}
      </td>
      <td className="td max-w-sm text-xs text-slate-600">{d?.state === 'active' ? d.reason : d?.invalidatedReason ?? ''}</td>
    </tr>
  )
}

function PrQueue() {
  const [repo, setRepo] = useState('')
  const [outcome, setOutcome] = useState('')
  const [overruled, setOverruled] = useState(false)
  const repos = usePoll(() => api.repos(), 15000)
  const { data, error, loading } = usePoll(() => api.prs({ repo, outcome, overruled }), 2500, [repo, outcome, overruled])
  return (
    <div className="page !max-w-7xl">
      <div>
        <h1 className="h1">Pull requests</h1>
        <p className="text-sm text-slate-500">Every decision is about one head commit. A model opinion is an input; the gate decides, and only a gate decision can reach the host.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Repository" className="input !w-52" value={repo} onChange={(e) => setRepo(e.target.value)}>
          <option value="">All repositories</option>
          {repos.data?.repos.map((r) => <option key={r.id} value={r.fullName}>{r.fullName}</option>)}
        </select>
        <select aria-label="Decision" className="input !w-48" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="">Any decision</option>
          {OUTCOMES.map((o) => <option key={o} value={o}>{o.replace('_', ' ')}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={overruled} onChange={(e) => setOverruled(e.target.checked)} /> Model overruled only
        </label>
      </div>
      {error && <ErrorNote message={error} />}
      {loading && !data ? <Loading /> : data && data.prs.length > 0 ? (
        <div className="card overflow-x-auto">
          <table aria-label="Pull requests" className="w-full">
            <thead><tr><th className="th">Pull request</th><th className="th">Mode</th><th className="th">Head</th><th className="th">Model</th><th className="th">Decision</th><th className="th">Reason</th></tr></thead>
            <tbody>{data.prs.map((p) => <Row key={`${p.repo.id}-${p.number}`} pr={p} />)}</tbody>
          </table>
        </div>
      ) : <Empty>No pull requests match.</Empty>}
    </div>
  )
}
