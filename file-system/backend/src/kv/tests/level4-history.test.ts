import { beforeEach, describe, expect, it } from 'vitest'
import { createStore } from '../subject.js'

let db: Awaited<ReturnType<typeof createStore>>

beforeEach(async () => {
  db = await createStore()
})

describe('level 4 (history): getFieldAsOf', () => {
  it('answers for every past version, overwrite and delete', async () => {
    await db.setFieldAt(10, 'r', 'f', 'v1')
    await db.setFieldAt(20, 'r', 'f', 'v2')
    await db.deleteFieldAt(30, 'r', 'f')
    await db.setFieldAt(40, 'r', 'f', 'v3')
    expect(await db.getFieldAsOf('r', 'f', 9)).toBeNull()
    expect(await db.getFieldAsOf('r', 'f', 10)).toBe('v1')
    expect(await db.getFieldAsOf('r', 'f', 19)).toBe('v1')
    expect(await db.getFieldAsOf('r', 'f', 20)).toBe('v2')
    expect(await db.getFieldAsOf('r', 'f', 29)).toBe('v2')
    expect(await db.getFieldAsOf('r', 'f', 30)).toBeNull()
    expect(await db.getFieldAsOf('r', 'f', 39)).toBeNull()
    expect(await db.getFieldAsOf('r', 'f', 40)).toBe('v3')
  })

  it('returns null for a field or record that never existed', async () => {
    await db.setFieldAt(1, 'r', 'f', 'v')
    expect(await db.getFieldAsOf('r', 'g', 1)).toBeNull()
    expect(await db.getFieldAsOf('ghost', 'f', 1)).toBeNull()
  })

  it('reports the state after every operation at the same time', async () => {
    await db.setFieldAt(7, 'r', 'u', 'a')
    await db.setFieldAt(7, 'r', 'u', 'b')
    await db.setFieldAt(7, 'r', 'v', 'a')
    await db.deleteFieldAt(7, 'r', 'v')
    expect(await db.getFieldAsOf('r', 'u', 7)).toBe('b')
    expect(await db.getFieldAsOf('r', 'v', 7)).toBeNull()
  })

  it('keeps an empty value distinct from a missing one', async () => {
    await db.setFieldAt(1, 'r', 'f', '')
    await db.deleteFieldAt(2, 'r', 'f')
    expect(await db.getFieldAsOf('r', 'f', 1)).toBe('')
    expect(await db.getFieldAsOf('r', 'f', 2)).toBeNull()
  })

  it('applies expiry to the past', async () => {
    await db.setFieldAt(1, 'r', 'f', 'v', 10)
    await db.getFieldAt(50, 'r', 'f')
    expect(await db.getFieldAsOf('r', 'f', 10)).toBe('v')
    expect(await db.getFieldAsOf('r', 'f', 11)).toBeNull()
    expect(await db.getFieldAsOf('r', 'f', 50)).toBeNull()
  })

  it('ends a lifetime early when a later write replaces it', async () => {
    await db.setFieldAt(1, 'r', 'f', 'a', 10)
    await db.setFieldAt(5, 'r', 'f', 'b', 2)
    await db.getFieldAt(20, 'r', 'f')
    expect(await db.getFieldAsOf('r', 'f', 4)).toBe('a')
    expect(await db.getFieldAsOf('r', 'f', 6)).toBe('b')
    // The first lifetime would have run to 10, but the write at 5 replaced it.
    expect(await db.getFieldAsOf('r', 'f', 7)).toBeNull()
    expect(await db.getFieldAsOf('r', 'f', 10)).toBeNull()
  })

  it('extends a lifetime when a later write makes the field permanent', async () => {
    await db.setFieldAt(1, 'r', 'f', 'a', 3)
    await db.setFieldAt(2, 'r', 'f', 'b')
    await db.getFieldAt(100, 'r', 'f')
    expect(await db.getFieldAsOf('r', 'f', 50)).toBe('b')
  })

  it('keeps history across expiry and rewriting of the same field', async () => {
    await db.setFieldAt(0, 'r', 'f', 'a', 5)
    await db.setFieldAt(8, 'r', 'f', 'b')
    expect(await db.getFieldAsOf('r', 'f', 4)).toBe('a')
    expect(await db.getFieldAsOf('r', 'f', 5)).toBeNull()
    expect(await db.getFieldAsOf('r', 'f', 7)).toBeNull()
    expect(await db.getFieldAsOf('r', 'f', 8)).toBe('b')
  })

  it('includes fields removed by deleteRecord', async () => {
    await db.setFieldAt(1, 'r', 'a', '1')
    await db.setFieldAt(2, 'r', 'b', '2')
    await db.deleteRecordAt(3, 'r')
    expect(await db.getFieldAsOf('r', 'a', 2)).toBe('1')
    expect(await db.getFieldAsOf('r', 'b', 2)).toBe('2')
    expect(await db.getFieldAsOf('r', 'a', 3)).toBeNull()
  })

  it('records untimestamped writes at the latest timestamp', async () => {
    await db.setFieldAt(5, 'r', 'f', 'a')
    await db.setField('r', 'f', 'b')
    await db.setFieldAt(9, 'r', 'g', 'x')
    expect(await db.getFieldAsOf('r', 'f', 5)).toBe('b')
    expect(await db.getFieldAsOf('r', 'f', 4)).toBeNull()
  })

  it('does not move the clock', async () => {
    await db.setFieldAt(5, 'r', 'f', 'v', 3)
    await db.getFieldAsOf('r', 'f', 5)
    expect(await db.getField('r', 'f')).toBe('v')
  })
})

