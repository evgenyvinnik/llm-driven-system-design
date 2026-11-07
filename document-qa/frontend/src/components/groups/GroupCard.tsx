import { useState } from 'react'
import { XIcon } from '@/components/icons'
import { ApiError, api } from '@/services/api'
import type { Group, OrgUser } from '@/types'

export function GroupCard({ group, users, canEdit, onChange }: { group: Group; users: OrgUser[]; canEdit: boolean; onChange: () => void }) {
  const [pick, setPick] = useState('')
  const [error, setError] = useState<string | null>(null)
  const candidates = users.filter((u) => !group.members.some((m) => m.userId === u.id))

  async function run(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      onChange()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Request failed')
    }
  }

  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-slate-900">{group.name}</h2>
        <span className="text-xs text-slate-500">
          {group.documentCount} shared document{group.documentCount === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="mt-2 divide-y divide-slate-100" aria-label={`${group.name} members`}>
        {group.members.map((m) => (
          <li key={m.userId} className="flex items-center justify-between py-1.5 text-sm">
            <span>
              {m.displayName} <span className="text-xs text-slate-500">@{m.username}</span>
            </span>
            {canEdit && (
              <button type="button" className="btn-ghost !px-1.5 !py-0.5 text-xs" onClick={() => void run(() => api.removeMember(group.id, m.userId))}>
                <XIcon className="h-3 w-3" /> Remove
              </button>
            )}
          </li>
        ))}
        {group.members.length === 0 && <li className="py-1.5 text-sm text-slate-500">No members</li>}
      </ul>
      {canEdit && candidates.length > 0 && (
        <div className="mt-2 flex gap-2">
          <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} aria-label={`Add a member to ${group.name}`}>
            <option value="">Add member…</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
          </select>
          <button type="button" className="btn-secondary" disabled={!pick} onClick={() => void run(() => api.addMember(group.id, pick)).then(() => setPick(''))}>
            Add
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-rose-800">{error}</p>}
    </div>
  )
}
