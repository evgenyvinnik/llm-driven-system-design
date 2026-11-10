import { describe, expect, it, vi } from 'vitest'

vi.mock('../../shared/db.js', () => ({ withSnapshot: vi.fn(), pool: { query: vi.fn() } }))

const { ftsQuery, fuse, relevant } = await import('./retrieval.js')

const hit = (id: string, similarity: number) => ({ chunk_id: id, document_id: 'd', version_id: 'v', scope: 'org', group_id: null, acl_epoch: '1', similarity, rank: 0.1 })

describe('retrieval helpers', () => {
  it('builds an OR full-text query from content words only', () => {
    expect(ftsQuery('What is the backup retention period?')).toBe('backup | retention | period')
    expect(ftsQuery('is the')).toBe('')
  })

  it('fuses the vector and keyword arms with reciprocal rank fusion', () => {
    const fused = fuse([hit('a', 0.9), hit('b', 0.8)], [hit('b', 0.8), hit('c', 0.3)])
    expect(fused.map((c) => c.chunkId)).toEqual(['b', 'a', 'c'])
    expect(fused[0].via).toEqual(['vector', 'fts'])
  })

  it('keeps keyword hits at a lower similarity bar than vector-only hits', () => {
    const [vOnly] = fuse([hit('a', 0.15)], [])
    const [both] = fuse([], [hit('b', 0.15)])
    expect(relevant(vOnly, 0.2)).toBe(false)
    expect(relevant(both, 0.2)).toBe(true)
  })
})
