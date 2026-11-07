import { describe, expect, it } from 'vitest'
import { recheck, summarizeDrops, type Candidate, type TruthRow } from './recheck.js'

const user = { id: 'usr_carol', orgId: 'org_acme', active: true }

function cand(chunkId: string, over: Partial<Candidate> = {}): Candidate {
  return { chunkId, documentId: 'doc_1', versionId: 'ver_1', similarity: 0.5, ftsRank: null, fused: 0.01, via: ['vector'], indexScope: 'group', indexGroupId: 'grp_eng', indexAclEpoch: 1, ...over }
}

function truth(chunkId: string, over: Partial<TruthRow> = {}): TruthRow {
  return {
    chunkId,
    versionId: 'ver_1',
    versionNo: 1,
    documentId: 'doc_1',
    ordinal: 0,
    text: 'text',
    charStart: 0,
    charEnd: 4,
    heading: null,
    title: 'Runbook',
    orgId: 'org_acme',
    ownerId: 'usr_alice',
    scope: 'group',
    groupId: 'grp_eng',
    deletedAt: null,
    currentVersionId: 'ver_1',
    aclEpoch: 1,
    ...over,
  }
}

describe('recheck', () => {
  it('keeps a candidate the truth allows', () => {
    const r = recheck([cand('c1')], new Map([['c1', truth('c1')]]), user, new Set(['grp_eng']))
    expect(r.kept.map((k) => k.candidate.chunkId)).toEqual(['c1'])
    expect(r.dropped).toEqual([])
  })

  it('drops a group document after the user left the group, although the index row still says group-shared', () => {
    const r = recheck([cand('c1')], new Map([['c1', truth('c1')]]), user, new Set())
    expect(r.kept).toEqual([])
    expect(r.dropped[0]).toMatchObject({ reason: 'not_in_group', staleIndex: false })
  })

  it('drops an unshared document and flags the index row as stale', () => {
    const t = truth('c1', { scope: 'private', groupId: null, aclEpoch: 2 })
    const r = recheck([cand('c1')], new Map([['c1', t]]), user, new Set(['grp_eng']))
    expect(r.dropped[0]).toMatchObject({ reason: 'not_owner', staleIndex: true })
  })

  it('drops tombstoned documents, purged chunks, other tenants and inactive users', () => {
    const t = new Map([
      ['del', truth('del', { deletedAt: new Date() })],
      ['other', truth('other', { orgId: 'org_globex', scope: 'org', groupId: null })],
    ])
    const r = recheck([cand('del'), cand('gone'), cand('other')], t, user, new Set(['grp_eng']))
    expect(r.dropped.map((d) => d.reason)).toEqual(['deleted', 'chunk_missing', 'other_tenant'])
    const inactive = recheck([cand('del')], new Map([['del', truth('del')]]), { ...user, active: false }, new Set(['grp_eng']))
    expect(inactive.dropped[0].reason).toBe('user_inactive')
  })

  it('never mixes versions: only chunks of the current version survive', () => {
    const t = new Map([
      ['old', truth('old', { versionId: 'ver_1', currentVersionId: 'ver_2' })],
      ['new', truth('new', { versionId: 'ver_2', versionNo: 2, currentVersionId: 'ver_2' })],
      ['next', truth('next', { versionId: 'ver_3', versionNo: 3, currentVersionId: 'ver_2' })],
    ])
    const r = recheck([cand('old'), cand('new', { versionId: 'ver_2' }), cand('next', { versionId: 'ver_3' })], t, user, new Set(['grp_eng']))
    expect(r.kept.map((k) => k.truth.versionId)).toEqual(['ver_2'])
    expect(r.dropped.map((d) => d.reason)).toEqual(['not_current_version', 'not_current_version'])
  })

  it('lets the owner and org-wide readers through regardless of groups', () => {
    const t = new Map([
      ['own', truth('own', { ownerId: 'usr_carol', scope: 'private', groupId: null })],
      ['org', truth('org', { scope: 'org', groupId: null })],
    ])
    const r = recheck([cand('own'), cand('org')], t, user, new Set())
    expect(r.kept).toHaveLength(2)
  })

  it('summarizes drops by reason', () => {
    const r = recheck([cand('a'), cand('b')], new Map(), user, new Set())
    expect(summarizeDrops(r.dropped)).toEqual([{ reason: 'chunk_missing', count: 2, staleIndex: 2 }])
  })
})
