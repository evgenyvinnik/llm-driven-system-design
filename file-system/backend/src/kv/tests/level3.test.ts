import { beforeEach, describe, expect, it } from 'vitest'
import { createStore } from '../subject.js'

let db: Awaited<ReturnType<typeof createStore>>

beforeEach(async () => {
  db = await createStore()
})

describe('level 3: timestamped twins', () => {
  it('behave like the untimestamped methods', async () => {
    expect(await db.setFieldAt(1, 'u1', 'name', 'Ada')).toBeNull()
    expect(await db.setFieldAt(2, 'u1', 'name', 'Ida')).toBe('Ada')
    expect(await db.setFieldAt(2, 'u1', 'email', 'i@x')).toBeNull()
    expect(await db.getFieldAt(3, 'u1', 'name')).toBe('Ida')
    expect(await db.scanRecordAt(3, 'u1')).toEqual(['email=i@x', 'name=Ida'])
    expect(await db.scanPrefixAt(3, 'u1', 'e')).toEqual(['email=i@x'])
    expect(await db.topRecordsAt(3, 'u', 5)).toEqual(['u1(2)'])
    expect(await db.deleteFieldAt(4, 'u1', 'email')).toBe('i@x')
    expect(await db.deleteRecordAt(5, 'u1')).toBe(1)
    expect(await db.deleteRecordAt(5, 'u1')).toBeNull()
  })

  it('apply calls that share a timestamp in call order', async () => {
    await db.setFieldAt(7, 'r', 'f', 'a')
    expect(await db.setFieldAt(7, 'r', 'f', 'b')).toBe('a')
    expect(await db.deleteFieldAt(7, 'r', 'f')).toBe('b')
    expect(await db.getFieldAt(7, 'r', 'f')).toBeNull()
  })

  it('accept timestamp 0', async () => {
    expect(await db.setFieldAt(0, 'r', 'f', 'v')).toBeNull()
    expect(await db.getFieldAt(0, 'r', 'f')).toBe('v')
  })
})

describe('level 3: untimestamped calls', () => {
  it('act at the latest timestamp used so far', async () => {
    await db.setFieldAt(10, 'r', 'tmp', 'x', 5)
    await db.getFieldAt(14, 'r', 'tmp')
    expect(await db.getField('r', 'tmp')).toBe('x')
    await db.getFieldAt(15, 'other', 'f')
    expect(await db.getField('r', 'tmp')).toBeNull()
    expect(await db.scanRecord('r')).toEqual([])
  })

  it('act at 0 before any timestamped call, and mix with timestamped ones', async () => {
    expect(await db.setField('r', 'a', '1')).toBeNull()
    expect(await db.getFieldAt(0, 'r', 'a')).toBe('1')
    expect(await db.setFieldAt(3, 'r', 'b', '2', 1)).toBeNull()
    expect(await db.scanRecord('r')).toEqual(['a=1', 'b=2'])
    expect(await db.setField('r', 'a', '9')).toBe('1')
    expect(await db.getFieldAt(4, 'r', 'a')).toBe('9')
    expect(await db.scanRecord('r')).toEqual(['a=9'])
  })
})

