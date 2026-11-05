/**
 * Live campaign progress. Server-Sent Events first: the API pushes a snapshot
 * (counts, waves, recent targets) at most once a second plus every progress
 * event. EventSource reconnects on its own and resends Last-Event-ID, so a
 * dropped connection resumes from the last event it saw. If the stream keeps
 * failing (a proxy that buffers SSE, say) we fall back to polling the same
 * snapshot every 3 seconds.
 */
import type { CampaignEvent, CampaignSnapshot } from '@/types'
import { api } from './api'

export type StreamMode = 'connecting' | 'live' | 'polling' | 'closed'

export interface StreamHandlers {
  onSnapshot: (s: CampaignSnapshot) => void
  onEvent: (e: CampaignEvent) => void
  onMode: (m: StreamMode) => void
}

export function followCampaign(id: string, h: StreamHandlers): () => void {
  let source: EventSource | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let failures = 0
  let closed = false

  const startPolling = () => {
    if (pollTimer || closed) return
    h.onMode('polling')
    const tick = () => api.campaign(id).then(h.onSnapshot).catch(() => undefined)
    void tick()
    pollTimer = setInterval(tick, 3000)
  }

  const connect = () => {
    h.onMode('connecting')
    source = new EventSource(`/api/v1/campaigns/${id}/events`)
    source.addEventListener('snapshot', (e) => {
      failures = 0
      h.onMode('live')
      h.onSnapshot(JSON.parse((e as MessageEvent).data))
    })
    source.addEventListener('progress', (e) => {
      const msg = e as MessageEvent
      h.onEvent({ ...JSON.parse(msg.data), id: msg.lastEventId })
    })
    source.onerror = () => {
      failures++
      if (failures >= 3) {
        source?.close()
        startPolling()
      } else {
        h.onMode('connecting')
      }
    }
  }

  connect()
  return () => {
    closed = true
    source?.close()
    if (pollTimer) clearInterval(pollTimer)
    h.onMode('closed')
  }
}
