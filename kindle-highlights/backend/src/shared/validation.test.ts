import { describe, it, expect } from 'vitest'
import { effectiveMinReaders, MIN_READERS } from './privacy.js'
import { parseHighlightChanges, parseNewHighlight, parseSyncOp } from './validation.js'

const BOOK = '3F2504E0-4F89-41D3-9A0C-0305E82C3301'
const ID = '9B2C1D0E-1111-4222-8333-444455556666'

describe('effectiveMinReaders', () => {
  it('never lets a caller lower the privacy threshold', () => {
    expect(effectiveMinReaders('1')).toBe(MIN_READERS)
    expect(effectiveMinReaders('0')).toBe(MIN_READERS)
    expect(effectiveMinReaders('-5')).toBe(MIN_READERS)
    expect(effectiveMinReaders(undefined)).toBe(MIN_READERS)
  })

  it('lets a caller raise it', () => {
    expect(effectiveMinReaders(String(MIN_READERS + 10))).toBe(MIN_READERS + 10)
  })

  it('defaults to at least two readers', () => {
    expect(MIN_READERS).toBeGreaterThanOrEqual(2)
  })
})

describe('parseNewHighlight', () => {
  const valid = { id: ID, bookId: BOOK, locationStart: 10, locationEnd: 40, text: 'quoted text' }

  it('accepts a valid highlight, lowercases ids and leaves visibility to the user default', () => {
    const result = parseNewHighlight(valid)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.id).toBe(ID.toLowerCase())
    expect(result.value.bookId).toBe(BOOK.toLowerCase())
    expect(result.value.visibility).toBeUndefined()
    expect(result.value.color).toBe('yellow')
  })

  it.each([
    [{ ...valid, bookId: 'not-a-uuid' }, 'bookId'],
    [{ ...valid, locationEnd: 5 }, 'locationEnd'],
    [{ ...valid, locationStart: 1.5 }, 'locationStart'],
    [{ ...valid, text: '   ' }, 'text'],
    [{ ...valid, color: 'purple' }, 'color'],
    [{ ...valid, visibility: 'everyone' }, 'visibility'],
  ])('rejects %o', (body, field) => {
    const result = parseNewHighlight(body)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(field)
  })
})

describe('parseHighlightChanges', () => {
  it('requires at least one known field', () => {
    expect(parseHighlightChanges({}).ok).toBe(false)
    expect(parseHighlightChanges({ text: 'immutable' }).ok).toBe(false)
  })

  it('allows clearing a note with null', () => {
    expect(parseHighlightChanges({ note: null })).toEqual({ ok: true, value: { note: null } })
  })
})

describe('parseSyncOp', () => {
  it('requires a client-generated id on offline creates', () => {
    const op = { opId: 'op-1', kind: 'create', highlight: { bookId: BOOK, locationStart: 0, locationEnd: 4, text: 'word' } }
    const result = parseSyncOp(op)
    expect(result.ok).toBe(false)
  })

  it('parses updates and deletes', () => {
    const update = parseSyncOp({ opId: 'op-2', kind: 'update', id: ID, changes: { color: 'blue' }, clientUpdatedAt: 1700000000000 })
    expect(update).toEqual({
      ok: true,
      value: { opId: 'op-2', kind: 'update', id: ID.toLowerCase(), changes: { color: 'blue' }, clientUpdatedAt: 1700000000000 },
    })
    expect(parseSyncOp({ opId: 'op-3', kind: 'delete', id: ID }).ok).toBe(true)
  })

  it('rejects unknown kinds and bad timestamps', () => {
    expect(parseSyncOp({ opId: 'op-4', kind: 'archive', id: ID }).ok).toBe(false)
    expect(parseSyncOp({ opId: 'op-5', kind: 'delete', id: ID, clientUpdatedAt: 'yesterday' }).ok).toBe(false)
  })
})
