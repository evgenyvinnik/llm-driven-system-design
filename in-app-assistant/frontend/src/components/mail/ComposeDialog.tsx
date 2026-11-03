import { useState } from 'react'
import { XIcon } from '@/components/icons'
import { api } from '@/services/api'
import { useWorkspaceStore } from '@/stores/workspace-store'

/** Plain compose-and-send, mostly for trying freshness: a message sent seconds ago is searchable before the indexer gets to it. */
export function ComposeDialog({ onClose }: { onClose: () => void }) {
  const [to, setTo] = useState('alice@lumenlabs.example')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const bump = useWorkspaceStore((s) => s.bump)
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/30 p-4">
      <form
        className="card w-full max-w-lg space-y-3 p-4 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault()
          api
            .send({ to: to.split(',').map((s) => s.trim()).filter(Boolean), subject, body })
            .then(() => {
              bump()
              onClose()
            })
            .catch((err) => setError(err.message))
        }}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">New message</h2>
          <button type="button" className="btn-ghost px-1.5" onClick={onClose} aria-label="Close"><XIcon /></button>
        </div>
        <input className="input" placeholder="To" value={to} onChange={(e) => setTo(e.target.value)} />
        <input className="input" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <textarea className="input min-h-[140px]" placeholder="Message" value={body} onChange={(e) => setBody(e.target.value)} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end"><button type="submit" className="btn-primary" disabled={!subject || !body}>Send</button></div>
      </form>
    </div>
  )
}
