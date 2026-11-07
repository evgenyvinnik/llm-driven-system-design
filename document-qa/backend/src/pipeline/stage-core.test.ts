import { describe, expect, it } from 'vitest'
import { chunkId } from '../shared/ids.js'
import { chunkText, type ChunkSpec } from './chunk.js'
import { decideActivation, embedMissing, writeChunks, type ChunkWriter, type EmbedStore, type EmbeddingRow } from './stage-core.js'

/** In-memory stand-in with the same upsert semantics as the SQL (unique on version + ordinal / chunk id). */
class MemoryStore implements ChunkWriter, EmbedStore {
  chunks = new Map<string, { id: string; versionId: string; ordinal: number; text: string; heading: string | null }>()
  embeddings = new Map<string, EmbeddingRow>()
  inserts = 0
  async upsertChunks(versionId: string, rows: ChunkSpec[]) {
    for (const r of rows) {
      this.inserts += 1
      this.chunks.set(`${versionId}:${r.ordinal}`, { id: chunkId(versionId, r.ordinal), versionId, ordinal: r.ordinal, text: r.text, heading: r.heading })
    }
  }
  async deleteChunksFrom(versionId: string, from: number) {
    let n = 0
    for (const [k, c] of this.chunks) {
      if (c.versionId === versionId && c.ordinal >= from) {
        this.chunks.delete(k)
        this.embeddings.delete(c.id)
        n++
      }
    }
    return n
  }
  async missingChunks(versionId: string) {
    return [...this.chunks.values()].filter((c) => c.versionId === versionId && !this.embeddings.has(c.id)).sort((a, b) => a.ordinal - b.ordinal)
  }
  async upsertEmbeddings(rows: EmbeddingRow[]) {
    for (const r of rows) this.embeddings.set(r.chunkId, r)
  }
}

const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} describes the backup schedule in some detail.`).join(' ')
const specs = chunkText(text, [], { targetTokens: 30, overlapTokens: 6 })

describe('chunk stage redo after a crash', () => {
  it('a worker killed after writing half the chunks is redone with no duplicates and the same ids', async () => {
    const store = new MemoryStore()
    await expect(
      writeChunks(store, 'ver_A', specs, 4, async (written, total) => {
        if (written * 2 >= total) throw new Error('worker killed')
      }),
    ).rejects.toThrow('worker killed')
    const partial = [...store.chunks.values()].map((c) => c.id)
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan(specs.length)

    await writeChunks(store, 'ver_A', chunkText(text, [], { targetTokens: 30, overlapTokens: 6 }), 4)
    const ids = [...store.chunks.values()].map((c) => c.id)
    expect(ids).toHaveLength(specs.length)
    expect(new Set(ids).size).toBe(specs.length)
    expect(ids).toEqual(expect.arrayContaining(partial))
  })

  it('trims ordinals past the end when a redo produces fewer chunks', async () => {
    const store = new MemoryStore()
    await writeChunks(store, 'ver_B', specs, 4)
    const { trimmed } = await writeChunks(store, 'ver_B', specs.slice(0, 3), 4)
    expect(trimmed).toBe(specs.length - 3)
    expect(store.chunks.size).toBe(3)
  })
})

describe('embed stage resume', () => {
  it('embeds only what is missing after a crash mid-way, upserting by chunk id', async () => {
    const store = new MemoryStore()
    await writeChunks(store, 'ver_C', specs, 8)
    let calls = 0
    const embed = async (inputs: string[]) => {
      calls += 1
      if (calls === 2) throw new Error('embedder down')
      return { vectors: inputs.map(() => [1, 0]), model: 'm' }
    }
    await expect(embedMissing(store, 'ver_C', 5, embed)).rejects.toThrow('embedder down')
    expect(store.embeddings.size).toBe(5)
    const before = calls
    const r = await embedMissing(store, 'ver_C', 5, embed)
    expect(r.embedded).toBe(specs.length - 5)
    expect(store.embeddings.size).toBe(specs.length)
    expect(calls - before).toBe(Math.ceil((specs.length - 5) / 5))
    expect((await embedMissing(store, 'ver_C', 5, embed)).embedded).toBe(0)
  })
})

describe('version switch rule', () => {
  it('activates a newer version, skips an older or equal one, and never activates on a tombstoned document', () => {
    expect(decideActivation({ deletedAt: null, currentVersionNo: null }, 1)).toBe('activate')
    expect(decideActivation({ deletedAt: null, currentVersionNo: 1 }, 2)).toBe('activate')
    expect(decideActivation({ deletedAt: null, currentVersionNo: 3 }, 2)).toBe('stale')
    expect(decideActivation({ deletedAt: null, currentVersionNo: 2 }, 2)).toBe('stale')
    expect(decideActivation({ deletedAt: new Date(), currentVersionNo: 1 }, 2)).toBe('document_deleted')
  })
})