describe('level 4 (history): scanRecordAsOf', () => {
  it('returns the record as it was, in scanRecord order and format', async () => {
    await db.setFieldAt(1, 'r', 'b', '1')
    await db.setFieldAt(2, 'r', 'a', '2')
    await db.setFieldAt(3, 'r', 'b', '3')
    await db.deleteFieldAt(4, 'r', 'a')
    expect(await db.scanRecordAsOf('r', 0)).toEqual([])
    expect(await db.scanRecordAsOf('r', 1)).toEqual(['b=1'])
    expect(await db.scanRecordAsOf('r', 2)).toEqual(['a=2', 'b=1'])
    expect(await db.scanRecordAsOf('r', 3)).toEqual(['a=2', 'b=3'])
    expect(await db.scanRecordAsOf('r', 4)).toEqual(['b=3'])
  })

  it('leaves out fields that had expired by then', async () => {
    await db.setFieldAt(1, 'r', 'keep', 'k')
    await db.setFieldAt(1, 'r', 'tmp', 't', 4)
    await db.getFieldAt(10, 'r', 'keep')
    expect(await db.scanRecordAsOf('r', 4)).toEqual(['keep=k', 'tmp=t'])
    expect(await db.scanRecordAsOf('r', 5)).toEqual(['keep=k'])
  })

  it('returns an empty list for a record that never existed or was deleted by then', async () => {
    await db.setFieldAt(1, 'r', 'a', '1')
    await db.deleteRecordAt(2, 'r')
    expect(await db.scanRecordAsOf('ghost', 2)).toEqual([])
    expect(await db.scanRecordAsOf('r', 2)).toEqual([])
    expect(await db.scanRecordAsOf('r', 1)).toEqual(['a=1'])
  })

  it('shows a record recreated after a delete without its old fields', async () => {
    await db.setFieldAt(1, 'r', 'old', '1')
    await db.deleteRecordAt(2, 'r')
    await db.setFieldAt(3, 'r', 'new', '2')
    expect(await db.scanRecordAsOf('r', 3)).toEqual(['new=2'])
  })
})

describe('level 4 (history): the worked example in levels-db.md', () => {
  it('matches every row', async () => {
    expect(await db.setFieldAt(5, 'cfg', 'mode', 'a')).toBeNull()
    expect(await db.setFieldAt(8, 'cfg', 'mode', 'b', 4)).toBe('a')
    expect(await db.setFieldAt(9, 'cfg', 'size', 'L')).toBeNull()
    expect(await db.deleteRecordAt(14, 'cfg')).toBe(1)
    expect(await db.getFieldAsOf('cfg', 'mode', 4)).toBeNull()
    expect(await db.getFieldAsOf('cfg', 'mode', 7)).toBe('a')
    expect(await db.getFieldAsOf('cfg', 'mode', 11)).toBe('b')
    expect(await db.getFieldAsOf('cfg', 'mode', 12)).toBeNull()
    expect(await db.scanRecordAsOf('cfg', 10)).toEqual(['mode=b', 'size=L'])
    expect(await db.scanRecordAsOf('cfg', 14)).toEqual([])
  })
})
