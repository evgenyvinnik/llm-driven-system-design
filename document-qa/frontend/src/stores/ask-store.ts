/**
 * Q&A state: the run history plus live streams for runs still generating.
 * A run is a server-side record; the client only follows its event stream and
 * re-reads the run when it ends (for usage and final citations).
 */
import { create } from 'zustand'
import { api } from '@/services/api'
import { followRun, type StreamEvent } from '@/services/run-stream'
import type { CacheInfo, Citation, RetrievalInfo, Run, SourceRef } from '@/types'

interface AskState {
  runs: Run[]
  loaded: boolean
  error: string | null
  load: () => Promise<void>
  /** Re-reads history so server-side redactions (access lost, source deleted) reach an open page. */
  refresh: () => Promise<void>
  ask: (question: string) => Promise<void>
  stop: (id: string) => Promise<void>
  /** Drops history and live streams (sign-out / account switch). */
  reset: () => void
}

const streams = new Map<string, AbortController>()

export const useAskStore = create<AskState>((set, get) => {
  const update = (id: string, fn: (r: Run) => Run) => set((s) => ({ runs: s.runs.map((r) => (r.id === id ? fn(r) : r)) }))

  /** Re-reads history (final usage, citations, and redactions the server applies on read), keeping runs still streaming as they are. */
  const sync = async () => {
    const res = await api.runs().catch(() => null)
    if (!res) return
    const server = new Map(res.runs.map((r) => [r.id, r]))
    set((s) => ({ runs: s.runs.map((r) => (streams.has(r.id) ? r : (server.get(r.id) ?? r))) }))
  }

  const apply = (id: string, e: StreamEvent) => {
    const d = e.data
    if (e.type === 'snapshot' || e.type === 'status') update(id, (r) => ({ ...r, status: (d.status as Run['status']) ?? r.status }))
    else if (e.type === 'cache') update(id, (r) => ({ ...r, cache: d as CacheInfo }))
    else if (e.type === 'retrieval') {
      const { sources, ...retrieval } = d as { sources?: SourceRef[] } & RetrievalInfo
      update(id, (r) => ({ ...r, retrieval, sources: sources ?? r.sources }))
    } else if (e.type === 'delta') update(id, (r) => ({ ...r, status: 'running', outputText: r.outputText + String(d.text ?? '') }))
    else if (e.type === 'completed') update(id, (r) => ({ ...r, status: 'completed', citations: (d.citations as Citation[]) ?? r.citations }))
    else if (e.type === 'failed' || e.type === 'cancelled')
      update(id, (r) => ({
        ...r,
        status: e.type as Run['status'],
        error: (d.error as string | null) ?? r.error,
        outputText: typeof d.outputText === 'string' && d.outputText.length >= r.outputText.length ? d.outputText : r.outputText,
      }))
  }

  const follow = (id: string) => {
    if (streams.has(id)) return
    const ac = new AbortController()
    streams.set(id, ac)
    // Replay starts from the first event, so the text is rebuilt from scratch.
    update(id, (r) => ({ ...r, outputText: '' }))
    followRun(id, (e) => apply(id, e), ac.signal)
      .catch((err: Error) => update(id, (r) => ({ ...r, error: err.message })))
      .finally(() => {
        streams.delete(id)
        void sync()
      })
  }

  return {
    runs: [],
    loaded: false,
    error: null,
    async load() {
      try {
        const { runs } = await api.runs()
        // A run still streaming on this page keeps its live text; the server copy lags by up to a heartbeat.
        set((s) => ({
          runs: [...runs].reverse().map((r) => (streams.has(r.id) ? (s.runs.find((x) => x.id === r.id) ?? r) : r)),
          loaded: true,
          error: null,
        }))
        for (const r of get().runs) if (r.status === 'queued' || r.status === 'running') follow(r.id)
      } catch (err) {
        set({ loaded: true, error: err instanceof Error ? err.message : 'Could not load answers' })
      }
    },
    refresh: sync,
    async ask(question) {
      const { run } = await api.ask(question)
      set((s) => ({ runs: [...s.runs, run] }))
      follow(run.id)
    },
    async stop(id) {
      await api.cancel(id).catch(() => undefined)
    },
    reset() {
      for (const ac of streams.values()) ac.abort()
      streams.clear()
      set({ runs: [], loaded: false, error: null })
    },
  }
})
