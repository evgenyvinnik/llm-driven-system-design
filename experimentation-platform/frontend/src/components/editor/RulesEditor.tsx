/**
 * Ordered targeting rules: the first rule whose conditions all match decides
 * (force a variant, exclude, or enroll into the allocation); units matching
 * no rule follow the fallthrough.
 */
import { useEffect, useMemo, useState } from 'react'
import type { TargetingRule } from '@exp/core'
import { PlusIcon } from '@/components/icons'
import { api, ApiError } from '@/services/api'
import type { Flag } from '@/types'
import { RuleRow } from './RuleRow'
import { TryUnit } from './TryUnit'

const newRule = (): TargetingRule => ({ id: `r-${Math.random().toString(36).slice(2, 8)}`, description: '', conditions: [{ attribute: 'country', operator: 'in', values: ['US'] }], action: { type: 'enroll' } })

export function RulesEditor({ flag, env, canEdit, onSaved }: { flag: Flag; env: string; canEdit: boolean; onSaved: () => void }) {
  const cfg = flag.configs[env]
  const initial = useMemo(() => ({ rules: structuredClone(cfg.rules), fallthrough: cfg.fallthrough }), [cfg.version, env]) // eslint-disable-line react-hooks/exhaustive-deps
  const [rules, setRules] = useState<TargetingRule[]>(initial.rules)
  const [fallthrough, setFallthrough] = useState(initial.fallthrough)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  useEffect(() => {
    setRules(initial.rules)
    setFallthrough(initial.fallthrough)
  }, [initial])

  const dirty = JSON.stringify(rules) !== JSON.stringify(cfg.rules) || fallthrough !== cfg.fallthrough
  const disabled = !canEdit || cfg.status === 'stopped'
  const move = (i: number, d: -1 | 1) =>
    setRules((rs) => {
      const next = [...rs]
      ;[next[i], next[i + d]] = [next[i + d], next[i]]
      return next
    })

  async function save() {
    setMessage(null)
    try {
      const res = await api.updateConfig(flag.key, env, cfg.version, { rules, fallthrough })
      setMessage({ tone: 'ok', text: `Saved as v${res.flag.configs[env].version}; snapshot v${res.snapshotVersion} pushed.` })
      onSaved()
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Save failed' })
    }
  }

  return (
    <section className="card space-y-3 p-4" aria-label="Targeting">
      <div className="flex items-baseline justify-between">
        <h2 className="panel-title">Targeting rules</h2>
        <span className="text-xs text-slate-500">First match wins. Forced units see the variant but are never logged as exposed.</span>
      </div>
      <ol className="space-y-2">
        {rules.map((r, i) => (
          <RuleRow
            key={r.id}
            rule={r}
            index={i}
            count={rules.length}
            variants={flag.variants.map((v) => v.key)}
            disabled={disabled}
            onChange={(next) => setRules((rs) => rs.map((x, j) => (j === i ? next : x)))}
            onMove={(d) => move(i, d)}
            onRemove={() => setRules((rs) => rs.filter((_, j) => j !== i))}
          />
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-secondary text-xs" disabled={disabled} onClick={() => setRules((rs) => [...rs, newRule()])}>
          <PlusIcon className="h-3.5 w-3.5" /> Add rule
        </button>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          Everyone else:
          <select className="input w-72" aria-label="Fallthrough" value={fallthrough} disabled={disabled} onChange={(e) => setFallthrough(e.target.value as 'enroll' | 'exclude')}>
            <option value="enroll">enroll (bucketed by the allocation)</option>
            <option value="exclude">exclude (default variant, not enrolled)</option>
          </select>
        </label>
        <div className="flex-1" />
        {message && <span className={`text-xs ${message.tone === 'ok' ? 'text-emerald-700' : 'font-medium text-rose-700'}`}>{message.text}</span>}
        {dirty && (
          <button type="button" className="btn-ghost" onClick={() => (setRules(initial.rules), setFallthrough(initial.fallthrough))}>
            Reset
          </button>
        )}
        <button type="button" className="btn-primary" disabled={disabled || !dirty} onClick={() => void save()}>
          Save targeting
        </button>
      </div>
      <TryUnit flag={flag} env={env} rules={rules} fallthrough={fallthrough} />
    </section>
  )
}
