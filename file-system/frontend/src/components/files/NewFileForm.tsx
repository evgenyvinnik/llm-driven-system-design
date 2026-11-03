import { useEffect, useState, type FormEvent } from 'react'
import { PlusIcon } from '@/components/icons'
import { SizeInput } from '@/components/shared'
import { toBytes, type SizeUnit } from '@/lib/size'
import { formatBytes } from '@/lib/format'
import { homeOwner, joinPath } from '@/lib/paths'
import { api, errorMessage } from '@/services/api'
import { useToasts } from '@/stores/toast-store'
import { useUsers } from '@/stores/users-store'

interface NewFileFormProps {
  dir: string
  onCreated: () => void
}

const UNOWNED = '__unowned__'

export function NewFileForm({ dir, onCreated }: NewFileFormProps) {
  const users = useUsers((s) => s.users)
  const push = useToasts((s) => s.push)
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [unit, setUnit] = useState<SizeUnit>('KB')
  const [owner, setOwner] = useState(UNOWNED)
  const [busy, setBusy] = useState(false)

  // Default the owner to whoever's home directory this is.
  useEffect(() => {
    const home = homeOwner(dir)
    setOwner(home && users.some((u) => u.id === home) ? home : UNOWNED)
  }, [dir, users])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const bytes = toBytes(amount, unit)
    const relative = name.trim().replace(/^\/+/, '')
    if (!relative || bytes === null) return push('error', 'Enter a name and a size of 0 or more')
    setBusy(true)
    try {
      const path = joinPath(dir, relative)
      const { remaining } = await api.addFile(path, bytes, owner === UNOWNED ? null : owner)
      push('success', remaining === null ? `Created ${path}` : `Created ${path}. ${owner} has ${formatBytes(remaining)} left`)
      setName('')
      setAmount('')
      onCreated()
    } catch (err) {
      push('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card space-y-3 p-4" onSubmit={submit}>
      <h2 className="panel-title">Add a file here</h2>
      <div>
        <label className="label" htmlFor="new-file-name">
          Name or relative path
        </label>
        <input id="new-file-name" className="input font-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="notes/today.md" />
      </div>
      <div>
        <label className="label" htmlFor="new-file-size">
          Size
        </label>
        <SizeInput id="new-file-size" amount={amount} unit={unit} onChange={(a, u) => (setAmount(a), setUnit(u))} />
      </div>
      <div>
        <label className="label" htmlFor="new-file-owner">
          Owner
        </label>
        <select id="new-file-owner" className="input" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value={UNOWNED}>Unowned (no quota)</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.id} ({formatBytes(u.capacity - u.used)} left)
            </option>
          ))}
        </select>
      </div>
      <button className="btn-primary w-full" disabled={busy}>
        <PlusIcon /> Create file
      </button>
    </form>
  )
}
