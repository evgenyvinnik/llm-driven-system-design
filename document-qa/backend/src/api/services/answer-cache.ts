/**
 * Answer cache in Valkey, safe by validation on read rather than by trusting
 * invalidation.
 *
 * Key: org + user + hash(normalized question). The user is in the key because
 * what retrieval returns depends on what the user can read.
 *
 * Each entry records every document whose chunks were in the prompt (not
 * just the cited ones: a model can repeat uncited context), with the version
 * and the document's access epoch at the time. On every read, one query
 * against PostgreSQL checks each of them, for this reader, right now:
 * tombstoned → reject; reader lost access (unshared, removed from the group)
 * → reject; a newer version is current → reject; access epoch moved → reject.
 * A rejected entry is deleted and the question is answered fresh.
 *
 * So a cached answer citing a deleted or unshared document is never served,
 * even before the purge job has removed the entry (it does, via the
 * per-document reverse index, without ever deleting by key pattern).
 * @module api/services/answer-cache
 */
import { createHash } from 'node:crypto'
import { accessDecision, type AccessUser, type Scope } from '../../shared/access.js'
import { keys, redis } from '../../shared/cache.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { normalizeQuestion } from '../../shared/text.js'
import type { Citation, SourceRef } from './dto.js'

export interface ContextDoc {
  documentId: string
  versionId: string
  aclEpoch: number
}

export interface CachedAnswer {
  runId: string
  question: string
  answer: string
  sources: SourceRef[]
  citations: Citation[]
  context: ContextDoc[]
  createdAt: string
}

export interface DocTruth {
  id: string
  orgId: string
  ownerId: string
  scope: Scope
  groupId: string | null
  deletedAt: Date | string | null
  currentVersionId: string | null
  aclEpoch: number
}

export type Validation = { valid: true } | { valid: false; reason: string; documentId: string }

export function questionHash(question: string): string {
  return createHash('sha256').update(normalizeQuestion(question)).digest('hex').slice(0, 32)
}

export function cacheKey(orgId: string, userId: string, question: string): string {
  return keys.answer(orgId, userId, questionHash(question))
}

/** Pure: is this entry still servable to this reader, given the current truth? */
export function validateEntry(entry: CachedAnswer, truth: Map<string, DocTruth>, user: AccessUser, liveGroups: ReadonlySet<string>): Validation {
  for (const ctx of entry.context) {
    const doc = truth.get(ctx.documentId)
    if (!doc) return { valid: false, reason: 'a source document no longer exists', documentId: ctx.documentId }
    const access = accessDecision(doc, user, liveGroups)
    if (!access.allowed) {
      const reason = access.reason === 'deleted' ? 'a source document was deleted' : 'you no longer have access to a source document'
      return { valid: false, reason, documentId: ctx.documentId }
    }
    if (doc.currentVersionId !== ctx.versionId) return { valid: false, reason: 'a source document has a newer version', documentId: ctx.documentId }
    if (doc.aclEpoch !== ctx.aclEpoch) return { valid: false, reason: 'sharing on a source document changed', documentId: ctx.documentId }
  }
  return { valid: true }
}

export async function loadDocTruth(ids: string[]): Promise<Map<string, DocTruth>> {
  if (ids.length === 0) return new Map()
  const { rows } = await pool.query<{
    id: string
    org_id: string
    owner_id: string
    scope: Scope
    group_id: string | null
    deleted_at: Date | null
    current_version_id: string | null
    acl_epoch: string
  }>(`SELECT id, org_id, owner_id, scope, group_id, deleted_at, current_version_id, acl_epoch FROM documents WHERE id = ANY($1)`, [ids])
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        orgId: r.org_id,
        ownerId: r.owner_id,
        scope: r.scope,
        groupId: r.group_id,
        deletedAt: r.deleted_at,
        currentVersionId: r.current_version_id,
        aclEpoch: Number(r.acl_epoch),
      },
    ]),
  )
}

export async function loadLiveAccess(userId: string): Promise<{ user: AccessUser; groups: Set<string> }> {
  const { rows } = await pool.query<{ org_id: string | null; active: boolean; groups: string[] | null }>(
    `SELECT u.org_id, u.active, array_remove(array_agg(gm.group_id), NULL) AS groups
       FROM users u LEFT JOIN group_members gm ON gm.user_id = u.id WHERE u.id = $1 GROUP BY u.id`,
    [userId],
  )
  const r = rows[0]
  return { user: { id: userId, orgId: r?.org_id ?? null, active: r?.active ?? false }, groups: new Set(r?.groups ?? []) }
}

export type Lookup = { status: 'hit'; entry: CachedAnswer } | { status: 'miss' } | { status: 'rejected'; reason: string; documentId: string }

export async function lookupAnswer(orgId: string, userId: string, question: string): Promise<Lookup> {
  const key = cacheKey(orgId, userId, question)
  let raw: string | null
  try {
    raw = await redis.get(key)
  } catch {
    return { status: 'miss' }
  }
  if (!raw) return { status: 'miss' }
  const entry = JSON.parse(raw) as CachedAnswer
  const [truth, live] = await Promise.all([loadDocTruth(entry.context.map((c) => c.documentId)), loadLiveAccess(userId)])
  const v = validateEntry(entry, truth, live.user, live.groups)
  if (v.valid) return { status: 'hit', entry }
  await redis.del(key).catch(() => undefined)
  return { status: 'rejected', reason: v.reason, documentId: v.documentId }
}

export async function storeAnswer(orgId: string, userId: string, entry: CachedAnswer): Promise<void> {
  if (entry.context.length === 0) return
  const key = cacheKey(orgId, userId, entry.question)
  const ttl = config.answers.cacheTtlSeconds
  const multi = redis.multi().set(key, JSON.stringify(entry), 'EX', ttl)
  for (const c of entry.context) multi.sadd(keys.answersByDoc(c.documentId), key).expire(keys.answersByDoc(c.documentId), ttl * 2)
  await multi.exec()
}
