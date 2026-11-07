/**
 * Keeps one settings client in sync:
 * - SSE from the server (other devices, org policy, catalog), keyed by revision;
 * - BroadcastChannel to other tabs of this browser (instant, no server round trip);
 * - a refetch when the tab becomes visible again (events are hints; the revision is the truth).
 * @module lib/live-sync
 */
import type { StoreApi } from 'zustand/vanilla'
import type { CatalogChangedEvent, EffectiveDoc, HelloEvent, OrgChangedEvent, UserChangedEvent } from '@/types'
import type { SettingsActions, SettingsClientOptions, SettingsState } from './settings-store'
import { applyDelta, decideHello, decideScopedEvent, decideUserEvent } from './sync-rules'

interface TabMessage {
  userId: string
  from: string
  doc: EffectiveDoc
}

const CHANNEL = 'settings-sync'

export function connectLive(
  store: StoreApi<SettingsState & SettingsActions>,
  opts: SettingsClientOptions,
  getUserId: () => string | null,
  isFrozen: () => boolean,
) {
  const s = () => store.getState()
  const channel = opts.broadcast && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null

  channel?.addEventListener('message', (e: MessageEvent<TabMessage>) => {
    const msg = e.data
    if (isFrozen() || msg.userId !== getUserId() || msg.from === opts.identity.clientId) return
    const before = s().doc?.revision ?? 0
    s().adopt(msg.doc, { flashKeys: changedKeys(s().doc, msg.doc), fromTab: true })
    if (msg.doc.revision > before) s().note('event', `r${msg.doc.revision} from another tab (BroadcastChannel)`)
  })

  if (opts.broadcast && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && getUserId() && !isFrozen()) void s().refetch('tab visible')
    })
  }

  function connect(): () => void {
    const source = new EventSource(`${opts.apiBase}/v1/events`)
    s().setLive('connecting')

    source.addEventListener('error', () => {
      s().setLive(source.readyState === EventSource.CLOSED ? 'off' : 'reconnecting')
    })

    source.addEventListener('hello', (e) => {
      const hello = JSON.parse((e as MessageEvent<string>).data) as HelloEvent
      s().setLive('live', hello.instanceId)
      const decision = decideHello(s().doc, hello)
      if (decision.refetch && s().doc) void s().refetch(`reconnected to ${hello.instanceId}; revisions moved`, decision.force)
    })

    source.addEventListener('user', (e) => {
      const ev = JSON.parse((e as MessageEvent<string>).data) as UserChangedEvent
      const doc = s().doc
      const decision = decideUserEvent(doc, ev)
      const via = `via SSE on ${s().instanceId ?? '?'}, written on ${ev.origin}${ev.clientLabel ? ` by ${ev.clientLabel}` : ''}`
      if (decision === 'apply' && doc) {
        s().adopt(applyDelta(doc, ev), { flashKeys: Object.keys(ev.changes) })
        s().note('event', `r${ev.revision} ${via}: ${Object.keys(ev.changes).join(', ')}`)
      } else if (decision === 'refetch') {
        s().note('warn', `r${ev.revision} ${via}; holding r${doc?.revision ?? '-'} → gap, refetching`)
        void s().refetch('revision gap')
      }
    })

    source.addEventListener('org', (e) => {
      const ev = JSON.parse((e as MessageEvent<string>).data) as OrgChangedEvent
      if (decideScopedEvent(s().doc?.orgRevision, ev.orgRevision) === 'ignore') return
      s().note('event', `Org policy r${ev.orgRevision} changed (${ev.keys.join(', ')}) → refetching`)
      // Jitter: one org event reaches every member at once; spread the refetches.
      setTimeout(() => void s().refetch('org policy changed'), Math.random() * 400)
    })

    source.addEventListener('catalog', (e) => {
      const ev = JSON.parse((e as MessageEvent<string>).data) as CatalogChangedEvent
      if (decideScopedEvent(s().doc?.catalogRevision, ev.catalogRevision) === 'ignore') return
      s().note('event', `Catalog r${ev.catalogRevision} changed (${ev.keys.join(', ')}) → refetching`)
      setTimeout(() => void s().refetch('catalog'), Math.random() * 400)
    })

    return () => source.close()
  }

  function broadcast(userId: string, doc: EffectiveDoc) {
    channel?.postMessage({ userId, from: opts.identity.clientId, doc } satisfies TabMessage)
  }

  return { connect, broadcast }
}

function changedKeys(before: EffectiveDoc | null, after: EffectiveDoc): string[] {
  if (!before) return []
  return Object.keys(after.settings).filter((k) => JSON.stringify(before.settings[k]) !== JSON.stringify(after.settings[k]))
}
