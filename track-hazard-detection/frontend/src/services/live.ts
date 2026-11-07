/**
 * Server-Sent Events connection. EventSource reconnects by itself; on every
 * (re)connect we bump all topics so pages refetch whatever they missed.
 */
import { useLiveStore, type Topic } from '@/stores/live-store'

let source: EventSource | null = null

export function connectLive(): () => void {
  if (source) return () => undefined
  source = new EventSource('/api/v1/live')
  source.addEventListener('hello', () => {
    useLiveStore.getState().setConnected(true)
    useLiveStore.getState().bumpAll()
  })
  source.addEventListener('notice', (e) => {
    try {
      const notice = JSON.parse((e as MessageEvent).data) as { topics: Topic[]; hazardId?: string; severity?: string; type?: string }
      useLiveStore.getState().bump(notice.topics)
      if (notice.hazardId && notice.severity === 'CRITICAL' && (notice.type === 'AlertIssued' || notice.type === 'AlertEscalated')) useLiveStore.getState().flagCritical(notice.hazardId)
    } catch {
      /* ignore malformed notice */
    }
  })
  source.onerror = () => useLiveStore.getState().setConnected(false)
  return () => {
    source?.close()
    source = null
    useLiveStore.getState().setConnected(false)
  }
}
