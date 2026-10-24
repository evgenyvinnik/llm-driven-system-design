import { beforeEach, describe, expect, it } from 'vitest'
import { createStore } from '../subject.js'

let fs: Awaited<ReturnType<typeof createStore>>

beforeEach(async () => {
  fs = await createStore()
})

describe('level 2: listDir', () => {
  it('lists an empty root as an empty list', async () => {
    expect(await fs.listDir('/')).toEqual([])
  })

  it('returns null for a missing directory and for a file', async () => {
    await fs.addFile('/docs/a.txt', 1)
    expect(await fs.listDir('/nope')).toBeNull()
    expect(await fs.listDir('/docs/a.txt')).toBeNull()
  })

  it('lists direct children only, each subdirectory once, with a trailing slash', async () => {
    await fs.addFile('/home/ana/a.txt', 1)
    await fs.addFile('/home/ana/deep/b.txt', 1)
    await fs.addFile('/home/ben/c.txt', 1)
    await fs.addFile('/home/readme', 1)
    expect(await fs.listDir('/')).toEqual(['home/'])
    expect(await fs.listDir('/home')).toEqual(['ana/', 'ben/', 'readme'])
    expect(await fs.listDir('/home/ana')).toEqual(['a.txt', 'deep/'])
  })

  it('sorts by the name without its slash, in code-unit order', async () => {
    await fs.addFile('/a/b.txt', 1)
    await fs.addFile('/a/b/c.txt', 1)
    await fs.addFile('/a/bc.txt', 1)
    await fs.addFile('/a/B', 1)
    await fs.addFile('/a/_x', 1)
    // "B" (0x42) < "_" (0x5F) < "b" (0x62), and "b" < "b.txt" < "bc.txt".
    expect(await fs.listDir('/a')).toEqual(['B', '_x', 'b/', 'b.txt', 'bc.txt'])
  })

  it('stops listing a directory once its last file is gone', async () => {
    await fs.addFile('/a/b/c.txt', 1)
    await fs.addFile('/a/d.txt', 1)
    await fs.deleteFile('/a/b/c.txt')
    expect(await fs.listDir('/a/b')).toBeNull()
    expect(await fs.listDir('/a')).toEqual(['d.txt'])
  })
})

describe('level 2: dirSize', () => {
  it('sums every file below a directory, recursively', async () => {
    await fs.addFile('/a/x', 10)
    await fs.addFile('/a/b/y', 20)
    await fs.addFile('/a/b/c/z', 30)
    await fs.addFile('/other', 7)
    expect(await fs.dirSize('/a')).toBe(60)
    expect(await fs.dirSize('/a/b')).toBe(50)
    expect(await fs.dirSize('/')).toBe(67)
  })

  it('is directory-aware: /a/b does not include /a/bc', async () => {
    await fs.addFile('/a/b/c.txt', 30)
    await fs.addFile('/a/bc.txt', 30)
    expect(await fs.dirSize('/a/b')).toBe(30)
  })

  it('returns 0 for an empty root and null for files and missing paths', async () => {
    expect(await fs.dirSize('/')).toBe(0)
    await fs.addFile('/f', 3)
    expect(await fs.dirSize('/f')).toBeNull()
    expect(await fs.dirSize('/nope')).toBeNull()
  })

  it('follows updates and deletes', async () => {
    await fs.addFile('/d/a', 10)
    await fs.addFile('/d/b', 10)
    await fs.updateFile('/d/a', 25)
    await fs.deleteFile('/d/b')
    expect(await fs.dirSize('/d')).toBe(25)
  })
})

describe('level 2: largest', () => {
  beforeEach(async () => {
    await fs.addFile('/a/b.txt', 10)
    await fs.addFile('/a/b/c.txt', 30)
    await fs.addFile('/a/bc.txt', 30)
    await fs.addFile('/a/zero', 0)
    await fs.addFile('/z/big', 500)
  })

  it('sorts by size descending, then by path, and formats path(size)', async () => {
    expect(await fs.largest('/a', 10)).toEqual(['/a/b/c.txt(30)', '/a/bc.txt(30)', '/a/b.txt(10)', '/a/zero(0)'])
  })

  it('matches the prefix as a plain string, not a directory', async () => {
    expect(await fs.largest('/a/b', 5)).toEqual(['/a/b/c.txt(30)', '/a/bc.txt(30)', '/a/b.txt(10)'])
    expect(await fs.largest('/a/b/', 5)).toEqual(['/a/b/c.txt(30)'])
  })

  it('returns at most n results', async () => {
    expect(await fs.largest('/', 2)).toEqual(['/z/big(500)', '/a/b/c.txt(30)'])
    expect(await fs.largest('/a', 1)).toEqual(['/a/b/c.txt(30)'])
  })

  it('returns an empty list for n <= 0 and for an unmatched prefix', async () => {
    expect(await fs.largest('/', 0)).toEqual([])
    expect(await fs.largest('/', -3)).toEqual([])
    expect(await fs.largest('/zzz', 5)).toEqual([])
  })

  it('reflects updates and deletes', async () => {
    await fs.updateFile('/a/b.txt', 1000)
    await fs.deleteFile('/z/big')
    expect(await fs.largest('/', 2)).toEqual(['/a/b.txt(1000)', '/a/b/c.txt(30)'])
  })
})

describe('level 2: the worked example in levels.md', () => {
  it('matches every row', async () => {
    expect(await fs.addFile('/a/b.txt', 10)).toBe(true)
    expect(await fs.addFile('/a/b/c.txt', 30)).toBe(true)
    expect(await fs.addFile('/a/bc.txt', 30)).toBe(true)
    expect(await fs.listDir('/a')).toEqual(['b/', 'b.txt', 'bc.txt'])
    expect(await fs.listDir('/a/b.txt')).toBeNull()
    expect(await fs.dirSize('/a/b')).toBe(30)
    expect(await fs.largest('/a/b', 2)).toEqual(['/a/b/c.txt(30)', '/a/bc.txt(30)'])
    expect(await fs.largest('/zzz', 5)).toEqual([])
  })
})
