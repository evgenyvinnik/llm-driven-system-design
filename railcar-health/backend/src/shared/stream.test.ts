import { describe, expect, it } from 'vitest'
import { laneFor } from './stream.js'

describe('lanes', () => {
  it('sends fresh passes to the live lane and buffered ones to backfill', () => {
    expect(laneFor(30, 15)).toBe('live')
    expect(laneFor(15 * 60, 15)).toBe('live')
    expect(laneFor(15 * 60 + 1, 15)).toBe('backfill')
    expect(laneFor(2 * 3600, 15)).toBe('backfill')
  })
})
