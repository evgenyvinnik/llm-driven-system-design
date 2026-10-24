import { beforeEach, describe, expect, it } from 'vitest'
import { createStore } from '../subject.js'

let db: Awaited<ReturnType<typeof createStore>>

beforeEach(async () => {
  db = await createStore()
})

describe('level 1: setField and getField', () => {
  it('stores a field and reads it back', async () => {
    expect(await db.setField('u1', 'name', 'Ada')).toBeNull()
    expect(await db.getField('u1', 'name')).toBe('Ada')
  })

  it('returns the previous value on overwrite and stores the new one', async () => {
    await db.setField('u1', 'name', 'Ada')
    expect(await db.setField('u1', 'name', 'Ida')).toBe('Ada')
    expect(await db.getField('u1', 'name')).toBe('Ida')
  })

  it('returns the previous value even when the new value is the same', async () => {
    await db.setField('u1', 'name', 'Ada')
    expect(await db.setField('u1', 'name', 'Ada')).toBe('Ada')
  })

  it('treats the empty string as a value, not a missing field', async () => {
    expect(await db.setField('u1', 'note', '')).toBeNull()
    expect(await db.getField('u1', 'note')).toBe('')
    expect(await db.setField('u1', 'note', 'x')).toBe('')
  })

  it('returns null for a missing record and for a missing field', async () => {
    await db.setField('u1', 'name', 'Ada')
    expect(await db.getField('u2', 'name')).toBeNull()
    expect(await db.getField('u1', 'email')).toBeNull()
  })

  it('keeps fields of different records apart', async () => {
    await db.setField('u1', 'name', 'Ada')
    await db.setField('u2', 'name', 'Bo')
    expect(await db.getField('u1', 'name')).toBe('Ada')
    expect(await db.getField('u2', 'name')).toBe('Bo')
  })

  it('is case-sensitive in keys and field names', async () => {
    await db.setField('u1', 'name', 'lower')
    await db.setField('u1', 'Name', 'upper')
    await db.setField('U1', 'name', 'other record')
    expect(await db.getField('u1', 'name')).toBe('lower')
    expect(await db.getField('u1', 'Name')).toBe('upper')
    expect(await db.getField('U1', 'name')).toBe('other record')
  })
})

describe('level 1: deleteField', () => {
  it('returns the deleted value and removes the field', async () => {
    await db.setField('u1', 'name', 'Ada')
    expect(await db.deleteField('u1', 'name')).toBe('Ada')
    expect(await db.getField('u1', 'name')).toBeNull()
    expect(await db.deleteField('u1', 'name')).toBeNull()
  })

  it('returns an empty value as "", not null', async () => {
    await db.setField('u1', 'note', '')
    expect(await db.deleteField('u1', 'note')).toBe('')
    expect(await db.deleteField('u1', 'note')).toBeNull()
  })

  it('returns null for a missing record or field and leaves the others alone', async () => {
    await db.setField('u1', 'name', 'Ada')
    expect(await db.deleteField('u2', 'name')).toBeNull()
    expect(await db.deleteField('u1', 'email')).toBeNull()
    expect(await db.getField('u1', 'name')).toBe('Ada')
  })

  it('treats a field written after a delete as new', async () => {
    await db.setField('u1', 'name', 'Ada')
    await db.deleteField('u1', 'name')
    expect(await db.setField('u1', 'name', 'Bo')).toBeNull()
  })
})

describe('level 1: deleteRecord', () => {
  it('returns the number of fields and removes them all', async () => {
    await db.setField('u1', 'a', '1')
    await db.setField('u1', 'b', '2')
    await db.setField('u1', 'c', '')
    expect(await db.deleteRecord('u1')).toBe(3)
    expect(await db.getField('u1', 'a')).toBeNull()
    expect(await db.getField('u1', 'c')).toBeNull()
    expect(await db.deleteRecord('u1')).toBeNull()
  })

  it('returns null for a record that never existed', async () => {
    expect(await db.deleteRecord('ghost')).toBeNull()
  })

  it('leaves other records alone', async () => {
    await db.setField('u1', 'a', '1')
    await db.setField('u10', 'a', '2')
    expect(await db.deleteRecord('u1')).toBe(1)
    expect(await db.getField('u10', 'a')).toBe('2')
  })

  it('deletes a record with its last field', async () => {
    await db.setField('u1', 'a', '1')
    await db.setField('u1', 'b', '2')
    await db.deleteField('u1', 'a')
    await db.deleteField('u1', 'b')
    expect(await db.deleteRecord('u1')).toBeNull()
  })

  it('counts only the fields left after earlier deletes', async () => {
    await db.setField('u1', 'a', '1')
    await db.setField('u1', 'b', '2')
    await db.setField('u1', 'a', '3')
    await db.deleteField('u1', 'b')
    expect(await db.deleteRecord('u1')).toBe(1)
  })

  it('lets a deleted record be written again', async () => {
    await db.setField('u1', 'a', '1')
    await db.deleteRecord('u1')
    expect(await db.setField('u1', 'a', '2')).toBeNull()
    expect(await db.getField('u1', 'a')).toBe('2')
  })
})

describe('level 1: the worked example in levels-db.md', () => {
  it('matches every row', async () => {
    expect(await db.setField('u1', 'name', 'Ada')).toBeNull()
    expect(await db.setField('u1', 'name', 'Ida')).toBe('Ada')
    expect(await db.setField('u1', 'note', '')).toBeNull()
    expect(await db.getField('u1', 'note')).toBe('')
    expect(await db.getField('u2', 'name')).toBeNull()
    expect(await db.deleteField('u1', 'name')).toBe('Ida')
    expect(await db.deleteField('u1', 'name')).toBeNull()
    expect(await db.deleteRecord('u1')).toBe(1)
    expect(await db.deleteRecord('u1')).toBeNull()
  })
})
