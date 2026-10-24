/**
 * Checks the *cost* constraint of the dedup answer, which the portable tests in
 * ./tests can't see: unique sizes are never read, and small files are never
 * hashed twice.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanDuplicates } from './dedup.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dedup-cost-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('dedup cost', () => {
  it('never reads a file whose size is unique', async () => {
    await writeFile(join(root, 'big'), Buffer.alloc(1_000_000, 1))
    await writeFile(join(root, 'small'), 'x')
    const { stats } = await scanDuplicates(root)
    expect(stats).toMatchObject({ files: 2, sizeCandidates: 0, headHashed: 0, fullHashed: 0, bytesRead: 0 })
  })

  it('stops after the head hash for files no bigger than 4 KB', async () => {
    await writeFile(join(root, 'a'), 'same')
    await writeFile(join(root, 'b'), 'same')
    const { groups, stats } = await scanDuplicates(root)
    expect(groups).toHaveLength(1)
    expect(stats).toMatchObject({ headHashed: 2, fullHashed: 0, bytesRead: 8 })
  })

  it('fully hashes only the large files whose heads tie', async () => {
    const head = Buffer.alloc(4096, 3)
    await writeFile(join(root, 'p'), Buffer.concat([head, Buffer.from('1')]))
    await writeFile(join(root, 'q'), Buffer.concat([head, Buffer.from('1')]))
    await writeFile(join(root, 'r'), Buffer.concat([Buffer.alloc(4096, 4), Buffer.from('1')]))
    const { groups, stats } = await scanDuplicates(root)
    expect(groups).toHaveLength(1)
    expect(stats).toMatchObject({ sizeCandidates: 3, headHashed: 3, fullHashed: 2 })
  })
})
