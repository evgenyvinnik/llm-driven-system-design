import { beforeEach, describe, expect, it } from 'vitest'
import { createStore } from '../subject.js'

let fs: Awaited<ReturnType<typeof createStore>>

beforeEach(async () => {
  fs = await createStore()
})

describe('level 1: addFile and getSize', () => {
  it('creates a file and reads its size back', async () => {
    expect(await fs.addFile('/docs/a.txt', 100)).toBe(true)
    expect(await fs.getSize('/docs/a.txt')).toBe(100)
  })

  it('allows a zero-byte file', async () => {
    expect(await fs.addFile('/empty', 0)).toBe(true)
    expect(await fs.getSize('/empty')).toBe(0)
  })

  it('refuses a path that is already a file and keeps the original size', async () => {
    await fs.addFile('/a.txt', 10)
    expect(await fs.addFile('/a.txt', 99)).toBe(false)
    expect(await fs.getSize('/a.txt')).toBe(10)
  })

  it('refuses a path that is an existing directory', async () => {
    await fs.addFile('/docs/a.txt', 10)
    expect(await fs.addFile('/docs', 5)).toBe(false)
    expect(await fs.getSize('/docs')).toBeNull()
  })

  it('refuses a path below a file, at any depth', async () => {
    await fs.addFile('/docs/a.txt', 10)
    expect(await fs.addFile('/docs/a.txt/x', 5)).toBe(false)
    expect(await fs.addFile('/docs/a.txt/x/y/z', 5)).toBe(false)
    expect(await fs.getSize('/docs/a.txt/x')).toBeNull()
  })

  it('does not confuse siblings that share a string prefix', async () => {
    expect(await fs.addFile('/a/bc', 1)).toBe(true)
    expect(await fs.addFile('/a/b/x', 2)).toBe(true)
    expect(await fs.addFile('/a/b', 3)).toBe(false)
    expect(await fs.getSize('/a/bc')).toBe(1)
  })

  it('returns null for missing files, directories and the root', async () => {
    await fs.addFile('/docs/a.txt', 10)
    expect(await fs.getSize('/nope')).toBeNull()
    expect(await fs.getSize('/docs')).toBeNull()
    expect(await fs.getSize('/')).toBeNull()
  })
})

describe('level 1: updateFile', () => {
  it('returns the previous size and stores the new one', async () => {
    await fs.addFile('/a.txt', 100)
    expect(await fs.updateFile('/a.txt', 250)).toBe(100)
    expect(await fs.getSize('/a.txt')).toBe(250)
    expect(await fs.updateFile('/a.txt', 0)).toBe(250)
    expect(await fs.getSize('/a.txt')).toBe(0)
  })

  it('returns null for a missing file and does not create it', async () => {
    expect(await fs.updateFile('/ghost', 5)).toBeNull()
    expect(await fs.getSize('/ghost')).toBeNull()
  })

  it('returns null for a directory', async () => {
    await fs.addFile('/docs/a.txt', 10)
    expect(await fs.updateFile('/docs', 5)).toBeNull()
  })
})

describe('level 1: deleteFile', () => {
  it('returns the size and removes the file', async () => {
    await fs.addFile('/a.txt', 42)
    expect(await fs.deleteFile('/a.txt')).toBe(42)
    expect(await fs.getSize('/a.txt')).toBeNull()
    expect(await fs.deleteFile('/a.txt')).toBeNull()
  })

  it('returns null for a directory and leaves its files alone', async () => {
    await fs.addFile('/docs/a.txt', 10)
    expect(await fs.deleteFile('/docs')).toBeNull()
    expect(await fs.getSize('/docs/a.txt')).toBe(10)
  })

  it('makes a directory disappear with its last file', async () => {
    await fs.addFile('/docs/a.txt', 1)
    await fs.addFile('/docs/b.txt', 2)
    await fs.deleteFile('/docs/a.txt')
    expect(await fs.addFile('/docs', 5)).toBe(false)
    await fs.deleteFile('/docs/b.txt')
    expect(await fs.addFile('/docs', 5)).toBe(true)
  })

  it('frees a file path for a directory once the file is deleted', async () => {
    await fs.addFile('/x', 1)
    await fs.deleteFile('/x')
    expect(await fs.addFile('/x/y', 2)).toBe(true)
  })
})

describe('level 1: the worked example in levels.md', () => {
  it('matches every row', async () => {
    expect(await fs.addFile('/docs/a.txt', 100)).toBe(true)
    expect(await fs.addFile('/docs/a.txt', 5)).toBe(false)
    expect(await fs.addFile('/docs', 5)).toBe(false)
    expect(await fs.addFile('/docs/a.txt/x', 5)).toBe(false)
    expect(await fs.getSize('/docs')).toBeNull()
    expect(await fs.updateFile('/docs/a.txt', 250)).toBe(100)
    expect(await fs.deleteFile('/docs/a.txt')).toBe(250)
    expect(await fs.addFile('/docs', 5)).toBe(true)
  })
})
