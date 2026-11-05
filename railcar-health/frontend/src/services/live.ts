/**
 * Server-Sent Events connection. EventSource reconnects by itself; on every
 * (re)connect we bump all topics so pages refetch whatever they missed.
 */
import { useLiveStore, type Topic } from '@/stores/live-store'

const TOPICS: Record<string, Topic[]> = {
  'alert.opened': ['alerts', 'trips', 'yard'],
  'alert.escalated': ['alerts', 'trips', 'yard'],
  'alert.updated': ['alerts', 'yard'],
  'workorder.updated': ['yard', 'alerts'],
  'trip.updated': ['trips'],
  'detector.updated': ['detectors'],
}

let source: EventSource | null = null

export function connectLive(): () => void {
  if (source) return () => undefined
  const store = useLiveStore.getState()
  source = new EventSource('/api/v1/events')
  source.addEventListener('hello', () => {
    store.setConnected(true)
    store.bump(['alerts', 'trips', 'detectors', 'yard'])
  })
  for (const [type, topics] of Object.entries(TOPICS)) {
    source.addEventListener(type, (e) => {
      let alertId: string | undefined
      try {
        alertId = JSON.parse((e as MessageEvent).data).alertId
      } catch {
        alertId = undefined
      }
      useLiveStore.getState().bump(topics, type === 'alert.opened' || type === 'alert.escalated' ? alertId : undefined)
    })
  }
  source.onerror = () => useLiveStore.getState().setConnected(false)
  return () => {
    source?.close()
    source = null
    useLiveStore.getState().setConnected(false)
  }
}
