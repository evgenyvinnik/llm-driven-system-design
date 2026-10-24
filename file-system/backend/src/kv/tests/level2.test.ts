import { beforeEach, describe, expect, it } from 'vitest'
import { createStore } from '../subject.js'

let db: Awaited<ReturnType<typeof createStore>>

beforeEach(async () => {
  db = await createStore()
})

describe('level 2: scanRecord', () => {
  it('formats every field as field=value, sorted by field name', async () => {
    await db.setField('u1', 'name', 'Ada')
    await db.setField('u1', 'email', 'ada@x')
    await db.setField('u1', 'age', '36')
    expect(await db.scanRecord('u1')).toEqual(['age=36', 'email=ada@x', 'name=Ada'])
  })

  it('returns an empty list for a missing record', async () => {
    expect(await db.scanRecord('ghost')).toEqual([])
  })

  it('sorts in code-unit order: upper case first, digits as characters', async () => {
    await db.setField('r', 'item2', 'b')
    await db.setField('r', 'item10', 'a')
    await db.setField('r', 'Zed', 'z')
    await db.setField('r', 'apple', 'p')
    await db.setField('r', '_x', 'u')
    // "Z" (0x5A) < "_" (0x5F) < "a" (0x61), and "item1" < "item2".
    expect(await db.scanRecord('r')).toEqual(['Zed=z', '_x=u', 'apple=p', 'item10=a', 'item2=b'])
  })

  it('sorts by field name, not by value or insertion order', async () => {
    await db.setField('r', 'b', '1')
    await db.setField('r', 'a', '2')
    expect(await db.scanRecord('r')).toEqual(['a=2', 'b=1'])
  })

  it('does not escape or trim values', async () => {
    await db.setField('r', 'eq', 'x=y')
    await db.setField('r', 'empty', '')
    await db.setField('r', 'space', ' padded ')
    expect(await db.scanRecord('r')).toEqual(['empty=', 'eq=x=y', 'space= padded '])
  })

  it('reflects overwrites and deletes', async () => {
    await db.setField('r', 'a', '1')
    await db.setField('r', 'b', '2')
    await db.setField('r', 'a', '3')
    await db.deleteField('r', 'b')
    expect(await db.scanRecord('r')).toEqual(['a=3'])
    await db.deleteRecord('r')
    expect(await db.scanRecord('r')).toEqual([])
  })
})

describe('level 2: scanPrefix', () => {
  beforeEach(async () => {
    await db.setField('u1', 'name', 'Ada')
    await db.setField('u1', 'nick', 'ada')
    await db.setField('u1', 'Nick', 'A')
    await db.setField('u1', 'email', 'ada@x')
    await db.setField('u1', 'n', 'short')
  })

  it('keeps only fields whose name starts with the prefix', async () => {
    expect(await db.scanPrefix('u1', 'n')).toEqual(['n=short', 'name=Ada', 'nick=ada'])
    expect(await db.scanPrefix('u1', 'ni')).toEqual(['nick=ada'])
  })

  it('is case-sensitive', async () => {
    expect(await db.scanPrefix('u1', 'N')).toEqual(['Nick=A'])
  })

  it('matches a field equal to the prefix', async () => {
    expect(await db.scanPrefix('u1', 'email')).toEqual(['email=ada@x'])
  })

  it('keeps every field for the empty prefix', async () => {
    expect(await db.scanPrefix('u1', '')).toEqual(await db.scanRecord('u1'))
    expect(await db.scanPrefix('u1', '')).toHaveLength(5)
  })

  it('returns an empty list for no match and for a missing record', async () => {
    expect(await db.scanPrefix('u1', 'zz')).toEqual([])
    expect(await db.scanPrefix('ghost', '')).toEqual([])
  })

  it('matches field names, not values', async () => {
    expect(await db.scanPrefix('u1', 'Ada')).toEqual([])
  })
})

describe('level 2: topRecords', () => {
  beforeEach(async () => {
    await db.setField('user:1', 'a', '1')
    await db.setField('user:1', 'b', '1')
    await db.setField('user:1', 'c', '1')
    await db.setField('user:2', 'a', '1')
    await db.setField('user:2', 'b', '1')
    await db.setField('user:10', 'a', '1')
    await db.setField('team:1', 'a', '1')
  })

  it('sorts by field count, most first, then by key, and formats key(count)', async () => {
    expect(await db.topRecords('', 10)).toEqual(['user:1(3)', 'user:2(2)', 'team:1(1)', 'user:10(1)'])
  })

  it('matches the key prefix as a plain string', async () => {
    expect(await db.topRecords('user:1', 5)).toEqual(['user:1(3)', 'user:10(1)'])
    expect(await db.topRecords('team', 5)).toEqual(['team:1(1)'])
  })

  it('breaks ties by key in code-unit order, not numerically', async () => {
    await db.setField('user:10', 'b', '1')
    // user:10 and user:2 both hold 2 fields; "user:10" < "user:2".
    expect(await db.topRecords('user:', 5)).toEqual(['user:1(3)', 'user:10(2)', 'user:2(2)'])
  })

  it('returns at most n records', async () => {
    expect(await db.topRecords('', 2)).toEqual(['user:1(3)', 'user:2(2)'])
    expect(await db.topRecords('user:', 1)).toEqual(['user:1(3)'])
  })

  it('returns an empty list for n <= 0 and for an unmatched prefix', async () => {
    expect(await db.topRecords('', 0)).toEqual([])
    expect(await db.topRecords('', -1)).toEqual([])
    expect(await db.topRecords('zzz', 5)).toEqual([])
  })

  it('reflects deletes, and leaves out deleted records', async () => {
    await db.deleteField('user:1', 'a')
    await db.deleteField('user:1', 'b')
    await db.deleteRecord('user:2')
    expect(await db.topRecords('user:', 5)).toEqual(['user:1(1)', 'user:10(1)'])
  })

  it('counts an overwritten field once', async () => {
    await db.setField('team:1', 'a', '2')
    await db.setField('team:1', 'a', '3')
    expect(await db.topRecords('team', 5)).toEqual(['team:1(1)'])
  })

  it('returns an empty list for an empty store', async () => {
    const empty = await createStore()
    expect(await empty.topRecords('', 5)).toEqual([])
  })
})

describe('level 2: the worked example in levels-db.md', () => {
  it('matches every row', async () => {
    expect(await db.setField('user:1', 'name', 'Ada')).toBeNull()
    expect(await db.setField('user:1', 'email', 'ada@x')).toBeNull()
    expect(await db.setField('user:1', 'Nick', 'ada')).toBeNull()
    expect(await db.setField('user:2', 'name', 'Bo')).toBeNull()
    expect(await db.setField('user:2', 'role', 'admin')).toBeNull()
    expect(await db.setField('user:10', 'name', 'Cy')).toBeNull()
    expect(await db.setField('team:1', 'name', 'Core')).toBeNull()
    expect(await db.scanRecord('user:1')).toEqual(['Nick=ada', 'email=ada@x', 'name=Ada'])
    expect(await db.scanPrefix('user:1', 'n')).toEqual(['name=Ada'])
    expect(await db.scanPrefix('user:3', '')).toEqual([])
    expect(await db.topRecords('', 4)).toEqual(['user:1(3)', 'user:2(2)', 'team:1(1)', 'user:10(1)'])
    expect(await db.topRecords('user:1', 5)).toEqual(['user:1(3)', 'user:10(1)'])
    expect(await db.topRecords('user:', 0)).toEqual([])
  })
})
