import { describe, expect, it, vi } from 'vitest'

vi.mock('../shared/db.js', () => ({ pool: { query: vi.fn() } }))
vi.mock('../shared/cache.js', () => ({ redis: { publish: vi.fn() } }))

import { csvCell } from './export-runner.js'

describe('csvCell', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a, b')).toBe('"a, b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"')
  })

  it('defuses spreadsheet formulas in customer-written text', () => {
    expect(csvCell('=HYPERLINK("http://evil.example","click")')).toBe('"\'=HYPERLINK(""http://evil.example"",""click"")"')
    expect(csvCell('+1 555')).toBe("'+1 555")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
  })

  it('writes dates as ISO strings and nulls as empty', () => {
    expect(csvCell(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10-01T00:00:00.000Z')
    expect(csvCell(null)).toBe('')
  })
})
