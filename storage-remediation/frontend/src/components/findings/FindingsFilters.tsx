import { EVIDENCE_LABEL } from '@/lib/format'
import type { Facets } from '@/types'

export interface FindingFilters {
  control?: string
  subscription?: string
  owner?: string
  severity?: string
  evidence?: string
  environment?: string
  status?: string
  q?: string
  page?: number
}

function Select({ label, value, options, onChange }: { label: string; value?: string; options: { value: string; label: string }[]; onChange: (v?: string) => void }) {
  return (
    <label className="block min-w-[9rem]">
      <span className="label">{label}</span>
      <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

export function FindingsFilters({ facets, value, onChange }: { facets: Facets | null; value: FindingFilters; onChange: (next: FindingFilters) => void }) {
  const set = (key: keyof FindingFilters) => (v?: string) => onChange({ ...value, [key]: v, page: 1 })
  return (
    <div className="card flex flex-wrap items-end gap-3 p-3">
      <label className="block min-w-[12rem] flex-1">
        <span className="label">Account name</span>
        <input className="input" placeholder="stpayments…" value={value.q ?? ''} onChange={(e) => set('q')(e.target.value || undefined)} />
      </label>
      <Select label="Control" value={value.control} options={(facets?.controls ?? []).map((c) => ({ value: c.id, label: `${c.id} ${c.title}` }))} onChange={set('control')} />
      <Select label="Severity" value={value.severity} options={['critical', 'high', 'medium', 'low'].map((s) => ({ value: s, label: s }))} onChange={set('severity')} />
      <Select label="Evidence" value={value.evidence} options={Object.entries(EVIDENCE_LABEL).map(([k, v]) => ({ value: k, label: v }))} onChange={set('evidence')} />
      <Select label="Environment" value={value.environment} options={(facets?.environments ?? []).map((e) => ({ value: e, label: e }))} onChange={set('environment')} />
      <Select label="Owner" value={value.owner} options={(facets?.owners ?? []).map((o) => ({ value: o, label: o }))} onChange={set('owner')} />
      <Select label="Subscription" value={value.subscription} options={(facets?.subscriptions ?? []).map((s) => ({ value: s.id, label: s.name }))} onChange={set('subscription')} />
      <Select label="Status" value={value.status ?? 'open'} options={['open', 'exempt', 'resolved', 'all'].map((s) => ({ value: s, label: s }))} onChange={set('status')} />
    </div>
  )
}
