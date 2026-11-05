import { useEffect, useState } from 'react'
import { api } from '@/services/api'
import { followCampaign, type StreamMode } from '@/services/campaign-stream'
import type { CampaignEvent, CampaignSnapshot } from '@/types'

/** Snapshot + rolling event feed for one campaign, kept live over SSE (polling fallback). */
export function useCampaignLive(id: string) {
  const [snapshot, setSnapshot] = useState<CampaignSnapshot | null>(null)
  const [events, setEvents] = useState<CampaignEvent[]>([])
  const [mode, setMode] = useState<StreamMode>('connecting')
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let live = true
    api.campaign(id).then(
      (s) => {
        if (!live) return
        setSnapshot(s)
        setEvents(s.events ?? [])
      },
      setError,
    )
    const stop = followCampaign(id, {
      onSnapshot: (s) => live && setSnapshot(s),
      // Events carry stream IDs; dedupe so a reconnect replay never shows a row twice.
      onEvent: (e) => live && setEvents((prev) => (e.id && prev.some((p) => p.id === e.id) ? prev : [e, ...prev].slice(0, 200))),
      onMode: (m) => live && setMode(m),
    })
    return () => {
      live = false
      stop()
    }
  }, [id])

  return { snapshot, events, mode, error, setSnapshot }
}
