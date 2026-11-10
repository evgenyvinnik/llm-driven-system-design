import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Chip, Sha } from '@/components/shared/Chips'
import { ago, humanize } from '@/lib/format'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import type { QueueEscalation } from '@/types'

export function EscalationCard({ item, onChange, onError }: { item: QueueEscalation; onChange: () => void; onError: (m: string) => void }) {
  const user = useAuthStore((s) => s.user)
  const [note, setNote] = useState('')
  const [owner, repo] = item.repo.split('/')
  const mine = item.claimedBy === user?.username
  const isAuthor = item.author === user?.username

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'That did not work')
    }
    onChange()
  }

  return (
    <article className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to="/prs/$owner/$repo/$number" params={{ owner, repo, number: String(item.prNumber) }} className="font-medium text-accent-700 hover:underline">
            {item.repo} #{item.prNumber} {item.title}
          </Link>
          <div className="mt-0.5 text-xs text-slate-500">by {item.author} · <Sha sha={item.headSha} /> · {ago(item.createdAt)}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone={item.status === 'open' ? 'warn' : item.status === 'claimed' ? 'info' : item.resolution === 'approved' ? 'good' : 'mute'}>{item.status}{item.resolution ? `: ${item.resolution}` : ''}</Chip>
          <Chip tone="bad">{humanize(item.reasonCode)}</Chip>
          {item.modelOverruled && <Chip tone="warn">model overruled</Chip>}
        </div>
      </div>
      <p className="mt-2 break-words text-sm text-slate-700">{item.reason}</p>
      {item.claimedBy && item.status === 'claimed' && <p className="mt-1 text-xs text-slate-500">Claimed by {item.claimedBy} {ago(item.claimedAt)}</p>}
      {item.status === 'decided' && <p className="mt-1 text-xs text-slate-500">Decided by {item.decidedBy} at <Sha sha={item.headSha} />{item.note ? `: ${item.note}` : ''}</p>}
      {item.status === 'invalidated' && <p className="mt-1 text-xs text-slate-500">Out of date: {humanize(item.invalidatedReason ?? '')}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {item.status === 'open' && <button type="button" className="btn-secondary" onClick={() => void act(() => api.claim(item.id))}>Claim</button>}
        {item.status === 'claimed' && mine && (
          <>
            <input aria-label="Note" className="input !w-64" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button type="button" className="btn-primary" disabled={isAuthor} title={isAuthor ? 'Authors cannot approve their own pull request' : `Approve commit ${item.headSha.slice(0, 7)}`} onClick={() => void act(() => api.decide(item.id, 'approve', item.headSha, note))}>Approve {item.headSha.slice(0, 7)}</button>
            <button type="button" className="btn-danger" onClick={() => void act(() => api.decide(item.id, 'reject', item.headSha, note))}>Reject</button>
            <button type="button" className="btn-ghost" onClick={() => void act(() => api.release(item.id))}>Release</button>
            {isAuthor && <span className="text-xs text-slate-500">You wrote this, so you can reject it but not approve it.</span>}
          </>
        )}
      </div>
    </article>
  )
}
