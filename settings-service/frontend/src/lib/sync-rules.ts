/**
 * The client's sync rules as pure functions, so they can be unit-tested
 * without a browser. The store (lib/settings-store) only wires them to I/O.
 * @module lib/sync-rules
 */
import type { EffectiveDoc, EffectiveEntry, Revisions, SettingValue, UserChangedEvent } from '@/types'

export type OutcomeKind = 'success' | 'rejected' | 'unknown'

/**
 * 2xx: it happened. 4xx with our error envelope: the server definitely refused
 * and nothing was saved. Everything else (no response, timeout, 5xx, a proxy's
 * HTML error page) is "outcome unknown": the write may have committed.
 */
export function classifyOutcome(status: number, hasEnvelope: boolean): OutcomeKind {
  if (status >= 200 && status < 300) return 'success'
  if (status >= 400 && status < 500 && hasEnvelope) return 'rejected'
  return 'unknown'
}

export type EventDecision = 'ignore' | 'apply' | 'refetch'

/**
 * A `user` event carries the changed keys' new entries for revision N.
 * - N ≤ local revision: already have it (our own write's echo, or a replay) → ignore.
 * - N = local + 1, resolved against the same org and catalog revisions → apply the delta.
 * - otherwise (a gap: we missed N-1, or the org/catalog moved) → refetch the document.
 */
export function decideUserEvent(local: Revisions | null, event: Revisions): EventDecision {
  if (!local) return 'refetch'
  if (event.revision <= local.revision) return 'ignore'
  if (event.revision === local.revision + 1 && event.orgRevision === local.orgRevision && event.catalogRevision === local.catalogRevision) {
    return 'apply'
  }
  return 'refetch'
}

/** Org and catalog events are invalidations: refetch only if they are newer than what we hold. */
export function decideScopedEvent(localRevision: number | undefined, eventRevision: number): 'ignore' | 'refetch' {
  return localRevision === undefined || eventRevision > localRevision ? 'refetch' : 'ignore'
}

/**
 * On (re)connect the server's hello carries its current revisions. Any
 * difference means we missed something. A server revision BELOW ours (a
 * restore from backup) must be adopted even though it looks older.
 */
export function decideHello(local: Revisions | null, hello: Revisions): { refetch: boolean; force: boolean } {
  if (!local) return { refetch: true, force: true }
  const behind = hello.revision < local.revision || hello.orgRevision < local.orgRevision || hello.catalogRevision < local.catalogRevision
  const differs = behind || hello.revision !== local.revision || hello.orgRevision !== local.orgRevision || hello.catalogRevision !== local.catalogRevision
  return { refetch: differs, force: behind }
}

/** Should a document from the server replace the one we hold? Never go backwards (a slow GET racing a PATCH response). */
export function isNewerOrSame(next: Revisions, current: Revisions | null): boolean {
  if (!current) return true
  if (next.revision !== current.revision) return next.revision > current.revision
  return next.orgRevision >= current.orgRevision && next.catalogRevision >= current.catalogRevision
}

export function applyDelta(doc: EffectiveDoc, event: UserChangedEvent): EffectiveDoc {
  return {
    revision: event.revision,
    orgRevision: event.orgRevision,
    catalogRevision: event.catalogRevision,
    settings: { ...doc.settings, ...event.changes },
  }
}

/** The user's own stored value for a key, whether it currently wins or is shadowed by enforcement. */
export function ownValue(entry: EffectiveEntry | undefined): SettingValue | null {
  if (!entry) return null
  if (entry.source === 'user') return entry.value
  return entry.userValue ?? null
}

/**
 * After a write whose response was lost: which of the keys we sent are now
 * on the server with the value we sent? Those are done. The rest did not land
 * (or someone else changed them since) and go back through the normal write path.
 */
export function reconcileAfterUnknown(doc: EffectiveDoc, sent: Record<string, SettingValue | null>): { landed: string[]; notLanded: string[] } {
  const landed: string[] = []
  const notLanded: string[] = []
  for (const [key, value] of Object.entries(sent)) {
    if (ownValue(doc.settings[key]) === value) landed.push(key)
    else notLanded.push(key)
  }
  return { landed, notLanded }
}
