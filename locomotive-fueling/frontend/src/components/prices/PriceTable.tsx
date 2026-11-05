import { useState } from 'react'
import { Chip } from '@/components/shared/Chips'
import { api } from '@/services/api'
import type { FuelOption } from '@/types'

function PriceCell({ option, editable, onSaved }: { option: FuelOption; editable: boolean; onSaved: (msg: string) => void }) {
  const [value, setValue] = useState(option.pricePerGal.toFixed(2))
  const dirty = Number(value) !== option.pricePerGal
  if (!editable) return <span className="num">${option.pricePerGal.toFixed(2)}</span>
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        void api.updateOption(option.id, { pricePerGal: Number(value), note: 'Admin price edit' }).then((r) => onSaved(`${option.id}: re-planning ${r.affectedTrains.length} train(s)`))
      }}
    >
      <span className="text-slate-400">$</span>
      <input aria-label={`Price ${option.id}`} className="input w-20 py-1 text-right" value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" />
      {dirty && (
        <button type="submit" className="btn-primary px-2 py-1 text-xs">
          Save
        </button>
      )}
    </form>
  )
}

export function PriceTable({ options, editable, onChanged }: { options: FuelOption[]; editable: boolean; onChanged: () => void }) {
  const [message, setMessage] = useState<string | null>(null)
  const saved = (msg: string) => {
    setMessage(msg)
    onChanged()
  }
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="panel-title">Fuel options (illustrative prices)</div>
        {message && <span className="text-xs text-accent-700">{message}</span>}
      </div>
      <table className="w-full" aria-label="Fuel options">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Location</th>
            <th className="th">Kind</th>
            <th className="th">Price / gal</th>
            <th className="th">Fees</th>
            <th className="th">Capacity</th>
            <th className="th">Status</th>
          </tr>
        </thead>
        <tbody>
          {options.map((o) => (
            <tr key={o.id} className="border-t border-slate-100">
              <td className="td">
                <div className="font-medium text-slate-900">{o.locationName}, {o.state}</div>
                <div className="text-[11px] text-slate-500">{o.vendor}</div>
              </td>
              <td className="td">{o.kind === 'pad' ? 'Fuel pad' : `DTL truck (${o.leadTimeHours} h notice)`}</td>
              <td className="td"><PriceCell option={o} editable={editable} onSaved={saved} /></td>
              <td className="td num text-xs text-slate-600">{o.fee ? `$${o.fee} call-out · $${o.cancelFee} cancel` : '—'}</td>
              <td className="td num text-xs text-slate-600">{o.bays} {o.kind === 'pad' ? 'bay' : 'truck'}{o.bays > 1 ? 's' : ''} · {o.pumpGpm} gpm</td>
              <td className="td">
                <div className="flex items-center gap-2">
                  <Chip kind={o.active ? 'good' : 'bad'}>{o.active ? 'Open' : 'Closed'}</Chip>
                  {editable && (
                    <button type="button" className="btn-ghost px-1.5 py-0.5 text-xs" onClick={() => void api.updateOption(o.id, { active: !o.active }).then((r) => saved(`${o.id} ${o.active ? 'closed' : 'reopened'}: re-planning ${r.affectedTrains.length} train(s)`))}>
                      {o.active ? 'Close' : 'Reopen'}
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
