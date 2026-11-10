import { describe, expect, it } from 'vitest'
import { accessDecision, readableSql } from './access.js'

const doc = { orgId: 'org_a', ownerId: 'usr_alice', scope: 'private' as const, groupId: null, deletedAt: null }
const carol = { id: 'usr_carol', orgId: 'org_a', active: true }

describe('accessDecision', () => {
  it('private: owner only', () => {
    expect(accessDecision(doc, { ...carol, id: 'usr_alice' }, new Set())).toEqual({ allowed: true })
    expect(accessDecision(doc, carol, new Set())).toEqual({ allowed: false, reason: 'not_owner' })
  })
  it('group: live members only', () => {
    const g = { ...doc, scope: 'group' as const, groupId: 'grp_eng' }
    expect(accessDecision(g, carol, new Set(['grp_eng']))).toEqual({ allowed: true })
    expect(accessDecision(g, carol, new Set(['grp_fin']))).toEqual({ allowed: false, reason: 'not_in_group' })
  })
  it('org: everyone in the tenant, nobody outside it', () => {
    const o = { ...doc, scope: 'org' as const }
    expect(accessDecision(o, carol, new Set())).toEqual({ allowed: true })
    expect(accessDecision(o, { id: 'usr_bob', orgId: 'org_b', active: true }, new Set())).toEqual({ allowed: false, reason: 'other_tenant' })
  })
  it('tombstones and inactive users beat everything, including ownership', () => {
    expect(accessDecision({ ...doc, deletedAt: new Date() }, { ...carol, id: 'usr_alice' }, new Set())).toEqual({ allowed: false, reason: 'deleted' })
    expect(accessDecision({ ...doc, scope: 'org' }, { ...carol, active: false }, new Set())).toEqual({ allowed: false, reason: 'user_inactive' })
  })
  it('renders the same rule as SQL with the caller-chosen placeholders', () => {
    const sql = readableSql('d', '$1', '$2')
    expect(sql).toContain('d.deleted_at IS NULL')
    expect(sql).toContain('gm.user_id = $2')
  })
})
