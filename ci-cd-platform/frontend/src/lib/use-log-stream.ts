/**
 * Reads a log stream over SSE with `fetch`, so the session cookie and the reconnect stay
 * under our control, and the Last-Event-ID is sent explicitly on every (re)connect. The cursor
 * is the last line we hold, so a drop anywhere picks up with exactly the lines that were missed.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LogLine } from '@/types'

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'ended' | 'denied'

export interface ResumeNote {
  after: number
  received: number
  servedBy: string
}

export interface LogStream {
  lines: LogLine[]
  status: StreamStatus
  servedBy: string | null
  source: string | null
  reconnects: number
  lastResume: ResumeNote | null
  /** Drops the connection on purpose, to see the resume work. */
  drop: () => void
}

const BACKOFF_MS = [500, 1000, 2000, 4000]

function parseBlock(block: string): { event: string; id: string | null; data: string } | null {
  let event = 'message'
  let id: string | null = null
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('id:')) id = line.slice(3).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  return data.length > 0 ? { event, id, data: data.join('\n') } : null
}

export function useLogStream(jobId: string, attempt: number | null): LogStream {
  const [lines, setLines] = useState<LogLine[]>([])
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const [servedBy, setServedBy] = useState<string | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const [reconnects, setReconnects] = useState(0)
  const [lastResume, setLastResume] = useState<ResumeNote | null>(null)
  const current = useRef<AbortController | null>(null)

  useEffect(() => {
    if (attempt === null) return
    let stopped = false
    let cursor = 0
    let tries = 0
    let isReconnect = false
    setLines([])
    setStatus('connecting')
    setServedBy(null)
    setSource(null)
    setReconnects(0)
    setLastResume(null)

    const connect = async (): Promise<void> => {
      const controller = new AbortController()
      current.current = controller
      const resumedFrom = cursor
      let received = 0
      let batch: LogLine[] = []
      const flush = () => {
        if (batch.length === 0) return
        const add = batch
        batch = []
        setLines((prev) => [...prev, ...add])
      }
      const timer = window.setInterval(flush, 150)
      try {
        const response = await fetch(`/api/v1/jobs/${jobId}/attempts/${attempt}/logs/stream`, {
          headers: cursor > 0 ? { 'Last-Event-ID': String(cursor) } : {},
          credentials: 'same-origin',
          signal: controller.signal,
        })
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          setStatus('denied')
          return
        }
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        setStatus('live')
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += value
          let boundary = buffer.indexOf('\n\n')
          while (boundary !== -1) {
            const message = parseBlock(buffer.slice(0, boundary))
            buffer = buffer.slice(boundary + 2)
            boundary = buffer.indexOf('\n\n')
            if (!message) continue
            if (message.event === 'hello') {
              const hello = JSON.parse(message.data) as { servedBy: string }
              setServedBy(hello.servedBy)
            } else if (message.event === 'line') {
              const line = JSON.parse(message.data) as LogLine
              // The id is what makes this safe: a line we already hold can't be added twice.
              if (line.n <= cursor) continue
              cursor = line.n
              received++
              tries = 0
              batch.push(line)
              if (isReconnect && received === 1) setLastResume({ after: resumedFrom, received: 1, servedBy: '' })
            } else if (message.event === 'end') {
              const end = JSON.parse(message.data) as { source: string }
              flush()
              setSource(end.source)
              setStatus('ended')
              stopped = true
              controller.abort()
              return
            } else if (message.event === 'revoked') {
              flush()
              setStatus('denied')
              stopped = true
              return
            }
          }
          if (isReconnect && received > 0) setLastResume((n) => (n ? { ...n, received } : n))
        }
      } catch (err) {
        if (stopped) return
        if ((err as Error).name !== 'AbortError') console.warn('log stream dropped', err)
      } finally {
        window.clearInterval(timer)
        flush()
      }
      if (stopped) return
      setStatus('reconnecting')
      setReconnects((n) => n + 1)
      isReconnect = true
      const wait = BACKOFF_MS[Math.min(tries, BACKOFF_MS.length - 1)]
      tries++
      window.setTimeout(() => {
        if (!stopped) void connect()
      }, wait)
    }

    void connect()
    return () => {
      stopped = true
      current.current?.abort()
    }
  }, [jobId, attempt])

  const drop = useCallback(() => current.current?.abort(), [])
  return { lines, status, servedBy, source, reconnects, lastResume, drop }
}
