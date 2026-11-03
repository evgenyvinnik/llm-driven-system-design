import { useState } from 'react'
import { UsersIcon, XIcon } from '@/components/icons'
import { api } from '@/services/api'
import type { DocumentDetail } from '@/types'

const PEOPLE = [
  { principal: 'user:u_bob', label: 'Bob Ortiz' },
  { principal: 'user:u_dana', label: 'Dana Whitfield' },
  { principal: 'user:u_raj', label: 'Raj Patel' },
  { principal: 'user:u_alice', label: 'Alice Chen' },
  { principal: 'group:g_eng', label: 'Engineering' },
  { principal: 'group:g_leads', label: 'Leads' },
  { principal: 'org:o_lumen', label: 'Everyone at Lumen' },
]

/**
 * Sharing changes go to the index on the fast lane: the chunk ACLs update
 * within a second, and every search re-checks access against these rows
 * anyway, so a revoked share is never served from a stale index.
 */
export function SharePanel({ doc, onChange }: { doc: DocumentDetail; onChange: (doc: DocumentDetail) => void }) {
  const [principal, setPrincipal] = useState(PEOPLE[0].principal)
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer')
  const label = (p: string) => PEOPLE.find((x) => x.principal === p)?.label ?? p
  return (
    <div className="card space-y-2 p-3">
      <div className="panel-title flex items-center gap-1.5"><UsersIcon className="h-3.5 w-3.5" /> Shared with</div>
      {doc.shares.length === 0 && <p className="text-xs text-slate-400">Only you</p>}
      {doc.shares.map((s) => (
        <div key={s.principal} className="flex items-center justify-between text-sm">
          <span className="text-slate-700">{label(s.principal)} <span className="text-xs text-slate-400">{s.role}</span></span>
          <button type="button" className="btn-ghost px-1 py-0.5" title="Remove" onClick={() => api.share(doc.id, s.principal, null).then((r) => onChange(r.document))}><XIcon className="h-3.5 w-3.5" /></button>
        </div>
      ))}
      <div className="flex gap-1.5 pt-1">
        <select className="input py-1 text-xs" value={principal} onChange={(e) => setPrincipal(e.target.value)} aria-label="Person or group">
          {PEOPLE.map((p) => <option key={p.principal} value={p.principal}>{p.label}</option>)}
        </select>
        <select className="input w-24 py-1 text-xs" value={role} onChange={(e) => setRole(e.target.value as 'viewer' | 'editor')} aria-label="Role">
          <option value="viewer">viewer</option>
          <option value="editor">editor</option>
        </select>
        <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => api.share(doc.id, principal, role).then((r) => onChange(r.document))}>Share</button>
      </div>
    </div>
  )
}
