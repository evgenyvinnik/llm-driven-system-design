import { useState, type FormEvent } from 'react'
import { PlusIcon } from '@/components/icons'
import { SizeInput } from '@/components/shared'
import { toBytes, type SizeUnit } from '@/lib/size'
import { formatBytes } from '@/lib/format'
import { api, errorMessage } from '@/services/api'
import { useToasts } from '@/stores/toast-store'

export function AddUserForm({ onCreated }: { onCreated: () => void }) {
  const push = useToasts((s) => s.push)
  const [id, setId] = useState('')
  const [amount, setAmount] = useState('16')
  const [unit, setUnit] = useState<SizeUnit>('MB')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const capacity = toBytes(amount, unit)
    if (!id.trim() || capacity === null) return push('error', 'Enter a user id and a capacity')
    setBusy(true)
    try {
      await api.addUser(id.trim(), capacity)
      push('success', `Added ${id.trim()} with ${formatBytes(capacity)}`)
      setId('')
      onCreated()
    } catch (err) {
      push('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card space-y-3 p-4" onSubmit={submit}>
      <h2 className="panel-title">Add a user</h2>
      <div>
        <label className="label" htmlFor="user-id">
          User id
        </label>
        <input id="user-id" className="input font-mono" value={id} onChange={(e) => setId(e.target.value)} placeholder="erin" />
      </div>
      <div>
        <label className="label" htmlFor="user-capacity">
          Capacity
        </label>
        <SizeInput id="user-capacity" amount={amount} unit={unit} onChange={(a, u) => (setAmount(a), setUnit(u))} />
      </div>
      <button className="btn-primary w-full" disabled={busy}>
        <PlusIcon /> Add user
      </button>
    </form>
  )
}
