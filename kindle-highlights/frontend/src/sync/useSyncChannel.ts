/**
 * Keeps one WebSocket to the sync service while the reader is logged in.
 *
 * The socket carries hints only: {type:'changed', seq} means another device wrote and the
 * reader's feed is now at `seq`. Pages watch `remoteSeq` in the store and refetch over HTTP, so
 * a dropped socket or a lost message delays an update but never loses it. Every (re)connect
 * also flushes the outbox, which is how edits made offline reach the server.
 *
 * @module sync/useSyncChannel
 */
import { useEffect } from 'react'
import { getDeviceId, getSessionId } from '@/api/client'
import { useStore } from '@/stores/useStore'
import { flushOutbox, pendingCount } from './outbox'

const MAX_BACKOFF_MS = 30_000
/** Close code the server uses for a missing or invalid session; reconnecting won't help. */
const UNAUTHORIZED = 4001

/** Opens and maintains the sync socket for the logged-in reader. Mount once, in the root layout. */
export function useSyncChannel(): void {
  const isAuthenticated = useStore((state) => state.isAuthenticated)

  useEffect(() => {
    const { setSyncStatus, noteRemoteSeq, setPendingOps } = useStore.getState()
    setPendingOps(pendingCount())
    if (!isAuthenticated) {
      setSyncStatus('idle')
      return
    }

    let socket: WebSocket | null = null
    let attempt = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    const flush = () => {
      flushOutbox().catch(() => {
        // Still offline or the server is failing: the operations stay queued for the next flush.
      })
    }

    const connect = () => {
      const token = getSessionId()
      if (!token || stopped) return
      setSyncStatus('connecting')
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${scheme}://${window.location.host}/api/sync/ws`)
      socket = ws

      // The token goes in the first message, not the URL, so it never lands in proxy logs.
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token, deviceId: getDeviceId() }))
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data as string) as { type: string; seq?: number; latestSeq?: number }
        if (message.type === 'welcome') {
          attempt = 0
          setSyncStatus('live')
          noteRemoteSeq(message.latestSeq ?? 0)
          flush()
        } else if (message.type === 'changed' && typeof message.seq === 'number') {
          noteRemoteSeq(message.seq)
        }
      }
      ws.onclose = (event) => {
        if (socket === ws) socket = null
        if (stopped) return
        setSyncStatus('offline')
        if (event.code === UNAUTHORIZED) return
        // Exponential backoff with jitter, so a restarted server isn't hit by every tab at once.
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2)
        attempt++
        retryTimer = setTimeout(connect, delay)
      }
    }

    const onOnline = () => {
      clearTimeout(retryTimer)
      if (!socket) connect()
      flush()
    }

    window.addEventListener('online', onOnline)
    connect()

    return () => {
      stopped = true
      clearTimeout(retryTimer)
      window.removeEventListener('online', onOnline)
      socket?.close(1000, 'Logged out')
      setSyncStatus('idle')
    }
  }, [isAuthenticated])
}