describe('level 3: time to live', () => {
  it('keeps a value live through t + ttl - 1 and expires it at t + ttl', async () => {
    await db.setFieldAt(10, 's', 'token', 'abc', 20)
    expect(await db.getFieldAt(29, 's', 'token')).toBe('abc')
    expect(await db.getFieldAt(30, 's', 'token')).toBeNull()
  })

  it('expires a ttl of 1 at the very next timestamp', async () => {
    await db.setFieldAt(5, 's', 'f', 'v', 1)
    expect(await db.getFieldAt(5, 's', 'f')).toBe('v')
    expect(await db.getFieldAt(6, 's', 'f')).toBeNull()
  })

  it('never expires a value written without a ttl', async () => {
    await db.setFieldAt(1, 's', 'f', 'v')
    expect(await db.getFieldAt(1_000_000, 's', 'f')).toBe('v')
  })

  it('treats an expired field as missing in every method', async () => {
    await db.setFieldAt(1, 'r', 'keep', 'k')
    await db.setFieldAt(1, 'r', 'gone', 'g', 3)
    await db.setFieldAt(1, 'r', 'gone2', '', 3)
    expect(await db.scanRecordAt(4, 'r')).toEqual(['keep=k'])
    expect(await db.scanPrefixAt(4, 'r', 'g')).toEqual([])
    expect(await db.topRecordsAt(4, '', 5)).toEqual(['r(1)'])
    expect(await db.deleteFieldAt(4, 'r', 'gone')).toBeNull()
    expect(await db.setFieldAt(4, 'r', 'gone2', 'new')).toBeNull()
    expect(await db.deleteRecordAt(4, 'r')).toBe(2)
  })

  it('makes a record vanish once its every field has expired', async () => {
    await db.setFieldAt(1, 'r', 'a', '1', 5)
    await db.setFieldAt(2, 'r', 'b', '2', 5)
    await db.setFieldAt(2, 'q', 'a', '1')
    expect(await db.topRecordsAt(6, '', 5)).toEqual(['q(1)', 'r(1)'])
    expect(await db.topRecordsAt(7, '', 5)).toEqual(['q(1)'])
    expect(await db.scanRecordAt(7, 'r')).toEqual([])
    expect(await db.deleteRecordAt(7, 'r')).toBeNull()
  })

  it('lets an expired record be written again from scratch', async () => {
    await db.setFieldAt(1, 'r', 'a', '1', 2)
    await db.setFieldAt(1, 'r', 'b', '2', 2)
    expect(await db.setFieldAt(3, 'r', 'a', 'new')).toBeNull()
    expect(await db.scanRecordAt(3, 'r')).toEqual(['a=new'])
    expect(await db.deleteRecordAt(3, 'r')).toBe(1)
  })

  it('expires many fields across records in one jump of the clock', async () => {
    await db.setFieldAt(0, 'a', 'f', '1', 2)
    await db.setFieldAt(0, 'b', 'f', '1', 4)
    await db.setFieldAt(0, 'c', 'f', '1', 100)
    await db.setFieldAt(0, 'c', 'g', '1', 3)
    expect(await db.topRecordsAt(50, '', 10)).toEqual(['c(1)'])
  })
})

describe('level 3: every write starts a new lifetime', () => {
  it('makes a field permanent when rewritten without a ttl', async () => {
    await db.setFieldAt(1, 'r', 'f', 'a', 5)
    expect(await db.setFieldAt(3, 'r', 'f', 'b')).toBe('a')
    expect(await db.getFieldAt(100, 'r', 'f')).toBe('b')
  })

  it('counts a new ttl from the rewrite, shortening or extending the lifetime', async () => {
    await db.setFieldAt(1, 'r', 'short', 'a', 100)
    await db.setFieldAt(1, 'r', 'long', 'a', 5)
    await db.setFieldAt(4, 'r', 'short', 'b', 2)
    await db.setFieldAt(4, 'r', 'long', 'b', 10)
    expect(await db.scanRecordAt(5, 'r')).toEqual(['long=b', 'short=b'])
    expect(await db.scanRecordAt(6, 'r')).toEqual(['long=b'])
    expect(await db.getFieldAt(13, 'r', 'long')).toBe('b')
    expect(await db.getFieldAt(14, 'r', 'long')).toBeNull()
  })

  it('gives a ttl to a field that had none', async () => {
    await db.setFieldAt(1, 'r', 'f', 'a')
    await db.setFieldAt(2, 'r', 'f', 'b', 3)
    expect(await db.getFieldAt(4, 'r', 'f')).toBe('b')
    expect(await db.getFieldAt(5, 'r', 'f')).toBeNull()
  })

  it('returns null as the previous value when rewriting an expired field', async () => {
    await db.setFieldAt(1, 'r', 'f', 'old', 2)
    expect(await db.setFieldAt(3, 'r', 'f', 'new', 2)).toBeNull()
    expect(await db.setFieldAt(4, 'r', 'f', 'newer')).toBe('new')
  })
})

describe('level 3: the worked example in levels-db.md', () => {
  it('matches every row', async () => {
    expect(await db.setFieldAt(1, 's:9', 'token', 'abc', 10)).toBeNull()
    expect(await db.setFieldAt(2, 's:9', 'user', 'ada')).toBeNull()
    expect(await db.getFieldAt(10, 's:9', 'token')).toBe('abc')
    expect(await db.scanRecordAt(11, 's:9')).toEqual(['user=ada'])
    expect(await db.setFieldAt(12, 's:9', 'token', 'def')).toBeNull()
    expect(await db.setFieldAt(13, 's:9', 'user', 'bo', 2)).toBe('ada')
    expect(await db.topRecordsAt(15, 's:', 5)).toEqual(['s:9(1)'])
    expect(await db.getField('s:9', 'user')).toBeNull()
  })
})
