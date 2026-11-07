/**
 * Evaluates a hypothetical unit against the rules being edited, in the
 * browser, with the same evaluate() the SDK and the server use.
 */
import { useState } from 'react'
import { evaluateFlag, type SnapshotFlag, type TargetingRule } from '@exp/core'
import type { Flag } from '@/types'

export function TryUnit({ flag, env, rules, fallthrough }: { flag: Flag; env: string; rules: TargetingRule[]; fallthrough: 'enroll' | 'exclude' }) {
  const cfg = flag.configs[env]
  const [unit, setUnit] = useState('visitor-42')
  const [country, setCountry] = useState('US')
  const [plan, setPlan] = useState('free')
  const [platform, setPlatform] = useState('web')
  const snapshotFlag: SnapshotFlag = { key: flag.key, kind: flag.kind, unitType: flag.unitType, salt: flag.salt, status: 'running', version: cfg.version, variants: flag.variants, defaultVariant: flag.defaultVariant, rules, fallthrough, allocation: cfg.allocation }
  const ids = flag.unitType === 'org' ? { orgId: unit } : flag.unitType === 'anonymous' ? { anonymousId: unit } : { stableId: unit }
  const e = evaluateFlag(snapshotFlag, { ...ids, attributes: { country, plan, platform } })
  const field = (label: string, value: string, set: (v: string) => void) => (
    <label className="flex items-center gap-1.5">
      <span className="text-slate-500">{label}</span>
      <input className="input w-28 py-1 font-mono text-xs" value={value} onChange={(ev) => set(ev.target.value)} />
    </label>
  )
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md bg-slate-50 px-3 py-2 text-xs" data-testid="try-unit">
      <span className="font-semibold text-slate-600">Try a unit (if running):</span>
      {field(flag.unitType === 'org' ? 'org id' : flag.unitType === 'anonymous' ? 'anonymous id' : 'stable id', unit, setUnit)}
      {field('country', country, setCountry)}
      {field('plan', plan, setPlan)}
      {field('platform', platform, setPlatform)}
      <span className="ml-auto">
        → <span className="font-mono font-semibold text-slate-800">{e.variant}</span> <span className="text-slate-500">({e.reason}{e.bucket !== undefined ? `, bucket ${e.bucket}` : ''}{e.inExperiment ? ', logs exposure when rendered' : ''})</span>
      </span>
    </div>
  )
}
