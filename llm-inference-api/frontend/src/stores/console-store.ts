import { create } from 'zustand'
import { api, ApiError, toApiError, type SubmitBody } from '@/services/api'
import { readSse } from '@/services/sse'
import type { Mode, Org } from '@/types'

export type RunPhase = 'idle' | 'submitting' | 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'detached'

export interface RunState {
  requestId: string | null
  mode: Mode
  phase: RunPhase
  text: string
  backendId: string | null
  version: string | null
  affinity: string | null
  cachedTokens: number | null
  attempts: number | null
  queueMs: number | null
  ttftMs: number | null
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } | null
  latency: { queue_ms: number | null; ttft_ms: number | null; exec_ms: number | null; total_ms: number | null; tokens_per_sec: number | null } | null
  notes: { at: number; text: string; tone: 'info' | 'warn' | 'error' }[]
  error: { type: string; message: string; retryAfter: string | null } | null
}

const emptyRun = (mode: Mode = 'stream'): RunState => ({
  requestId: null, mode, phase: 'idle', text: '', backendId: null, version: null, affinity: null, cachedTokens: null, attempts: null,
  queueMs: null, ttftMs: null, usage: null, latency: null, notes: [], error: null,
})

interface ConsoleState {
  orgs: Org[]
  keyId: string | null
  run: RunState
  /** Bumped when a run ends, so the history table refetches. */
  historyVersion: number
  loadOrgs: () => Promise<void>
  setKey: (keyId: string) => void
  submit: (body: Omit<SubmitBody, 'keyId'>) => Promise<void>
  cancel: () => Promise<void>
  detach: () => void
}

let submitAbort: AbortController | null = null
let attachAbort: AbortController | null = null

