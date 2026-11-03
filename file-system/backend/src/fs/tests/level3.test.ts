import { beforeEach, describe, expect, it } from 'vitest'
import { createStore } from '../subject.js'

let fs: Awaited<ReturnType<typeof createStore>>

beforeEach(async () => {
  fs = await createStore()
})

describe('level 3: addUser and getRemaining', () => {
  it('creates a user once', async () => {
    expect(await fs.addUser('ana', 100)).toBe(true)
    expect(await fs.addUser('ana', 500)).toBe(false)
    expect(await fs.getRemaining('ana')).toBe(100)
  })

  it('returns null for an unknown user', async () => {
    expect(await fs.getRemaining('nobody')).toBeNull()
  })
})

describe('level 3: addFileAs', () => {
  beforeEach(async () => {
    await fs.addUser('ana', 100)
  })

  it('returns the remaining capacity after each write', async () => {
    expect(await fs.addFileAs('ana', '/ana/a', 60)).toBe(40)
    expect(await fs.addFileAs('ana', '/ana/b', 40)).toBe(0)
    expect(await fs.getRemaining('ana')).toBe(0)
    expect(await fs.getSize('/ana/b')).toBe(40)
  })

  it('refuses a write that would exceed capacity and stores nothing', async () => {
    await fs.addFileAs('ana', '/ana/a', 60)
    expect(await fs.addFileAs('ana', '/ana/b', 41)).toBeNull()
    expect(await fs.getSize('/ana/b')).toBeNull()
    expect(await fs.getRemaining('ana')).toBe(40)
  })

  it('returns null for an unknown user and stores nothing', async () => {
    expect(await fs.addFileAs('ghost', '/g', 1)).toBeNull()
    expect(await fs.getSize('/g')).toBeNull()
  })

  it('applies the level 1 placement rules and charges nothing on failure', async () => {
    await fs.addFile('/taken', 1)
    await fs.addFile('/dir/f', 1)
    expect(await fs.addFileAs('ana', '/taken', 5)).toBeNull()
    expect(await fs.addFileAs('ana', '/dir', 5)).toBeNull()
    expect(await fs.addFileAs('ana', '/taken/below', 5)).toBeNull()
    expect(await fs.getRemaining('ana')).toBe(100)
  })

  it('leaves unowned files out of every quota', async () => {
    await fs.addFile('/big', 10_000)
    expect(await fs.getRemaining('ana')).toBe(100)
    expect(await fs.updateFile('/big', 20_000)).toBe(10_000)
  })
})

describe('level 3: earlier methods respect quotas', () => {
  beforeEach(async () => {
    await fs.addUser('ana', 100)
    await fs.addFileAs('ana', '/ana/a', 60)
  })

  it('lets updateFile grow an owned file within capacity', async () => {
    expect(await fs.updateFile('/ana/a', 100)).toBe(60)
    expect(await fs.getRemaining('ana')).toBe(0)
  })

  it('makes updateFile fail, changing nothing, when growth would exceed capacity', async () => {
    expect(await fs.updateFile('/ana/a', 101)).toBeNull()
    expect(await fs.getSize('/ana/a')).toBe(60)
    expect(await fs.getRemaining('ana')).toBe(40)
  })

  it('always lets updateFile shrink an owned file', async () => {
    expect(await fs.updateFile('/ana/a', 5)).toBe(60)
    expect(await fs.getRemaining('ana')).toBe(95)
  })

  it('frees the owner\'s bytes on deleteFile', async () => {
    expect(await fs.deleteFile('/ana/a')).toBe(60)
    expect(await fs.getRemaining('ana')).toBe(100)
  })
})

describe('level 3: mergeUsers', () => {
  beforeEach(async () => {
    await fs.addUser('ana', 100)
    await fs.addUser('ben', 30)
    await fs.addFileAs('ana', '/ana/a', 60)
    await fs.addFileAs('ben', '/ben/x', 10)
  })

  it('combines capacity and usage and returns the target\'s remaining capacity', async () => {
    expect(await fs.mergeUsers('ana', 'ben')).toBe(60)
    expect(await fs.getRemaining('ana')).toBe(60)
  })

  it('deletes the source, which can then be created again', async () => {
    await fs.mergeUsers('ana', 'ben')
    expect(await fs.getRemaining('ben')).toBeNull()
    expect(await fs.addFileAs('ben', '/ben/y', 1)).toBeNull()
    expect(await fs.addUser('ben', 5)).toBe(true)
    expect(await fs.getRemaining('ben')).toBe(5)
  })

  it('moves ownership of the source\'s files to the target', async () => {
    await fs.mergeUsers('ana', 'ben')
    expect(await fs.getSize('/ben/x')).toBe(10)
    // The file now charges ana: growing it uses ana's capacity, deleting it frees ana's bytes.
    expect(await fs.updateFile('/ben/x', 70)).toBe(10)
    expect(await fs.getRemaining('ana')).toBe(0)
    expect(await fs.updateFile('/ben/x', 71)).toBeNull()
    await fs.deleteFile('/ben/x')
    expect(await fs.getRemaining('ana')).toBe(70)
  })

  it('does not move another user\'s files or unowned files', async () => {
    await fs.addUser('cy', 50)
    await fs.addFileAs('cy', '/cy/c', 20)
    await fs.addFile('/shared', 5)
    await fs.mergeUsers('ana', 'ben')
    expect(await fs.getRemaining('cy')).toBe(30)
    expect(await fs.updateFile('/shared', 9_999)).toBe(5)
    expect(await fs.getRemaining('ana')).toBe(60)
  })

  it('returns null for a missing user or the same user, changing nothing', async () => {
    expect(await fs.mergeUsers('ana', 'ghost')).toBeNull()
    expect(await fs.mergeUsers('ghost', 'ana')).toBeNull()
    expect(await fs.mergeUsers('ana', 'ana')).toBeNull()
    expect(await fs.getRemaining('ana')).toBe(40)
    expect(await fs.getRemaining('ben')).toBe(20)
  })
})

describe('level 3: the worked example in levels.md', () => {
  it('matches every row', async () => {
    expect(await fs.addUser('ana', 100)).toBe(true)
    expect(await fs.addFileAs('ana', '/ana/a', 60)).toBe(40)
    expect(await fs.addFileAs('ana', '/ana/b', 50)).toBeNull()
    expect(await fs.updateFile('/ana/a', 120)).toBeNull()
    expect(await fs.getSize('/ana/a')).toBe(60)
    expect(await fs.addUser('ben', 30)).toBe(true)
    expect(await fs.addFileAs('ben', '/ben/x', 10)).toBe(20)
    expect(await fs.mergeUsers('ana', 'ben')).toBe(60)
    expect(await fs.getRemaining('ben')).toBeNull()
  })
})
