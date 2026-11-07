import { Link, createFileRoute } from '@tanstack/react-router'
import { AlertIcon } from '@/components/icons'
import { Empty, ErrorNote, Loading } from '@/components/shared/Loading'
import { ago } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import { useNotificationStore } from '@/stores/notification-store'

export const Route = createFileRoute('/notifications')({ component: NotificationsPage })

function NotificationsPage() {
  const { data, error, reload } = usePoll(() => api.notifications(), 3000)
  async function readAll() {
    await api.readAllNotifications()
    reload()
    void useNotificationStore.getState().refresh()
  }
  return (
    <div className="page">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="h1">Notifications</h1>
          <p className="mt-1 text-sm text-slate-500">Sent when an endpoint is disabled automatically: retry window exhausted, 410 Gone, or a blocked address.</p>
        </div>
        <button type="button" className="btn-secondary" disabled={!data || data.unread === 0} onClick={() => void readAll()}>Mark all read</button>
      </div>
      {error && <ErrorNote message={error} />}
      {!data ? (
        <Loading />
      ) : data.notifications.length === 0 ? (
        <div className="card"><Empty>No notifications.</Empty></div>
      ) : (
        <ul className="card divide-y divide-slate-100" aria-label="Notifications">
          {data.notifications.map((n) => (
            <li key={n.id} className={`flex gap-3 px-4 py-3 ${n.readAt ? '' : 'bg-red-50/40'}`}>
              <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">{n.title}</span>
                  <span className="shrink-0 text-xs text-slate-500">{ago(n.createdAt)}{n.readAt ? '' : ' · unread'}</span>
                </div>
                <p className="mt-0.5 text-sm text-slate-600">{n.body}</p>
                {n.endpointId && (
                  <Link to="/endpoints/$endpointId" params={{ endpointId: n.endpointId }} className="mt-1 inline-block text-xs text-accent-700 hover:underline">
                    Open endpoint →
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
