import { describe, expect, inject, it } from 'vitest'
import { canonicalize, entryHash, GENESIS_HASH, sanitizeForStorage, verifyRows, type AuditContent, type ChainRow } from './audit.js'

function chain(n: number): ChainRow[] {
  const rows: ChainRow[] = []
  let prev = GENESIS_HASH
  for (let i = 1; i <= n; i++) {
    const content: AuditContent = { repoId: 'r', seq: i, prevHash: prev, kind: 'decision', actor: 'worker', prNumber: 1, headSha: 'a'.repeat(40), runId: 'run', decisionId: 'dec', payload: { n: i, nested: { b: 1, a: [1, 2] } }, createdAt: `2026-01-01T00:00:0${i}.000000Z` }
    const hash = entryHash(content)
    rows.push({ ...content, hash })
    prev = hash
  }
  return rows
}
const anchorOf = (rows: ChainRow[]) => ({ lastSeq: rows.length, lastHash: rows[rows.length - 1].hash })

describe('canonicalize', () => {
  it('is independent of key order, at any depth', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } })).toBe(canonicalize({ a: { c: [{ x: 2, y: 1 }], d: 2 }, b: 1 }))
  })
  it('distinguishes types', () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: '1' }))
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]))
  })
  it('drops undefined and keeps null', () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}')
  })
})

describe('verifyRows', () => {
  it('accepts an intact chain', () => {
    const rows = chain(5)
    expect(verifyRows('r', rows, anchorOf(rows))).toEqual({ ok: true, checked: 5, problems: [] })
  })
  it('accepts an empty chain', () => {
    expect(verifyRows('r', [], { lastSeq: 0, lastHash: GENESIS_HASH }).ok).toBe(true)
  })
  it('detects a changed payload', () => {
    const rows = chain(5)
    const anchor = anchorOf(rows)
    rows[2] = { ...rows[2], payload: { n: 999 } }
    const out = verifyRows('r', rows, anchor)
    expect(out.ok).toBe(false)
    expect(out.problems[0]).toMatchObject({ seq: 3, problem: 'hash_mismatch' })
  })
  it.each(['kind', 'actor', 'headSha', 'createdAt'] as const)('detects a changed %s', (field) => {
    const rows = chain(3)
    const anchor = anchorOf(rows)
    rows[1] = { ...rows[1], [field]: 'tampered' }
    expect(verifyRows('r', rows, anchor).problems[0].problem).toBe('hash_mismatch')
  })
  it('detects a rewritten row that also had its hash recomputed, by the broken link after it', () => {
    const rows = chain(4)
    const anchor = anchorOf(rows)
    const { hash: _h, ...content } = rows[1]
    const forged = { ...content, payload: { forged: true } }
    rows[1] = { ...forged, hash: entryHash(forged) }
    const out = verifyRows('r', rows, anchor)
    expect(out.problems.some((p) => p.problem === 'broken_link' && p.seq === 3)).toBe(true)
  })
  it('detects a deleted row', () => {
    const rows = chain(5)
    const anchor = anchorOf(rows)
    rows.splice(2, 1)
    const out = verifyRows('r', rows, anchor)
    expect(out.problems.some((p) => p.problem === 'gap')).toBe(true)
    expect(out.problems.some((p) => p.problem === 'broken_link')).toBe(true)
  })
  it('detects a truncated tail through the anchor alone', () => {
    const rows = chain(5)
    const anchor = anchorOf(rows)
    const out = verifyRows('r', rows.slice(0, 3), anchor)
    expect(out.problems.map((p) => p.problem)).toEqual(['anchor_mismatch'])
  })
  it('detects a changed first row, whose link is the genesis hash', () => {
    const rows = chain(2)
    const anchor = anchorOf(rows)
    rows[0] = { ...rows[0], prevHash: 'f'.repeat(64) }
    expect(verifyRows('r', rows, anchor).ok).toBe(false)
  })
})

describe('sanitizeForStorage', () => {
  it('replaces NUL at any depth, including keys', () => {
    expect(sanitizeForStorage({ 'a\u0000': ['b\u0000', { c: 'd\u0000' }] })).toEqual({ 'a\ufffd': ['b\ufffd', { c: 'd\ufffd' }] })
  })
  it('leaves other values alone', () => {
    expect(sanitizeForStorage({ a: 1, b: null, c: true })).toEqual({ a: 1, b: null, c: true })
  })
})

describe.skipIf(!inject('dbReady'))('the chain in PostgreSQL', () => {
  it('appends, verifies, refuses changes, and detects tampering', async () => {
    const { pool, withTransaction } = await import('./db.js')
    const { appendAudit, verifyChain } = await import('./audit.js')
    const { freshWorld, REPO_ID } = await import('../test-support/world.js')
    await freshWorld()
    await withTransaction(async (tx) => {
      for (let i = 0; i < 4; i++) await appendAudit(tx, { repoId: REPO_ID, kind: 'decision', actor: 'worker', payload: { i, text: 'nul\u0000inside', z: 1, a: 2 } })
    })
    expect(await verifyChain(pool, REPO_ID)).toMatchObject({ ok: true, checked: 4 })

    await expect(pool.query(`UPDATE audit_log SET actor = 'x' WHERE repo_id = $1 AND seq = 2`, [REPO_ID])).rejects.toThrow(/append-only/)
    await expect(pool.query(`DELETE FROM audit_log WHERE repo_id = $1 AND seq = 2`, [REPO_ID])).rejects.toThrow(/append-only/)

    await pool.query(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_change`)
    try {
      await pool.query(`UPDATE audit_log SET payload = '{"i":99}' WHERE repo_id = $1 AND seq = 2`, [REPO_ID])
      const out = await verifyChain(pool, REPO_ID)
      expect(out.ok).toBe(false)
      expect(out.problems[0]).toMatchObject({ seq: 2, problem: 'hash_mismatch' })
    } finally {
      await pool.query(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_change`)
    }
  })
})
