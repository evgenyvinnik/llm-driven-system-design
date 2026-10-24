import { useState, type FormEvent } from 'react'
import { MergeIcon } from '@/components/icons'
import { formatBytes } from '@/lib/format'
import { api, errorMessage } from '@/services/api'
import { useToasts } from '@/stores/toast-store'
import type { UserSummary } from '@/types'

export function MergeUsersForm({ users, onMerged }: { users: UserSummary[]; onMerged: () => void }) {
  const push = useToasts((s) => s.push)
  const [target, setTarget] = useState('')
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!target || !source) return push('error', 'Pick both users')
    setBusy(true)
    try {
      const { remaining } = await api.mergeUsers(target, source)
      push('success', `Merged ${source} into ${target}. ${target} has ${formatBytes(remaining)} left`)
      setSource('')
      onMerged()
    } catch (err) {
      push('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const select = (id: string, value: string, onChange: (v: string) => void) => (
    <select id={id} className="input font-mono" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose…</option>
      {users.map((u) => (
        <option key={u.id} value={u.id}>
          {u.id}
        </option>
      ))}
    </select>
  )

  return (
    <form className="card space-y-3 p-4" onSubmit={submit}>
      <h2 className="panel-title">Merge users</h2>
      <p className="text-xs text-slate-500">
        Moves every file and all capacity from the source to the target, then deletes the source and its backup.
      </p>
      <div>
        <label className="label" htmlFor="merge-source">
          Source (deleted)
        </label>
        {select('merge-source', source, setSource)}
      </div>
      <div>
        <label className="label" htmlFor="merge-target">
          Target (keeps everything)
        </label>
        {select('merge-target', target, setTarget)}
      </div>
      <button className="btn-secondary w-full" disabled={busy}>
        <MergeIcon /> Merge
      </button>
    </form>
  )
}
