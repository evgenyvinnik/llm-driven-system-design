import { beforeEach, describe, expect, it } from 'vitest'
import { createStore } from '../subject.js'

let db: Awaited<ReturnType<typeof createStore>>

beforeEach(async () => {
  db = await createStore()
})

describe('level 4 (backup): backupAt', () => {
  it('returns the number of live fields across all records', async () => {
    await db.setFieldAt(1, 'a', 'x', '1')
    await db.setFieldAt(1, 'a', 'y', '2')
    await db.setFieldAt(1, 'b', 'z', '3')
    await db.setFieldAt(1, 'b', 'gone', '4', 2)
    expect(await db.backupAt(3)).toBe(3)
  })

  it('backs up an empty store as 0', async () => {
    expect(await db.backupAt(0)).toBe(0)
  })

  it('is a copy: later changes do not reach it', async () => {
    await db.setFieldAt(1, 'a', 'x', 'before')
    await db.backupAt(2)
    await db.setFieldAt(3, 'a', 'x', 'after')
    await db.setFieldAt(3, 'a', 'extra', '1')
    await db.restoreAt(4, 2)
    expect(await db.scanRecordAt(4, 'a')).toEqual(['x=before'])
  })
})

describe('level 4 (backup): restoreAt', () => {
  it('returns null and changes nothing when no backup is at or before backupTime', async () => {
    await db.setFieldAt(1, 'a', 'x', '1')
    expect(await db.restoreAt(2, 5)).toBeNull()
    await db.backupAt(6)
    await db.setFieldAt(7, 'a', 'x', '2')
    expect(await db.restoreAt(8, 5)).toBeNull()
    expect(await db.getFieldAt(8, 'a', 'x')).toBe('2')
  })

  it('replaces the whole store, removing records created after the backup', async () => {
    await db.setFieldAt(1, 'a', 'x', '1')
    await db.backupAt(2)
    await db.setFieldAt(3, 'a', 'y', '2')
    await db.setFieldAt(3, 'b', 'z', '3')
    await db.deleteFieldAt(3, 'a', 'x')
    expect(await db.restoreAt(4, 2)).toBe(1)
    expect(await db.scanRecordAt(4, 'a')).toEqual(['x=1'])
    expect(await db.scanRecordAt(4, 'b')).toEqual([])
    expect(await db.topRecordsAt(4, '', 5)).toEqual(['a(1)'])
  })

  it('picks the most recent backup at or before backupTime', async () => {
    await db.setFieldAt(1, 'r', 'v', 'one')
    await db.backupAt(10)
    await db.setFieldAt(11, 'r', 'v', 'two')
    await db.backupAt(20)
    await db.setFieldAt(21, 'r', 'v', 'three')
    await db.backupAt(30)
    expect(await db.restoreAt(31, 25)).toBe(1)
    expect(await db.getFieldAt(31, 'r', 'v')).toBe('two')
    expect(await db.restoreAt(32, 10)).toBe(1)
    expect(await db.getFieldAt(32, 'r', 'v')).toBe('one')
    expect(await db.restoreAt(33, 99)).toBe(1)
    expect(await db.getFieldAt(33, 'r', 'v')).toBe('three')
  })

  it('keeps every backup, so one can be restored twice', async () => {
    await db.setFieldAt(1, 'r', 'v', 'saved')
    await db.backupAt(2)
    await db.setFieldAt(3, 'r', 'v', 'changed')
    await db.restoreAt(4, 2)
    await db.setFieldAt(5, 'r', 'v', 'changed again')
    expect(await db.restoreAt(6, 2)).toBe(1)
    expect(await db.getFieldAt(6, 'r', 'v')).toBe('saved')
  })

  it('replaces an earlier backup taken at the same timestamp', async () => {
    await db.setFieldAt(1, 'r', 'v', 'first')
    await db.backupAt(1)
    await db.setFieldAt(1, 'r', 'v', 'second')
    await db.setFieldAt(1, 'r', 'w', 'x')
    expect(await db.backupAt(1)).toBe(2)
    await db.deleteRecordAt(2, 'r')
    expect(await db.restoreAt(3, 1)).toBe(2)
    expect(await db.scanRecordAt(3, 'r')).toEqual(['v=second', 'w=x'])
  })

  it('restores an empty backup by emptying the store', async () => {
    await db.backupAt(0)
    await db.setFieldAt(1, 'a', 'x', '1')
    expect(await db.restoreAt(2, 0)).toBe(0)
    expect(await db.topRecordsAt(2, '', 5)).toEqual([])
  })

  it('leaves out fields that had expired before the backup', async () => {
    await db.setFieldAt(1, 'r', 'tmp', 't', 2)
    await db.setFieldAt(1, 'r', 'keep', 'k')
    expect(await db.backupAt(3)).toBe(1)
    await db.setFieldAt(4, 'r', 'tmp', 'live again')
    expect(await db.restoreAt(5, 3)).toBe(1)
    expect(await db.scanRecordAt(5, 'r')).toEqual(['keep=k'])
  })

  it('works with the earlier methods after a restore', async () => {
    await db.setFieldAt(1, 'r', 'a', '1')
    await db.backupAt(1)
    await db.restoreAt(2, 1)
    expect(await db.setField('r', 'a', '2')).toBe('1')
    expect(await db.deleteRecord('r')).toBe(1)
    expect(await db.restoreAt(3, 1)).toBe(1)
    expect(await db.getField('r', 'a')).toBe('1')
  })
})

