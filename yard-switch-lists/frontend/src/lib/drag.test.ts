import { describe, expect, it } from 'vitest'
import { clampToEditable, insertionIndex } from './drag'

const rows = [0, 1, 2, 3, 4].map((i) => ({ top: i * 40, bottom: (i + 1) * 40 }))

describe('insertionIndex', () => {
  it('moves a row up to the slot under the pointer', () => {
    expect(insertionIndex(10, rows, 3)).toBe(0)
    expect(insertionIndex(50, rows, 3)).toBe(1)
  })

  it('moves a row down, accounting for its own slot being vacated', () => {
    expect(insertionIndex(130, rows, 0)).toBe(2)
    expect(insertionIndex(1000, rows, 0)).toBe(4)
  })

  it('stays put when dropped on itself', () => {
    expect(insertionIndex(70, rows, 1)).toBe(1)
  })
})

describe('clampToEditable', () => {
  it('never lands above moves that have already happened', () => {
    expect(clampToEditable(1, 4, 10)).toBe(4)
    expect(clampToEditable(7, 4, 10)).toBe(7)
    expect(clampToEditable(99, 4, 10)).toBe(9)
  })
})
