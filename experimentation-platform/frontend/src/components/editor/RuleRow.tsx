import type { Condition, TargetingRule } from '@exp/core'
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon, XIcon } from '@/components/icons'

const ATTRIBUTES = ['country', 'plan', 'platform', 'id', 'userId', 'anonymousId', 'orgId']

interface Props {
  rule: TargetingRule
  index: number
  count: number
  variants: string[]
  disabled: boolean
  onChange: (rule: TargetingRule) => void
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
}

export function RuleRow({ rule, index, count, variants, disabled, onChange, onMove, onRemove }: Props) {
  const setCondition = (i: number, c: Partial<Condition>) => onChange({ ...rule, conditions: rule.conditions.map((x, j) => (j === i ? { ...x, ...c } : x)) })
  const actionValue = rule.action.type === 'force' ? `force:${rule.action.variant}` : rule.action.type
  return (
    <li className="rounded-md border border-slate-200 bg-white p-3" data-rule={rule.id}>
      <div className="mb-2 flex items-center gap-2">
        <span className="num w-6 text-xs font-semibold text-slate-400">#{index + 1}</span>
        <input className="input" value={rule.description} placeholder="What this rule is for" disabled={disabled} onChange={(e) => onChange({ ...rule, description: e.target.value })} />
        <select
          className="input w-56"
          aria-label="Action"
          value={actionValue}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value
            onChange({ ...rule, action: v.startsWith('force:') ? { type: 'force', variant: v.slice(6) } : { type: v as 'enroll' | 'exclude' } })
          }}
        >
          <option value="enroll">then enroll (use allocation)</option>
          <option value="exclude">then exclude (default, not enrolled)</option>
          {variants.map((v) => (
            <option key={v} value={`force:${v}`}>
              then force “{v}” (not analyzed)
            </option>
          ))}
        </select>
        <button type="button" className="btn-ghost px-1.5" disabled={disabled || index === 0} onClick={() => onMove(-1)} title="Move up">
          <ArrowUpIcon />
        </button>
        <button type="button" className="btn-ghost px-1.5" disabled={disabled || index === count - 1} onClick={() => onMove(1)} title="Move down">
          <ArrowDownIcon />
        </button>
        <button type="button" className="btn-ghost px-1.5" disabled={disabled} onClick={onRemove} title="Delete rule">
          <TrashIcon />
        </button>
      </div>
      <ul className="space-y-1.5 pl-8">
        {rule.conditions.map((c, i) => (
          <li key={i} className="flex items-center gap-2 text-sm">
            <span className="w-8 text-xs text-slate-400">{i === 0 ? 'if' : 'and'}</span>
            <select className="input w-36" aria-label="Attribute" value={c.attribute} disabled={disabled} onChange={(e) => setCondition(i, { attribute: e.target.value })}>
              {[...new Set([...ATTRIBUTES, c.attribute])].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
            <select className="input w-28" aria-label="Operator" value={c.operator} disabled={disabled} onChange={(e) => setCondition(i, { operator: e.target.value as Condition['operator'] })}>
              <option value="in">is one of</option>
              <option value="not_in">is not one of</option>
            </select>
            <input
              className="input font-mono"
              aria-label="Values"
              value={c.values.join(', ')}
              disabled={disabled}
              onChange={(e) => setCondition(i, { values: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            />
            <button type="button" className="btn-ghost px-1.5" disabled={disabled} onClick={() => onChange({ ...rule, conditions: rule.conditions.filter((_, j) => j !== i) })} title="Remove condition">
              <XIcon />
            </button>
          </li>
        ))}
        <li>
          <button type="button" className="btn-ghost text-xs" disabled={disabled} onClick={() => onChange({ ...rule, conditions: [...rule.conditions, { attribute: 'country', operator: 'in', values: ['US'] }] })}>
            <PlusIcon className="h-3.5 w-3.5" /> condition
          </button>
          {rule.conditions.length === 0 && <span className="text-xs text-slate-400">no conditions: matches everyone</span>}
        </li>
      </ul>
    </li>
  )
}
