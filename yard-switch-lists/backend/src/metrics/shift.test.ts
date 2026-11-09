import { describe, expect, it } from 'vitest'
import { shiftMetrics } from './shift.js'

/** Answers each metrics query by its text, as the database would for these rows. */
function stub(answers: Record<string, Record<string, unknown>>) {
  return {
    query: async (text: string) => {
      for (const [needle, row] of Object.entries(answers)) if (text.includes(needle)) return { rows: Object.keys(row).length ? [row] : [] }
      return { rows: [] }
    },
  } as never
}

const base = {
  'FROM moves WHERE list_id': { n: 60 },
  'FROM shifts WHERE': { status: 'open', starts_at: '2026-11-09T06:00:00Z', ends_at: '2026-11-09T18:00:00Z' },
  'FROM outbound_trains': { due: 4, on_time: 3, late: 0, missed: 1 },
  'FROM car_handlings': { handlings: 90, cars: 50 },
  'FROM cars c JOIN': { departed: 40, hours: '6.256' },
  "FROM cars WHERE position = 'on_track'": { n: 12 },
  'FROM capacity_events': { n: 2 },
  'count(*) FILTER (WHERE NOT refused)': { accepted: 3, refused: 1 },
  'FROM switch_lists WHERE shift_id = $1': { n: 5, replans: 4 },
  'FROM crew_reports': { n: 100, exceptions: 2 },
}

describe('shift metrics', () => {
  it('computes each rate from the raw counts', async () => {
    const m = await shiftMetrics(stub(base), 1, new Date('2026-11-09T12:00:00Z'))
    expect(m).toMatchObject({ trainsDue: 4, departedOnTime: 3, missed: 1, onTimePct: 75, movesPerCar: 1.8, avgDwellHours: 6.26, capacityViolations: 2, overrides: 3, refusedOverrides: 1, overrideRatePer100Moves: 5, planVersions: 5, carsOnHand: 12 })
  })

  it('returns no rates when nothing has happened yet', async () => {
    const m = await shiftMetrics(stub({ ...base, 'FROM moves WHERE list_id': { n: 0 }, 'FROM outbound_trains': { due: 0, on_time: 0, late: 0, missed: 0 }, 'FROM car_handlings': { handlings: 0, cars: 0 }, 'FROM cars c JOIN': { departed: 0, hours: null } }), 1, new Date())
    expect(m).toMatchObject({ onTimePct: null, movesPerCar: null, avgDwellHours: null, overrideRatePer100Moves: null })
  })

  it('returns null for an unknown shift', async () => {
    expect(await shiftMetrics(stub({}), 99, null)).toBeNull()
  })
})
