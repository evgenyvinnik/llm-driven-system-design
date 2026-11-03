import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { SearchIcon } from '@/components/icons'
import { useOrg } from '@/hooks/useOrg'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'
import type { ConversationFilters } from '@/types'
import { CHANNELS, STATUSES } from './search'

export function Filters({ filters, onChange }: { filters: ConversationFilters; onChange: (next: ConversationFilters) => void }) {
  const { orgId } = useOrg()
  const agents = useQuery({ queryKey: keys.agents(orgId), queryFn: ({ signal }) => api.agents(orgId, signal) })
  const [q, setQ] = useState(filters.q ?? '')
  // Debounced search: one request per pause, not per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((filters.q ?? '') !== q.trim()) onChange({ ...filters, q: q.trim() || undefined })
    }, 300)
    return () => clearTimeout(t)
  }, [q, filters, onChange])

  const set = (key: keyof ConversationFilters, value: string) => onChange({ ...filters, [key]: value || undefined })

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" role="search">
      <label className="relative">
        <SearchIcon className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-slate-400" />
        <input className="input w-56 pl-7" placeholder="Subject or customer" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations" />
      </label>
      <select className="input w-36" value={filters.status ?? ''} onChange={(e) => set('status', e.target.value)} aria-label="Status">
        <option value="">Any status</option>
        {STATUSES.map((s) => <option key={s}>{s}</option>)}
      </select>
      <select className="input w-32" value={filters.channel ?? ''} onChange={(e) => set('channel', e.target.value)} aria-label="Channel">
        <option value="">Any channel</option>
        {CHANNELS.map((c) => <option key={c}>{c}</option>)}
      </select>
      <select className="input w-44" value={filters.agentId ?? ''} onChange={(e) => set('agentId', e.target.value)} aria-label="Agent">
        <option value="">Any agent</option>
        {agents.data?.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <input type="date" className="input w-40" value={filters.from ?? ''} onChange={(e) => set('from', e.target.value)} aria-label="From date" />
      <input type="date" className="input w-40" value={filters.to ?? ''} onChange={(e) => set('to', e.target.value)} aria-label="To date" />
      {Object.keys(filters).length > 0 && (
        <button className="btn-ghost" onClick={() => { setQ(''); onChange({}) }}>Clear</button>
      )}
    </div>
  )
}
