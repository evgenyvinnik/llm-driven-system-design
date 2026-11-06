import { useState } from 'react'
import { api } from '@/services/api'

const LANES = [
  { label: 'KCK → CHI grain (hopper)', body: { origin: 'KCK', destination: 'CHI', commodity: 'GRAIN', equipment: 'COVERED_HOPPER' } },
  { label: 'HOU → CHI plastics (hopper)', body: { origin: 'HOU', destination: 'CHI', commodity: 'PLASTIC', equipment: 'COVERED_HOPPER' } },
  { label: 'PDX → LAX lumber (centerbeam)', body: { origin: 'PDX', destination: 'LAX', commodity: 'LUMBER', equipment: 'CENTERBEAM' } },
]

/** Plays the pricing system: publications become TariffPublished / FuelSurchargeChanged events. */
export function PricingActions({ canPublish, onDone }: { canPublish: boolean; onDone: () => void }) {
  const [lane, setLane] = useState(0)
  const [fuel, setFuel] = useState(45)
  const [message, setMessage] = useState<string | null>(null)
  const run = async (fn: () => Promise<{ event: { type: string; payload: Record<string, unknown> } }>) => {
    try {
      const { event } = await fn()
      setMessage(`${event.type} emitted${event.payload.version ? ` (v${String(event.payload.version)})` : ''}. Caches invalidate and open indicative quotes re-price.`)
      onDone()
    } catch (err) {
      setMessage((err as Error).message)
    }
  }
  return (
    <section className="card p-4" aria-label="Pricing publications">
      <div className="panel-title mb-1">Pricing system</div>
      <p className="mb-3 text-xs text-slate-500">{canPublish ? 'Publish inputs the way the pricing system would.' : 'Only a pricing admin can publish.'}</p>
      <div className="flex gap-2">
        <select className="input" value={lane} onChange={(e) => setLane(Number(e.target.value))} aria-label="Tariff lane">
          {LANES.map((l, i) => (
            <option key={l.label} value={i}>{l.label}</option>
          ))}
        </select>
        <button type="button" className="btn-secondary shrink-0" disabled={!canPublish} onClick={() => void run(() => api.publishTariff(LANES[lane].body) as never)}>
          Publish tariff
        </button>
      </div>
      <div className="mt-2 flex gap-2">
        <input type="number" className="input" min={1} max={500} value={fuel} onChange={(e) => setFuel(Number(e.target.value))} aria-label="Fuel surcharge cents per car-mile" />
        <button type="button" className="btn-secondary shrink-0" disabled={!canPublish} onClick={() => void run(() => api.publishFuel(fuel) as never)}>
          Set fuel ¢/mi
        </button>
      </div>
      {message && <p className="mt-2 text-xs text-slate-600">{message}</p>}
    </section>
  )
}
