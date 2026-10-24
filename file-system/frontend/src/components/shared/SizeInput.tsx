import { SIZE_UNITS, type SizeUnit } from '@/lib/size'

interface SizeInputProps {
  id: string
  amount: string
  unit: SizeUnit
  onChange: (amount: string, unit: SizeUnit) => void
}

/** A number plus a binary unit, so "2.5 MB" doesn't have to be typed as 2621440. */
export function SizeInput({ id, amount, unit, onChange }: SizeInputProps) {
  return (
    <div className="flex gap-1.5">
      <input
        id={id}
        className="input min-w-0 flex-1"
        inputMode="decimal"
        value={amount}
        onChange={(e) => onChange(e.target.value, unit)}
        placeholder="0"
      />
      <select className="input w-20" value={unit} onChange={(e) => onChange(amount, e.target.value as SizeUnit)} aria-label="Unit">
        {Object.keys(SIZE_UNITS).map((u) => (
          <option key={u}>{u}</option>
        ))}
      </select>
    </div>
  )
}
