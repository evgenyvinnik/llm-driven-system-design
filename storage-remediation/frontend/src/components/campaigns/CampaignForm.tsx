import { useEffect, useMemo, useState } from 'react'
import { ErrorNote } from '@/components/shared'
import { EVIDENCE_LABEL, newIdempotencyKey, num } from '@/lib/format'
import { api } from '@/services/api'
import type { CampaignConfig, ControlPolicy, EvidenceClass, PlanSummary } from '@/types'

const ENVIRONMENTS = ['sandbox', 'dev', 'test', 'prod']

export function CampaignForm({ controls, onCreated }: { controls: ControlPolicy[]; onCreated: (id: string) => void }) {
  const [config, setConfig] = useState<CampaignConfig>({ name: 'Disable shared key (non-prod)', controlId: 'SA-02', scope: { environments: ['sandbox', 'dev', 'test'] }, canaryPercent: 5, growthFactor: 4, maxWaveSize: 400, includeClasses: ['safe_to_fix'], bakeSeconds: 20, maxFailuresPerWave: 1 })
  const [plan, setPlan] = useState<PlanSummary | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  // One key per intended campaign: double-clicks and retries return the same campaign.
  const idempotencyKey = useMemo(() => newIdempotencyKey('campaign'), [])
  const set = <K extends keyof CampaignConfig>(k: K, v: CampaignConfig[K]) => setConfig((c) => ({ ...c, [k]: v }))
  const toggle = <T,>(list: T[] | undefined, v: T) => (list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v])

  useEffect(() => {
    const timer = setTimeout(() => api.previewCampaign(config).then((r) => { setPlan(r.plan); setError(null) }, setError), 300)
    return () => clearTimeout(timer)
  }, [config])

  async function create() {
    setBusy(true)
    try {
      const r = await api.createCampaign(config, idempotencyKey)
      onCreated(r.campaignId)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const numberField = (k: 'canaryPercent' | 'growthFactor' | 'maxWaveSize' | 'bakeSeconds' | 'maxFailuresPerWave', label: string) => (
    <label className="block">
      <span className="label">{label}</span>
      <input className="input" type="number" value={config[k]} onChange={(e) => set(k, Number(e.target.value))} />
    </label>
  )

  return (
    <div className="card grid gap-4 p-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-800">New campaign</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block"><span className="label">Name</span><input className="input" value={config.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label className="block">
            <span className="label">Control</span>
            <select className="input" value={config.controlId} onChange={(e) => set('controlId', e.target.value)}>
              {controls.map((c) => <option key={c.id} value={c.id}>{c.id} {c.title}</option>)}
            </select>
          </label>
        </div>
        <fieldset>
          <legend className="label">Environments</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {ENVIRONMENTS.map((e) => (
              <label key={e} className="inline-flex items-center gap-1.5"><input type="checkbox" checked={config.scope.environments?.includes(e) ?? false} onChange={() => set('scope', { ...config.scope, environments: toggle(config.scope.environments, e) })} /> {e}</label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="label">Include evidence classes</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {(Object.keys(EVIDENCE_LABEL) as EvidenceClass[]).map((k) => (
              <label key={k} className="inline-flex items-center gap-1.5"><input type="checkbox" checked={config.includeClasses.includes(k)} onChange={() => set('includeClasses', toggle(config.includeClasses, k))} /> {EVIDENCE_LABEL[k]}</label>
            ))}
          </div>
          {config.includeClasses.some((k) => k !== 'safe_to_fix') && <p className="mt-1 text-xs text-orange-800">Including accounts with known or unknown callers will break them on purpose. Prefer the owner workflow.</p>}
        </fieldset>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {numberField('canaryPercent', 'Canary %')}
          {numberField('growthFactor', 'Growth ×')}
          {numberField('maxWaveSize', 'Max wave')}
          {numberField('bakeSeconds', 'Bake (s)')}
          {numberField('maxFailuresPerWave', 'Failures/wave')}
        </div>
        <ErrorNote error={error} />
        <button type="button" className="btn-primary" disabled={busy || !plan || plan.eligible === 0} onClick={() => void create()}>{busy ? 'Creating…' : 'Create campaign (draft)'}</button>
      </div>
      <div className="rounded-md bg-slate-50 p-3 text-sm">
        <h3 className="panel-title">Plan preview</h3>
        {!plan && <p className="mt-2 text-slate-500">Calculating…</p>}
        {plan && (
          <>
            <p className="mt-1 text-slate-700"><span className="font-semibold">{num(plan.eligible)}</span> accounts in {plan.waves.length} waves</p>
            <ol className="mt-2 space-y-1">
              {plan.waves.map((w) => (
                <li key={w.waveNo} className="flex justify-between text-xs"><span>W{w.waveNo} · {w.label}</span><span className="font-mono">{num(w.size)}</span></li>
              ))}
            </ol>
            {Object.keys(plan.excluded).length > 0 && (
              <div className="mt-3 border-t border-slate-200 pt-2 text-xs text-slate-600">
                <div className="font-semibold">Excluded</div>
                {Object.entries(plan.excluded).map(([reason, n]) => (
                  <div key={reason} className="flex justify-between"><span>{EVIDENCE_LABEL[reason] ?? reason.replaceAll('_', ' ')}</span><span className="font-mono">{num(n)}</span></div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
