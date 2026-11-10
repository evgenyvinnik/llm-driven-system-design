/**
 * One settings client = one "device": its own server document, pending edits,
 * write queue and live connection. The app uses one (this tab); the
 * two-devices view creates two more, each pointed at a different API instance.
 *
 * Writes go through a queue with at most one PATCH in flight. Edits made while
 * a PATCH is in flight are merged into the next one, which uses the newest
 * revision as its If-Match. Without that, a quick on-off toggle would conflict
 * with its own first write.
 * @module lib/settings-store
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import { ApiError, OutcomeUnknownError, type Api, type ClientIdentity } from '@/services/api'
import type { Definition, EffectiveDoc, FieldError, KeyConflict, PatchWarning, SettingValue } from '@/types'
import { connectLive } from './live-sync'
import { isNewerOrSame, reconcileAfterUnknown } from './sync-rules'

export type PendingStatus = 'queued' | 'saving' | 'unknown' | 'conflict' | 'error'

export interface PendingEdit {
  value: SettingValue | null
  status: PendingStatus
  sentValue?: SettingValue | null
  conflict?: KeyConflict
  error?: FieldError
}

export interface LogEntry {
  id: number
  at: number
  tone: 'info' | 'ok' | 'warn' | 'error' | 'event'
  text: string
}

export type LiveStatus = 'off' | 'connecting' | 'live' | 'reconnecting' | 'frozen'

export interface SettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  doc: EffectiveDoc | null
  definitions: Definition[]
  pending: Record<string, PendingEdit>
  warnings: PatchWarning[]
  live: LiveStatus
  instanceId: string | null
  flash: Record<string, number>
  log: LogEntry[]
}

export interface SettingsActions {
  start: (userId: string) => void
  stop: () => void
  refetch: (reason: string, force?: boolean) => Promise<void>
  adopt: (doc: EffectiveDoc, opts?: { force?: boolean; flashKeys?: string[]; fromTab?: boolean }) => void
  note: (tone: LogEntry['tone'], text: string) => void
  setLive: (live: LiveStatus, instanceId?: string | null) => void
  set: (key: string, value: SettingValue | null) => void
  resolveConflict: (key: string, choice: 'mine' | 'theirs') => void
  dismiss: (key: string) => void
  setFrozen: (frozen: boolean) => void
}

export type SettingsStore = StoreApi<SettingsState & SettingsActions>

export interface SettingsClientOptions {
  api: Api
  apiBase: string
  identity: ClientIdentity
  /** Share results with other tabs of this browser. Simulated devices don't (they're different devices). */
  broadcast: boolean
}

let logSeq = 0

