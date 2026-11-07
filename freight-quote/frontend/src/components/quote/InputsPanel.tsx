import type { Quote } from '@/types'

/** The exact inputs the current revision was priced from: what booking honors and a dispute reconstructs. */
export function InputsPanel({ quote }: { quote: Quote }) {
  const i = quote.inputs
  const rows: [string, string][] = [
    ['Pricing basis', i.pricingBasis === 'contract' ? `contract ${i.contractId} v${i.contractVersion}` : `public tariff ${i.tariffId} v${i.tariffVersion}`],
    ['Fuel surcharge', i.fuelSurchargeDate ? `week of ${i.fuelSurchargeDate} at ${i.fuelCentsPerMile}¢/car-mile` : 'not confirmed'],
    ['Capacity snapshot', i.capacitySnapshotId ?? 'not confirmed'],
    ['Car supply snapshot', i.availabilitySnapshotId ?? 'not confirmed'],
    ['Lane miles', String(i.laneMiles)],
    ['Pricing rules', i.rulesVersion],
    ['Correlation id', quote.correlationId],
  ]
  return (
    <section className="card p-4" aria-label="Inputs used">
      <div className="panel-title mb-2">Inputs this price is pinned to</div>
      <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-500">{k}</dt>
            <dd className="font-mono text-xs leading-5 text-slate-800">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-slate-500">
        {quote.kind === 'firm'
          ? 'A firm quote is a commitment: booking honors these versions until it expires, even if a newer tariff is published.'
          : 'An indicative quote is re-priced when a tariff or surcharge it uses changes, and is not bookable.'}
      </p>
    </section>
  )
}
