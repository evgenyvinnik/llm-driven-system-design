import { useState, type FormEvent } from 'react'
import { SendIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared/Loading'
import { api } from '@/services/api'

const TYPES = ['order.created', 'order.updated', 'order.cancelled', 'invoice.paid', 'invoice.failed', 'customer.updated']

/** Console-side producer: same API and idempotency rules as a real producer. */
export function SendEventForm({ onSent }: { onSent: () => void }) {
  const [type, setType] = useState(TYPES[0])
  const [payload, setPayload] = useState('{\n  "orderId": "1042",\n  "amount": 4200\n}')
  const [orderingKey, setOrderingKey] = useState('')
  const [count, setCount] = useState(1)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastKey, setLastKey] = useState<string | null>(null)

  async function send(e: FormEvent, repeatKey = false) {
    e.preventDefault()
    setError(null)
    setResult(null)
    try {
      const data = JSON.parse(payload) as Record<string, unknown>
      let created = 0
      let replayed = 0
      for (let i = 0; i < (repeatKey ? 1 : count); i++) {
        const key = repeatKey && lastKey ? lastKey : `console-${Date.now()}-${i}`
        const r = await api.emit({ type, data, ...(orderingKey ? { orderingKey } : {}) }, key)
        if (r.replayed) replayed++
        else created++
        setLastKey(key)
      }
      setResult(replayed > 0 ? `Same Idempotency-Key: got the original event back, no new event (${replayed})` : `Emitted ${created} event${created === 1 ? '' : 's'}`)
      onSent()
    } catch (err) {
      setError(err instanceof SyntaxError ? 'Payload is not valid JSON' : err instanceof Error ? err.message : 'Send failed')
    }
  }

  return (
    <form onSubmit={(e) => void send(e)} className="card space-y-3 p-4">
      <h2 className="panel-title">Send a test event</h2>
      <div className="grid grid-cols-3 gap-2">
        <div className="col-span-2">
          <label className="label" htmlFor="ev-type">Type</label>
          <select id="ev-type" className="input font-mono" value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="ev-count">Count</label>
          <input id="ev-count" type="number" min={1} max={50} className="input" value={count} onChange={(e) => setCount(Number(e.target.value))} />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="ev-key">Ordering key (optional)</label>
        <input id="ev-key" className="input font-mono" placeholder="order_1042" value={orderingKey} onChange={(e) => setOrderingKey(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="ev-data">Data</label>
        <textarea id="ev-data" rows={4} className="input font-mono text-xs" value={payload} onChange={(e) => setPayload(e.target.value)} />
      </div>
      {error && <ErrorNote message={error} />}
      {result && <p className="text-xs text-emerald-700">{result}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary"><SendIcon /> Emit</button>
        <button type="button" className="btn-secondary" disabled={!lastKey} onClick={(e) => void send(e, true)} title="Simulates a producer retry after a lost response">
          Retry last (same key)
        </button>
      </div>
    </form>
  )
}
