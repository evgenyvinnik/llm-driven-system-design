import { describe, it, expect } from 'vitest'
import { initialClock, MAX_CLOCK_SKEW_MS, mergeFieldUpdates, type FieldClock, type MutableValues } from './lww.js'

const NOW = 1_700_000_000_000

function created(ts = NOW - 60_000, device = 'kindle'): { current: MutableValues; clock: FieldClock } {
  return {
    current: { note: 'first note', color: 'yellow', visibility: 'private' },
    clock: initialClock(ts, device, NOW),
  }
}

describe('mergeFieldUpdates', () => {
  it('applies an edit that is newer than the field stamp', () => {
    const { current, clock } = created()
    const result = mergeFieldUpdates({ current, clock, changes: { note: 'edited' }, clientTs: NOW, deviceId: 'phone', serverNow: NOW })
    expect(result.applied).toEqual(['note'])
    expect(result.next.note).toBe('edited')
    expect(result.clock.note).toEqual({ ts: NOW, device: 'phone' })
  })

  it('rejects an older edit that arrives late (an offline device syncing after a newer edit)', () => {
    const { current, clock } = created()
    const newer = mergeFieldUpdates({ current, clock, changes: { note: 'from phone' }, clientTs: NOW, deviceId: 'phone', serverNow: NOW })
    const stale = mergeFieldUpdates({
      current: newer.next,
      clock: newer.clock,
      changes: { note: 'from kindle, typed earlier offline' },
      clientTs: NOW - 30_000,
      deviceId: 'kindle',
      serverNow: NOW,
    })
    expect(stale.applied).toEqual([])
    expect(stale.superseded).toEqual(['note'])
    expect(stale.next.note).toBe('from phone')
  })

  it('keeps concurrent edits to different fields from both devices', () => {
    const { current, clock } = created()
    const color = mergeFieldUpdates({ current, clock, changes: { color: 'blue' }, clientTs: NOW - 1000, deviceId: 'kindle', serverNow: NOW })
    const note = mergeFieldUpdates({
      current: color.next,
      clock: color.clock,
      changes: { note: 'phone note' },
      clientTs: NOW - 2000,
      deviceId: 'phone',
      serverNow: NOW,
    })
    expect(note.next).toEqual({ note: 'phone note', color: 'blue', visibility: 'private' })
  })

  it('converges to the same value whichever order two same-field edits arrive in', () => {
    const { current, clock } = created()
    const a = { changes: { note: 'A' }, clientTs: NOW - 5000, deviceId: 'kindle' }
    const b = { changes: { note: 'B' }, clientTs: NOW - 4000, deviceId: 'phone' }

    const ab1 = mergeFieldUpdates({ current, clock, ...a, serverNow: NOW })
    const ab = mergeFieldUpdates({ current: ab1.next, clock: ab1.clock, ...b, serverNow: NOW })
    const ba1 = mergeFieldUpdates({ current, clock, ...b, serverNow: NOW })
    const ba = mergeFieldUpdates({ current: ba1.next, clock: ba1.clock, ...a, serverNow: NOW })

    expect(ab.next.note).toBe('B')
    expect(ba.next.note).toBe('B')
  })

  it('breaks a same-millisecond tie by device id, identically in both orders', () => {
    const { current, clock } = created()
    const x = { changes: { color: 'green' }, clientTs: NOW, deviceId: 'device-a' }
    const y = { changes: { color: 'pink' }, clientTs: NOW, deviceId: 'device-b' }
    const xy1 = mergeFieldUpdates({ current, clock, ...x, serverNow: NOW })
    const xy = mergeFieldUpdates({ current: xy1.next, clock: xy1.clock, ...y, serverNow: NOW })
    const yx1 = mergeFieldUpdates({ current, clock, ...y, serverNow: NOW })
    const yx = mergeFieldUpdates({ current: yx1.next, clock: yx1.clock, ...x, serverNow: NOW })
    expect(xy.next.color).toBe('pink')
    expect(yx.next.color).toBe('pink')
  })

  it('clamps a device clock set far in the future so it cannot win forever', () => {
    const { current, clock } = created()
    const nextYear = NOW + 365 * 24 * 3600 * 1000
    const skewed = mergeFieldUpdates({ current, clock, changes: { note: 'wrong clock' }, clientTs: nextYear, deviceId: 'broken', serverNow: NOW })
    expect(skewed.clock.note?.ts).toBe(NOW + MAX_CLOCK_SKEW_MS)

    const later = NOW + MAX_CLOCK_SKEW_MS + 1000
    const fixed = mergeFieldUpdates({
      current: skewed.next,
      clock: skewed.clock,
      changes: { note: 'correct' },
      clientTs: later,
      deviceId: 'phone',
      serverNow: later,
    })
    expect(fixed.next.note).toBe('correct')
  })

  it('treats a replayed edit as unchanged (neither applied nor superseded)', () => {
    const { current, clock } = created()
    const edit = { changes: { note: 'same' }, clientTs: NOW, deviceId: 'phone', serverNow: NOW }
    const first = mergeFieldUpdates({ current, clock, ...edit })
    const replay = mergeFieldUpdates({ current: first.next, clock: first.clock, ...edit })
    expect(replay.applied).toEqual([])
    expect(replay.superseded).toEqual([])
  })

  it('clears a note when the change is null', () => {
    const { current, clock } = created()
    const result = mergeFieldUpdates({ current, clock, changes: { note: null }, clientTs: NOW, deviceId: 'web', serverNow: NOW })
    expect(result.next.note).toBeNull()
  })
})