export const useConsoleStore = create<ConsoleState>((set, get) => {
  const patch = (p: Partial<RunState>) => set((s) => ({ run: { ...s.run, ...p } }))
  const note = (text: string, tone: 'info' | 'warn' | 'error' = 'info') => set((s) => ({ run: { ...s.run, notes: [...s.run.notes, { at: Date.now(), text, tone }] } }))
  const finish = () => set((s) => ({ historyVersion: s.historyVersion + 1 }))

  const onEvent = (event: string, data: Record<string, unknown>) => {
    if (event === 'message_start') {
      const id = (data.message as { id: string }).id
      patch({ requestId: id, phase: 'queued' })
    } else if (event === 'inference_status') {
      if (data.status === 'queued') note(`Queued in the ${String(data.priority)} lane`)
      else if (data.status === 'running') {
        patch({
          phase: 'running', backendId: String(data.backendId), version: String(data.version), affinity: String(data.affinity),
          cachedTokens: Number(data.cachedTokens), attempts: Number(data.attempts), queueMs: Number(data.queueMs), ttftMs: Number(data.ttftMs),
        })
        note(`Running on ${String(data.backendId)} (${String(data.affinity)}${Number(data.cachedTokens) > 0 ? `, ${String(data.cachedTokens)} cached prefix tokens` : ', prefix cache miss'})`)
      } else if (data.status === 'requeued') note(`Re-routed before output started: ${String(data.reason)}${data.fromBackend ? ` (from ${String(data.fromBackend)})` : ''}`, 'warn')
    } else if (event === 'content_block_delta') {
      const delta = data.delta as { text?: string }
      set((s) => ({ run: { ...s.run, text: s.run.text + (delta.text ?? '') } }))
    } else if (event === 'message_delta') {
      const delta = data.delta as { stop_reason: string }
      if (delta.stop_reason === 'cancelled') {
        patch({ phase: 'cancelled' })
        note(`Cancelled (${String(data.cancel_reason ?? 'cancel')})`, 'warn')
      } else {
        patch({ phase: 'completed', usage: (data.usage as RunState['usage']) ?? null, latency: (data.latency as RunState['latency']) ?? null })
        note(`Completed: ${delta.stop_reason}`)
      }
    } else if (event === 'error') {
      const err = data.error as { type: string; message: string }
      patch({ phase: 'failed', error: { type: err.type, message: err.message, retryAfter: null } })
      note(`${err.type}: ${err.message}`, 'error')
    }
  }

  const fail = (err: unknown) => {
    const e = err instanceof ApiError ? err : new ApiError(0, 'unreachable', err instanceof Error ? err.message : 'Request failed')
    patch({ phase: 'failed', error: { type: e.type, message: e.message, retryAfter: e.retryAfter } })
    note(`${e.status ? `${e.status} ` : ''}${e.type}: ${e.message}${e.retryAfter ? ` (Retry-After ${e.retryAfter}s)` : ''}`, 'error')
  }

  return {
    orgs: [],
    keyId: null,
    run: emptyRun(),
    historyVersion: 0,

    async loadOrgs() {
      const { orgs } = await api.orgs()
      const keyId = get().keyId ?? orgs.find((o) => o.isMember)?.keys[0]?.id ?? orgs[0]?.keys[0]?.id ?? null
      set({ orgs, keyId })
    },

    setKey(keyId) {
      set({ keyId })
    },

    async submit(body) {
      const keyId = get().keyId
      if (!keyId) return
      submitAbort?.abort()
      attachAbort?.abort()
      submitAbort = new AbortController()
      set({ run: { ...emptyRun(body.mode), phase: 'submitting' } })
      try {
        const resp = await api.submit({ ...body, keyId }, submitAbort.signal)
        if (!resp.ok) throw await toApiError(resp)
        if (body.mode === 'stream') {
          await readSse(resp, onEvent)
        } else if (body.mode === 'sync') {
          const msg = (await resp.json()) as { id: string; content: { text: string }[]; usage: RunState['usage']; stop_reason: string }
          patch({
            requestId: msg.id, phase: 'completed', text: msg.content[0]?.text ?? '', usage: msg.usage,
            backendId: resp.headers.get('x-inference-backend'), queueMs: Number(resp.headers.get('x-inference-queue-ms')), ttftMs: Number(resp.headers.get('x-inference-ttft-ms')),
          })
          note(`Completed: ${msg.stop_reason} (one JSON response; sync mode does not stream)`)
        } else {
          const accepted = (await resp.json()) as { id: string; priority: string }
          patch({ requestId: accepted.id, phase: 'queued' })
          note(`202 Accepted in the ${accepted.priority} lane. The request id owns the work now.`)
          attachAbort = new AbortController()
          const events = await api.attach(accepted.id, attachAbort.signal)
          await readSse(events, (event, data) => {
            if (event !== 'message_start') onEvent(event, data)
          })
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        fail(err)
      } finally {
        finish()
      }
    },

    async cancel() {
      const { run } = get()
      if (run.mode === 'sync' || !run.requestId) {
        // Sync: closing the connection is the cancel. The gateway cancels a request whose client went away.
        submitAbort?.abort()
        patch({ phase: 'cancelled' })
        note('Connection closed. The gateway cancels a sync request when its client disconnects.', 'warn')
        setTimeout(finish, 600)
        return
      }
      note('Cancelling… (the server decides whether the cancel or the completion wins)')
      try {
        const r = await api.cancel(run.requestId)
        if (r.cancelled) note('Cancel won the race: the request is cancelled.', 'warn')
        else note(`Cancel lost the race: the request had already reached "${r.request.status}".`, 'warn')
        if (run.phase === 'detached') patch({ phase: r.request.status === 'cancelled' ? 'cancelled' : run.phase })
      } catch (err) {
        fail(err)
      }
      finish()
    },

    detach() {
      attachAbort?.abort()
      patch({ phase: 'detached' })
      note('Detached from the event stream. An async request keeps running; open it from the history to fetch the result.')
      setTimeout(finish, 300)
    },
  }
})
