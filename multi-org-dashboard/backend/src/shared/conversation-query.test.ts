import { describe, expect, it } from 'vitest'
import { buildConversationWhere, decodeCursor, encodeCursor } from './conversation-query.js'

const PROJECT = '0b7c2f4e-9a51-4a0e-8f3d-2c6b1e5d7a90'

describe('buildConversationWhere', () => {
  it('always starts with the org and the caller’s projects, whatever the filters', () => {
    const { where, params } = buildConversationWhere('org_lumen', [PROJECT], {})
    expect(where).toBe('c.org_id = $1 AND c.project_id = ANY($2::uuid[])')
    expect(params).toEqual(['org_lumen', [PROJECT]])
  })

  it('cannot widen access through a projectId filter: it is ANDed with the access list', () => {
    const { where } = buildConversationWhere('org_lumen', [PROJECT], { projectId: '11111111-1111-4111-8111-111111111111' })
    expect(where).toContain('c.project_id = ANY($2::uuid[])')
    expect(where).toContain('c.project_id = $3')
  })

  it('escapes LIKE wildcards in search', () => {
    const { params } = buildConversationWhere('org_lumen', [PROJECT], { q: '100%_off' })
    expect(params[2]).toBe('%100\\%\\_off%')
  })

  it('adds the keyset condition last', () => {
    const cursor = { startedAt: '2026-10-01T00:00:00.000Z', id: PROJECT }
    const { where, params } = buildConversationWhere('org_lumen', [PROJECT], { status: 'open' }, cursor)
    expect(where.endsWith('(c.started_at, c.id) < ($4::timestamptz, $5::uuid)')).toBe(true)
    expect(params.slice(3)).toEqual([cursor.startedAt, cursor.id])
  })
})

describe('cursors', () => {
  it('round-trip', () => {
    const cursor = { startedAt: '2026-10-01T12:34:56.789Z', id: PROJECT }
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  it('reject tampering with a 400', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrowError(/cursor/)
    const forged = Buffer.from(JSON.stringify(['yesterday', "1' OR 1=1"])).toString('base64url')
    expect(() => decodeCursor(forged)).toThrowError(/cursor/)
  })
})