export function createSettingsStore(opts: SettingsClientOptions): SettingsStore {
  let disconnect: (() => void) | null = null
  let userId: string | null = null
  let inflight = false
  let frozen = false

  const store = createStore<SettingsState & SettingsActions>()((set, get) => {
    const patchPending = (fn: (p: Record<string, PendingEdit>) => void) => {
      const next = { ...get().pending }
      fn(next)
      set({ pending: next })
    }

    /** Settles keys whose outcome became known through a refetch (lost response) instead of the PATCH response. */
    const reconcileUnknown = (doc: EffectiveDoc) => {
      const unknown = Object.entries(get().pending).filter(([, p]) => p.status === 'unknown')
      if (unknown.length === 0) return
      const sent = Object.fromEntries(unknown.map(([k, p]) => [k, p.sentValue ?? null]))
      const { landed, notLanded } = reconcileAfterUnknown(doc, sent)
      patchPending((p) => {
        for (const k of landed) delete p[k]
        for (const k of notLanded) p[k] = { ...p[k], status: 'queued' }
      })
      if (landed.length > 0) get().note('ok', `Reconciled: ${landed.join(', ')} found on the server at r${doc.revision}`)
      if (notLanded.length > 0) {
        get().note('warn', `Not on the server: ${notLanded.join(', ')}. Sending again (safe: PATCH sets values)`)
        void flush()
      }
    }

    async function flush(): Promise<void> {
      const { doc, pending } = get()
      if (inflight || !doc) return
      const batch = Object.entries(pending).filter(([, p]) => p.status === 'queued')
      if (batch.length === 0) return
      inflight = true
      const patch = Object.fromEntries(batch.map(([k, p]) => [k, p.value]))
      const base = doc.revision
      patchPending((p) => {
        for (const [k, edit] of batch) p[k] = { ...edit, status: 'saving', sentValue: edit.value }
      })
      try {
        const res = await opts.api.patchSettings(patch, base, opts.identity)
        get().adopt(res)
        patchPending((p) => {
          for (const k of Object.keys(patch)) {
            const edit = p[k]
            if (!edit || edit.status !== 'saving') continue
            if (edit.value === edit.sentValue) delete p[k]
            else p[k] = { value: edit.value, status: 'queued' } // edited again while in flight
          }
        })
        set({ warnings: res.warnings })
        if (res.applied.length > 0) get().note('ok', `Saved r${res.revision}: ${res.applied.join(', ')} (If-Match "${base}")`)
        else get().note('info', `No change: ${res.unchanged.join(', ')} already had that value (r${res.revision})`)
        for (const w of res.warnings) get().note('warn', `${w.key}: ${w.message}`)
      } catch (err) {
        handleFailure(err, patch)
      } finally {
        inflight = false
        if (Object.values(get().pending).some((p) => p.status === 'queued')) void flush()
      }
    }

    function handleFailure(err: unknown, patch: Record<string, SettingValue | null>) {
      const keys = Object.keys(patch)
      if (err instanceof OutcomeUnknownError) {
        patchPending((p) => {
          for (const k of keys) if (p[k]?.status === 'saving') p[k] = { ...p[k], status: 'unknown' }
        })
        get().note('warn', `Response lost (${err.message}). Outcome unknown → refetching`)
        void get().refetch('outcome unknown')
        return
      }
      if (!(err instanceof ApiError)) throw err
      const body = err.body
      if (err.status === 409 && Array.isArray(body.conflicts)) {
        const conflicts = body.conflicts as KeyConflict[]
        if (body.current) get().adopt(body.current as EffectiveDoc)
        patchPending((p) => {
          for (const k of keys) p[k] = { value: patch[k], status: 'queued' }
          for (const c of conflicts) p[c.key] = { value: patch[c.key], status: 'conflict', conflict: c }
        })
        for (const c of conflicts) get().note('error', `409 on ${c.key}: changed at r${c.changedAtRevision}${c.changedBy ? ` by ${c.changedBy}` : ''} after your base r${c.baseRevision}`)
        return
      }
      if (err.status === 422 && Array.isArray(body.fields)) {
        const fields = body.fields as FieldError[]
        patchPending((p) => {
          for (const k of keys) p[k] = { value: patch[k], status: 'queued' }
          for (const f of fields) p[f.key] = { value: patch[f.key] ?? null, status: 'error', error: f }
        })
        for (const f of fields) get().note('error', `422 ${f.code} on ${f.key}: ${f.message}`)
        if (fields.some((f) => f.code === 'LOCKED')) void get().refetch('policy changed')
        return
      }
      if (err.status === 412) {
        get().note('warn', '412: our revision is ahead of the server (restored?). Refetching')
        patchPending((p) => {
          for (const k of keys) p[k] = { value: patch[k], status: 'queued' }
        })
        void get().refetch('412', true)
        return
      }
      patchPending((p) => {
        for (const k of keys) p[k] = { value: patch[k], status: 'error', error: { key: k, code: body.code, message: body.message } }
      })
      get().note('error', `${err.status} ${body.code}: ${body.message}`)
    }

    return {
      status: 'idle',
      error: null,
      doc: null,
      definitions: [],
      pending: {},
      warnings: [],
      live: 'off',
      instanceId: null,
      flash: {},
      log: [],

      note(tone, text) {
        set({ log: [{ id: ++logSeq, at: Date.now(), tone, text }, ...get().log].slice(0, 40) })
      },

      setLive(live, instanceId) {
        set(instanceId === undefined ? { live } : { live, instanceId })
      },

      adopt(doc, o = {}) {
        const current = get().doc
        if (!o.force && !isNewerOrSame(doc, current)) return
        const flash = { ...get().flash }
        for (const k of o.flashKeys ?? []) flash[k] = Date.now()
        const moved = !current || current.revision !== doc.revision || current.orgRevision !== doc.orgRevision || current.catalogRevision !== doc.catalogRevision
        set({ doc, flash, status: 'ready', error: null })
        reconcileUnknown(doc)
        // Tell other tabs, but never echo a document that came from another tab (no ping-pong).
        if (moved && !o.fromTab && opts.broadcast && userId) live.broadcast(userId, doc)
      },

      async refetch(reason, force = false) {
        const st = get()
        if (st.status === 'idle') set({ status: 'loading' })
        try {
          const needDefs = st.definitions.length === 0 || reason === 'catalog'
          const [defs, doc] = await Promise.all([needDefs ? opts.api.definitions() : null, opts.api.settings()])
          if (defs) set({ definitions: defs.definitions })
          get().adopt(doc, { force })
          if (reason !== 'initial') get().note('info', `Refetched r${doc.revision} (${reason})`)
        } catch (err) {
          if (!get().doc) set({ status: 'error', error: err instanceof Error ? err.message : 'Failed to load' })
          else get().note('error', `Refetch failed (${reason}); will retry on reconnect`)
        }
      },

      start(id) {
        if (disconnect && userId === id) return
        get().stop()
        userId = id
        void get().refetch('initial')
        if (!frozen) disconnect = live.connect()
      },

      stop() {
        disconnect?.()
        disconnect = null
        set({ live: frozen ? 'frozen' : 'off' })
      },

      set(key, value) {
        patchPending((p) => {
          p[key] = { value, status: 'queued' }
        })
        void flush()
      },

      resolveConflict(key, choice) {
        if (choice === 'theirs') {
          patchPending((p) => delete p[key])
          get().note('info', `Kept the other device's value for ${key}`)
          return
        }
        patchPending((p) => {
          if (p[key]) p[key] = { value: p[key].value, status: 'queued' }
        })
        get().note('info', `Overwriting ${key} with your value, based on r${get().doc?.revision}`)
        void flush()
      },

      dismiss(key) {
        patchPending((p) => delete p[key])
      },

      setFrozen(next) {
        frozen = next
        if (next) {
          disconnect?.()
          disconnect = null
          set({ live: 'frozen' })
          get().note('info', 'Sync frozen: no SSE, no refetch. Writes still go out with the old revision')
        } else {
          set({ live: 'connecting' })
          get().note('info', 'Sync resumed')
          if (userId) disconnect = live.connect()
        }
      },
    }
  })

  const live = connectLive(store, opts, () => userId, () => frozen)
  return store
}
