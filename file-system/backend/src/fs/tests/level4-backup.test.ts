import { beforeEach, describe, expect, it } from 'vitest'
import { createStore } from '../subject.js'

let fs: Awaited<ReturnType<typeof createStore>>

beforeEach(async () => {
  fs = await createStore()
  await fs.addUser('ana', 100)
})

describe('level 4 (backup): backupUser', () => {
  it('returns the number of files backed up, or null for an unknown user', async () => {
    expect(await fs.backupUser('ana')).toBe(0)
    await fs.addFileAs('ana', '/p/a', 10)
    await fs.addFileAs('ana', '/p/b', 20)
    expect(await fs.backupUser('ana')).toBe(2)
    expect(await fs.backupUser('ghost')).toBeNull()
  })

  it('counts only the user\'s own files', async () => {
    await fs.addUser('ben', 100)
    await fs.addFileAs('ana', '/p/a', 10)
    await fs.addFileAs('ben', '/p/b', 10)
    await fs.addFile('/p/c', 10)
    expect(await fs.backupUser('ana')).toBe(1)
  })
})

describe('level 4 (backup): restoreUser', () => {
  it('puts back the backed-up files at their backed-up sizes', async () => {
    await fs.addFileAs('ana', '/p/a', 10)
    await fs.addFileAs('ana', '/p/b', 20)
    await fs.backupUser('ana')
    await fs.updateFile('/p/a', 50)
    await fs.deleteFile('/p/b')
    expect(await fs.restoreUser('ana')).toBe(2)
    expect(await fs.getSize('/p/a')).toBe(10)
    expect(await fs.getSize('/p/b')).toBe(20)
    expect(await fs.getRemaining('ana')).toBe(70)
  })

  it('deletes files the user created after the backup', async () => {
    await fs.addFileAs('ana', '/p/a', 10)
    await fs.backupUser('ana')
    await fs.addFileAs('ana', '/p/new', 30)
    expect(await fs.restoreUser('ana')).toBe(1)
    expect(await fs.getSize('/p/new')).toBeNull()
    expect(await fs.getRemaining('ana')).toBe(90)
  })

  it('deletes every file and returns 0 when there is no backup', async () => {
    await fs.addFileAs('ana', '/p/a', 10)
    await fs.addFileAs('ana', '/p/b', 10)
    expect(await fs.restoreUser('ana')).toBe(0)
    expect(await fs.getSize('/p/a')).toBeNull()
    expect(await fs.getRemaining('ana')).toBe(100)
  })

  it('returns null for an unknown user', async () => {
    expect(await fs.restoreUser('ghost')).toBeNull()
  })

  it('restores the latest backup only', async () => {
    await fs.addFileAs('ana', '/p/a', 10)
    await fs.backupUser('ana')
    await fs.addFileAs('ana', '/p/b', 20)
    await fs.backupUser('ana')
    await fs.deleteFile('/p/a')
    await fs.deleteFile('/p/b')
    expect(await fs.restoreUser('ana')).toBe(2)
    expect(await fs.getSize('/p/b')).toBe(20)
  })

  it('does not touch other users\' files or unowned files', async () => {
    await fs.addUser('ben', 100)
    await fs.addFileAs('ana', '/p/a', 10)
    await fs.addFileAs('ben', '/p/b', 10)
    await fs.addFile('/p/c', 10)
    await fs.backupUser('ana')
    await fs.restoreUser('ana')
    expect(await fs.getSize('/p/b')).toBe(10)
    expect(await fs.getSize('/p/c')).toBe(10)
    expect(await fs.getRemaining('ben')).toBe(90)
  })
})

describe('level 4 (backup): restore skips paths that became unavailable', () => {
  beforeEach(async () => {
    await fs.addUser('ben', 100)
    await fs.addFileAs('ana', '/p/a', 10)
    await fs.addFileAs('ana', '/q/x', 10)
    await fs.addFileAs('ana', '/keep', 10)
    await fs.backupUser('ana')
    await fs.deleteFile('/p/a')
    await fs.deleteFile('/q/x')
  })

  it('skips a path now held by another user\'s file', async () => {
    await fs.addFileAs('ben', '/p/a', 7)
    expect(await fs.restoreUser('ana')).toBe(2)
    expect(await fs.getSize('/p/a')).toBe(7)
    expect(await fs.getRemaining('ben')).toBe(93)
    expect(await fs.getRemaining('ana')).toBe(80)
  })

  it('skips a path now held by an unowned file', async () => {
    await fs.addFile('/p/a', 1)
    expect(await fs.restoreUser('ana')).toBe(2)
    expect(await fs.getSize('/p/a')).toBe(1)
  })

  it('skips a path that is now another user\'s directory', async () => {
    await fs.addFileAs('ben', '/p/a/inside', 1)
    expect(await fs.restoreUser('ana')).toBe(2)
    expect(await fs.getSize('/p/a')).toBeNull()
    expect(await fs.getSize('/p/a/inside')).toBe(1)
  })

  it('skips a path whose ancestor is now another user\'s file', async () => {
    await fs.addFileAs('ben', '/q', 1)
    expect(await fs.restoreUser('ana')).toBe(2)
    expect(await fs.getSize('/q/x')).toBeNull()
    expect(await fs.getSize('/q')).toBe(1)
  })

  it('does not count the user\'s own current files as conflicts', async () => {
    await fs.addFileAs('ana', '/p/a', 50)
    expect(await fs.restoreUser('ana')).toBe(3)
    expect(await fs.getSize('/p/a')).toBe(10)
  })
})

describe('level 4 (backup): merging', () => {
  beforeEach(async () => {
    await fs.addUser('ben', 50)
    await fs.addFileAs('ana', '/ana/a', 10)
    await fs.addFileAs('ben', '/ben/b', 20)
    await fs.backupUser('ana')
    await fs.backupUser('ben')
  })

  it('discards the source\'s backup', async () => {
    await fs.mergeUsers('ana', 'ben')
    expect(await fs.restoreUser('ben')).toBeNull()
    await fs.addUser('ben', 50)
    expect(await fs.restoreUser('ben')).toBe(0)
    expect(await fs.getSize('/ben/b')).toBe(20)
  })

  it('keeps the target\'s backup, so restoring the target deletes the merged files', async () => {
    await fs.mergeUsers('ana', 'ben')
    expect(await fs.restoreUser('ana')).toBe(1)
    expect(await fs.getSize('/ben/b')).toBeNull()
    expect(await fs.getRemaining('ana')).toBe(140)
  })
})

describe('level 4 (backup): the worked example in levels.md', () => {
  it('matches every row', async () => {
    await fs.addFileAs('ana', '/p/a', 10)
    await fs.addFileAs('ana', '/p/b', 20)
    expect(await fs.backupUser('ana')).toBe(2)
    await fs.deleteFile('/p/a')
    await fs.addFileAs('ana', '/p/c', 5)
    expect(await fs.addFile('/p/a', 1)).toBe(true)
    expect(await fs.restoreUser('ana')).toBe(1)
    expect(await fs.getSize('/p/a')).toBe(1)
    expect(await fs.getSize('/p/b')).toBe(20)
    expect(await fs.getSize('/p/c')).toBeNull()
  })
})
