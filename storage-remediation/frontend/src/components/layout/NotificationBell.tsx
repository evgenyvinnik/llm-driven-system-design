import { useEffect, useState } from 'react'
import { BellIcon } from '@/components/icons'
import { relativeTime } from '@/lib/format'
import { api } from '@/services/api'
import type { Notification } from '@/types'

const KIND_LABEL: Record<string, string> = {
  action_required: 'Action required',
  escalated: 'Escalated',
  exception_expiring: 'Exception expiring',
  exception_expired: 'Exception expired',
  exception_requested: 'Exception requested',
  exception_approved: 'Exception approved',
  exception_rejected: 'Exception rejected',
  rollback: 'Automatic rollback',
  rollback_failed: 'Rollback failed',
  campaign_paused: 'Campaign paused',
  escalated_target: 'Needs a human',
}

export function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const load = () => api.notifications().then((r) => setItems(r.notifications)).catch(() => undefined)
    void load()
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="relative">
      <button type="button" className="btn-ghost relative px-2" aria-label="Notifications" onClick={() => setOpen((o) => !o)}>
        <BellIcon className="h-5 w-5" />
        {items.length > 0 && <span className="absolute -right-0.5 -top-0.5 rounded-full bg-accent-700 px-1.5 text-[10px] font-semibold text-white">{items.length}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 max-h-[28rem] w-96 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 px-4 py-2 panel-title">Notifications</div>
          {items.length === 0 && <p className="px-4 py-6 text-sm text-slate-500">Nothing new.</p>}
          {items.map((n) => (
            <div key={n.id} className="border-b border-slate-50 px-4 py-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-700">{KIND_LABEL[n.kind] ?? n.kind}</span>
                <span className="text-slate-400">{relativeTime(n.createdAt)}</span>
              </div>
              <p className="mt-0.5 text-sm text-slate-600">{n.message}</p>
              {n.dueAt && <p className="mt-0.5 text-xs text-slate-400">Due {relativeTime(n.dueAt)}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
