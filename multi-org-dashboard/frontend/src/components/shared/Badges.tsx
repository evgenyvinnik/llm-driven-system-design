import { ROLE_LABEL } from '@/lib/format'
import type { ConversationStatus, ExportStatus, Role } from '@/types'

const STATUS_TONE: Record<string, string> = {
  open: 'bg-sky-50 text-sky-700',
  resolved: 'bg-emerald-50 text-emerald-700',
  escalated: 'bg-amber-50 text-amber-800',
  live: 'bg-emerald-50 text-emerald-700',
  paused: 'bg-slate-100 text-slate-600',
  draft: 'bg-slate-100 text-slate-600',
  queued: 'bg-slate-100 text-slate-600',
  running: 'bg-sky-50 text-sky-700',
  completed: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-red-50 text-red-700',
  cancelled: 'bg-slate-100 text-slate-600',
  pending: 'bg-sky-50 text-sky-700',
  accepted: 'bg-emerald-50 text-emerald-700',
  revoked: 'bg-red-50 text-red-700',
  expired: 'bg-slate-100 text-slate-600',
  active: 'bg-emerald-50 text-emerald-700',
}

export function StatusBadge({ status }: { status: ConversationStatus | ExportStatus | string }) {
  return <span className={`chip ${STATUS_TONE[status] ?? 'bg-slate-100 text-slate-600'}`}>{status}</span>
}

export function RoleBadge({ role }: { role: Role }) {
  const tone = role === 'admin' ? 'bg-brand-50 text-brand-700' : role === 'editor' ? 'bg-sky-50 text-sky-700' : 'bg-slate-100 text-slate-600'
  return <span className={`chip ${tone}`}>{ROLE_LABEL[role]}</span>
}
