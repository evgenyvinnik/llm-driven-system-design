import { describe, it, expect } from 'vitest'
import { aggregatePassages, passageIdFor, type Contribution } from './passage.js'

describe('passageIdFor', () => {
  it('snaps a range outward to the 100-location window grid', () => {
    expect(passageIdFor(0, 69)).toBe('0-100')
    expect(passageIdFor(179, 269)).toBe('100-300')
    expect(passageIdFor(100, 200)).toBe('100-200')
  })

  it('groups slightly different selections of the same sentence', () => {
    expect(passageIdFor(5, 60)).toBe(passageIdFor(0, 69))
  })

  it('never produces an empty window', () => {
    expect(passageIdFor(0, 0)).toBe('0-100')
    expect(passageIdFor(300, 300)).toBe('300-400')
  })
})

const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 1, 12, minute))

function contribution(userId: string, start: number, end: number, text: string, minute = 0): Contribution {
  return { userId, locationStart: start, locationEnd: end, text, createdAt: at(minute) }
}

describe('aggregatePassages', () => {
  it('counts distinct readers, not highlights', () => {
    const rows = [
      contribution('u1', 0, 60, 'Call me Ishmael'),
      contribution('u1', 2, 60, 'all me Ishmael'),
      contribution('u2', 0, 60, 'Call me Ishmael'),
    ]
    const [passage] = aggregatePassages(rows, 2)
    expect(passage.readerCount).toBe(2)
  })

  it('publishes nothing below the threshold', () => {
    const rows = ['u1', 'u2', 'u3', 'u4'].map((u) => contribution(u, 200, 250, 'Victory Mansions'))
    expect(aggregatePassages(rows, 5)).toEqual([])
    expect(aggregatePassages(rows, 4)).toHaveLength(1)
  })

  it('shows the selection most readers made, with its own location range', () => {
    const rows = [
      contribution('u1', 0, 40, 'It was a bright cold day'),
      contribution('u2', 0, 72, 'It was a bright cold day in April, and the clocks were striking thirteen'),
      contribution('u3', 0, 72, 'It was a bright cold day in April, and the clocks were striking thirteen'),
    ]
    const [passage] = aggregatePassages(rows, 3)
    expect(passage.passageText).toBe('It was a bright cold day in April, and the clocks were striking thirteen')
    expect([passage.locationStart, passage.locationEnd]).toEqual([0, 72])
  })

  it('orders passages by readers and records the newest contribution', () => {
    const rows = [
      contribution('u1', 0, 50, 'opening', 1),
      contribution('u2', 0, 50, 'opening', 7),
      contribution('u1', 150, 180, 'middle', 3),
      contribution('u2', 150, 180, 'middle', 4),
      contribution('u3', 150, 180, 'middle', 5),
    ]
    const passages = aggregatePassages(rows, 2)
    expect(passages.map((p) => [p.passageId, p.readerCount])).toEqual([
      ['100-200', 3],
      ['0-100', 2],
    ])
    expect(passages[1].lastContributionAt).toEqual(at(7))
  })
})
