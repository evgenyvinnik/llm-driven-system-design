import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { SendIcon } from '@/components/icons'
import type { QuoteForm as Form } from '@/services/api'
import type { Reference } from '@/types'

interface Props {
  reference: Reference
  busy: boolean
  onSubmit: (form: Form, idempotencyKey: string) => void
  /** Bumped by the parent after a definitive answer, so the next submission gets a new key. */
  submissionCount: number
}

const newKey = () => `portal-${crypto.randomUUID()}`

/**
 * The idempotency key belongs to one submission. A retry of the same form
 * (after a network error) reuses it, so the server returns the quote it
 * already made instead of making a second one. Changing any field starts a new key.
 */
export function QuoteForm({ reference, busy, onSubmit, submissionCount }: Props) {
  const [laneIdx, setLaneIdx] = useState(0)
  const [commodity, setCommodity] = useState('GRAIN')
  const [equipment, setEquipment] = useState('COVERED_HOPPER')
  const [quantity, setQuantity] = useState(10)
  const [shipWeek, setShipWeek] = useState(reference.shipWeeks[1] ?? reference.shipWeeks[0])
  const [callback, setCallback] = useState(true)
  const [key, setKey] = useState(newKey)
  const lane = reference.lanes[laneIdx]
  const options = useMemo(() => reference.commodities.find((c) => c.code === commodity)?.equipment ?? [], [reference, commodity])

  useEffect(() => {
    if (!options.includes(equipment)) setEquipment(options[0])
  }, [options, equipment])
  useEffect(() => setKey(newKey()), [laneIdx, commodity, equipment, quantity, shipWeek, callback, submissionCount])

  const station = (code: string) => (reference.stations.find((s) => s.code === code)?.name ?? code).split(',')[0]
  function submit(e: FormEvent) {
    e.preventDefault()
    onSubmit({ origin: lane.origin, destination: lane.destination, commodity, equipment, quantity, shipWeek, callback }, key)
  }

  return (
    <form onSubmit={submit} className="card space-y-3 p-4" aria-label="Request a quote">
      <div className="panel-title">Request a quote</div>
      <div>
        <label className="label" htmlFor="lane">Lane</label>
        <select id="lane" className="input" value={laneIdx} onChange={(e) => setLaneIdx(Number(e.target.value))}>
          {reference.lanes.map((l, i) => (
            <option key={`${l.origin}-${l.destination}`} value={i}>
              {station(l.origin)} → {station(l.destination)} · {l.miles.toLocaleString()} mi
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="commodity">Commodity</label>
          <select id="commodity" className="input" value={commodity} onChange={(e) => setCommodity(e.target.value)}>
            {reference.commodities.map((c) => (
              <option key={c.code} value={c.code}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="equipment">Equipment</label>
          <select id="equipment" className="input" value={equipment} onChange={(e) => setEquipment(e.target.value)}>
            {options.map((code) => (
              <option key={code} value={code}>{reference.equipment.find((x) => x.code === code)?.name ?? code}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="quantity">Cars</label>
          <input id="quantity" type="number" min={1} max={200} className="input" value={quantity} onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))} />
        </div>
        <div>
          <label className="label" htmlFor="shipWeek">Ship week of</label>
          <select id="shipWeek" className="input" value={shipWeek} onChange={(e) => setShipWeek(e.target.value)}>
            {reference.shipWeeks.map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </div>
      </div>
      <label className="flex items-start gap-2 text-sm text-slate-600">
        <input type="checkbox" className="mt-0.5" checked={callback} onChange={(e) => setCallback(e.target.checked)} />
        Also notify our registered webhook when a firm quote is ready
      </label>
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        <SendIcon /> {busy ? 'Quoting…' : 'Get quote'}
      </button>
      <p className="font-mono text-[11px] text-slate-400" title="Reused if you retry this exact request">Idempotency-Key {key.slice(0, 20)}…</p>
    </form>
  )
}