describe('level 4 (backup): lifetimes across a restore', () => {
  it('restarts a saved remaining lifetime from the restore time', async () => {
    await db.setFieldAt(10, 'r', 'f', 'v', 10)
    await db.backupAt(15)
    expect(await db.restoreAt(100, 15)).toBe(1)
    expect(await db.getFieldAt(104, 'r', 'f')).toBe('v')
    expect(await db.getFieldAt(105, 'r', 'f')).toBeNull()
  })

  it('restores a field that had expired in the live store before the restore', async () => {
    await db.setFieldAt(1, 'r', 'f', 'v', 3)
    await db.backupAt(2)
    expect(await db.getFieldAt(10, 'r', 'f')).toBeNull()
    await db.restoreAt(10, 2)
    expect(await db.getFieldAt(11, 'r', 'f')).toBe('v')
    expect(await db.getFieldAt(12, 'r', 'f')).toBeNull()
  })

  it('keeps a field without a ttl permanent', async () => {
    await db.setFieldAt(1, 'r', 'f', 'v')
    await db.backupAt(2)
    await db.restoreAt(3, 2)
    expect(await db.getFieldAt(1_000_000, 'r', 'f')).toBe('v')
  })

  it('restores the same backup with a fresh lifetime each time', async () => {
    await db.setFieldAt(0, 'r', 'f', 'v', 5)
    await db.backupAt(1)
    await db.restoreAt(10, 1)
    expect(await db.getFieldAt(13, 'r', 'f')).toBe('v')
    await db.restoreAt(20, 1)
    expect(await db.getFieldAt(23, 'r', 'f')).toBe('v')
    expect(await db.getFieldAt(24, 'r', 'f')).toBeNull()
  })
})

describe('level 4 (backup): the worked example in levels-db.md', () => {
  it('matches every row', async () => {
    expect(await db.setFieldAt(1, 'a', 'x', '1')).toBeNull()
    expect(await db.setFieldAt(2, 'a', 'y', '2', 10)).toBeNull()
    expect(await db.backupAt(5)).toBe(2)
    expect(await db.setFieldAt(6, 'b', 'z', '3')).toBeNull()
    expect(await db.deleteFieldAt(7, 'a', 'x')).toBe('1')
    expect(await db.restoreAt(20, 4)).toBeNull()
    expect(await db.restoreAt(20, 9)).toBe(2)
    expect(await db.scanRecordAt(26, 'a')).toEqual(['x=1', 'y=2'])
    expect(await db.getFieldAt(27, 'a', 'y')).toBeNull()
    expect(await db.getField('b', 'z')).toBeNull()
  })
})
