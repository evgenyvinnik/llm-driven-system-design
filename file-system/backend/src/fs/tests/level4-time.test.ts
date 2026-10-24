import { beforeEach, describe, expect, it } from 'vitest'
import type { FileStore } from '../file-store.js'
import { createStore } from '../subject.js'

// The time track is in-memory only: the PostgreSQL backend implements levels 1-3 and backup.
const skip = process.env.FS_STORE === 'postgres'

let fs: FileStore

beforeEach(async () => {
  fs = (await createStore()) as FileStore
})

describe.skipIf(skip)('level 4 (time): setTime', () => {
  it('moves forward, allows the same time again, and refuses to go back', async () => {
    expect(await fs.setTime(5)).toBe(true)
    expect(await fs.setTime(5)).toBe(true)
    expect(await fs.setTime(4)).toBe(false)
  })

  it('leaves the clock where it was after a refused move', async () => {
    await fs.setTime(10)
    await fs.addFile('/t', 1, 5)
    await fs.setTime(3)
    await fs.setTime(14)
    expect(await fs.getSize('/t')).toBe(1)
  })
})

describe.skipIf(skip)('level 4 (time): time to live', () => {
  it('keeps a file live through c + ttl - 1 and expires it at c + ttl', async () => {
    await fs.setTime(10)
    expect(await fs.addFile('/t', 5, 20)).toBe(true)
    await fs.setTime(29)
    expect(await fs.getSize('/t')).toBe(5)
    await fs.setTime(30)
    expect(await fs.getSize('/t')).toBeNull()
  })

  it('never expires a file added without a ttl', async () => {
    await fs.addFile('/forever', 1)
    await fs.setTime(1_000_000)
    expect(await fs.getSize('/forever')).toBe(1)
  })

  it('frees the path, and its directories, when a file expires', async () => {
    await fs.addFile('/d/t', 1, 5)
    await fs.setTime(5)
    expect(await fs.addFile('/d/t', 2)).toBe(true)
    await fs.deleteFile('/d/t')
    expect(await fs.addFile('/d', 3)).toBe(true)
  })

  it('removes expired files from every query', async () => {
    await fs.addFile('/d/keep', 10)
    await fs.addFile('/d/gone', 99, 3)
    await fs.addFile('/e/only', 5, 3)
    await fs.setTime(3)
    expect(await fs.listDir('/d')).toEqual(['keep'])
    expect(await fs.listDir('/e')).toBeNull()
    expect(await fs.dirSize('/')).toBe(10)
    expect(await fs.largest('/', 5)).toEqual(['/d/keep(10)'])
    expect(await fs.updateFile('/d/gone', 1)).toBeNull()
    expect(await fs.deleteFile('/d/gone')).toBeNull()
  })

  it('frees the owner\'s bytes when an owned file expires', async () => {
    await fs.addUser('ana', 100)
    expect(await fs.addFileAs('ana', '/ana/tmp', 70, 10)).toBe(30)
    await fs.setTime(10)
    expect(await fs.getRemaining('ana')).toBe(100)
  })

  it('keeps the expiry when a file is updated', async () => {
    await fs.addFile('/t', 1, 10)
    await fs.setTime(5)
    await fs.updateFile('/t', 2)
    await fs.setTime(10)
    expect(await fs.getSize('/t')).toBeNull()
  })

  it('expires several files in one jump of the clock', async () => {
    await fs.addFile('/a', 1, 2)
    await fs.addFile('/b', 1, 4)
    await fs.addFile('/c', 1, 100)
    await fs.setTime(50)
    expect(await fs.listDir('/')).toEqual(['c'])
  })
})

describe.skipIf(skip)('level 4 (time): getSizeAt', () => {
  it('answers for every past version', async () => {
    await fs.setTime(10)
    await fs.addFile('/f', 1)
    await fs.setTime(20)
    await fs.updateFile('/f', 2)
    await fs.setTime(30)
    await fs.deleteFile('/f')
    await fs.setTime(40)
    expect(await fs.getSizeAt('/f', 9)).toBeNull()
    expect(await fs.getSizeAt('/f', 10)).toBe(1)
    expect(await fs.getSizeAt('/f', 19)).toBe(1)
    expect(await fs.getSizeAt('/f', 20)).toBe(2)
    expect(await fs.getSizeAt('/f', 29)).toBe(2)
    expect(await fs.getSizeAt('/f', 30)).toBeNull()
    expect(await fs.getSizeAt('/f', 40)).toBeNull()
  })

  it('reports the state after every operation at the same time', async () => {
    await fs.setTime(7)
    await fs.addFile('/u', 1)
    await fs.updateFile('/u', 3)
    await fs.addFile('/v', 1)
    await fs.deleteFile('/v')
    expect(await fs.getSizeAt('/u', 7)).toBe(3)
    expect(await fs.getSizeAt('/v', 7)).toBeNull()
  })

  it('keeps history across expiry and re-creation of the same path', async () => {
    await fs.addFile('/r', 5, 10)
    await fs.setTime(12)
    await fs.addFile('/r', 8)
    expect(await fs.getSizeAt('/r', 9)).toBe(5)
    expect(await fs.getSizeAt('/r', 10)).toBeNull()
    expect(await fs.getSizeAt('/r', 11)).toBeNull()
    expect(await fs.getSizeAt('/r', 12)).toBe(8)
  })

  it('returns null for a path that never held a file', async () => {
    await fs.addFile('/d/f', 1)
    expect(await fs.getSizeAt('/d', 0)).toBeNull()
    expect(await fs.getSizeAt('/nope', 0)).toBeNull()
  })
})

describe.skipIf(skip)('level 4 (time): the worked example in levels.md', () => {
  it('matches every row', async () => {
    expect(await fs.setTime(10)).toBe(true)
    expect(await fs.addFile('/t', 5, 20)).toBe(true)
    expect(await fs.setTime(15)).toBe(true)
    expect(await fs.updateFile('/t', 8)).toBe(5)
    expect(await fs.setTime(30)).toBe(true)
    expect(await fs.getSize('/t')).toBeNull()
    expect(await fs.getSizeAt('/t', 12)).toBe(5)
    expect(await fs.getSizeAt('/t', 29)).toBe(8)
    expect(await fs.getSizeAt('/t', 30)).toBeNull()
    expect(await fs.addFile('/t', 1)).toBe(true)
    expect(await fs.setTime(20)).toBe(false)
  })
})
