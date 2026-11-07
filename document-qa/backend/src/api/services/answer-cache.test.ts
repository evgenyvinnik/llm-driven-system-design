import { describe, expect, it, vi } from 'vitest'

vi.mock('../../shared/cache.js', () => ({ redis: {}, keys: { answer: (o: string, u: string, h: string) => `dq:ans:${o}:${u}:${h}`, answersByDoc: (d: string) => `dq:ansdoc:${d}` } }))
vi.mock('../../shared/db.js', () => ({ pool: { query: vi.fn() } }))

const { cacheKey, questionHash, validateEntry } = await import('./answer-cache.js')
type Entry = Parameters<typeof validateEntry>[0]
type Truth = Parameters<typeof validateEntry>[1] extends Map<string, infer T> ? T : never

const reader = { id: 'usr_carol', orgId: 'org_acme', active: true }

const entry: Entry = {
  runId: 'run_1',
  question: 'What is the backup retention period?',
  answer: 'Based on your documents: ... [1]',
  sources: [],
  citations: [],
  context: [{ documentId: 'doc_backup', versionId: 'ver_2', aclEpoch: 3 }],
  createdAt: new Date().toISOString(),
}

const doc = (over: Partial<Truth> = {}): Truth => ({
  id: 'doc_backup',
  orgId: 'org_acme',
  ownerId: 'usr_alice',
  scope: 'group',
  groupId: 'grp_eng',
  deletedAt: null,
  currentVersionId: 'ver_2',
  aclEpoch: 3,
  ...over,
})

describe('answer cache validation on read', () => {
  it('serves an entry whose sources are all still readable, current and unchanged', () => {
    expect(validateEntry(entry, new Map([['doc_backup', doc()]]), reader, new Set(['grp_eng']))).toEqual({ valid: true })
  })

  it('rejects an entry citing a deleted (tombstoned) document, even before purge removed it', () => {
    const v = validateEntry(entry, new Map([['doc_backup', doc({ deletedAt: new Date(), aclEpoch: 4 })]]), reader, new Set(['grp_eng']))
    expect(v).toMatchObject({ valid: false, reason: 'a source document was deleted' })
  })

  it('rejects an entry after the document was unshared from the reader', () => {
    const v = validateEntry(entry, new Map([['doc_backup', doc({ scope: 'private', groupId: null, aclEpoch: 4 })]]), reader, new Set(['grp_eng']))
    expect(v).toMatchObject({ valid: false, reason: 'you no longer have access to a source document' })
  })

  it('rejects an entry after the reader was removed from the group (no epoch change at all)', () => {
    const v = validateEntry(entry, new Map([['doc_backup', doc()]]), reader, new Set())
    expect(v).toMatchObject({ valid: false, reason: 'you no longer have access to a source document' })
  })

  it('rejects an entry built from an older version, or under an older access epoch', () => {
    expect(validateEntry(entry, new Map([['doc_backup', doc({ currentVersionId: 'ver_3' })]]), reader, new Set(['grp_eng']))).toMatchObject({ reason: 'a source document has a newer version' })
    expect(validateEntry(entry, new Map([['doc_backup', doc({ aclEpoch: 4, scope: 'org', groupId: null })]]), reader, new Set())).toMatchObject({ reason: 'sharing on a source document changed' })
  })

  it('rejects an entry whose source row is gone entirely', () => {
    expect(validateEntry(entry, new Map(), reader, new Set(['grp_eng']))).toMatchObject({ valid: false, reason: 'a source document no longer exists' })
  })

  it('keys by org, user and normalized question', () => {
    expect(questionHash('What is the backup retention period?')).toBe(questionHash('  what is the BACKUP retention   period  '))
    expect(cacheKey('org_acme', 'usr_carol', 'q')).not.toBe(cacheKey('org_acme', 'usr_alice', 'q'))
  })
})
