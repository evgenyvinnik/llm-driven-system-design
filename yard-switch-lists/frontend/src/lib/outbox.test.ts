import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newReportId, outbox } from './outbox'

describe('outbox', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    })
    outbox.remove(outbox.list().map((r) => r.clientReportId))
  })

  it('queues reports in order and removes only what the server took', () => {
    outbox.add({ clientReportId: 'a', moveKey: 'm1', kind: 'start', offline: true })
    outbox.add({ clientReportId: 'b', moveKey: 'm1', kind: 'complete', offline: true })
    outbox.add({ clientReportId: 'c', moveKey: 'm2', kind: 'start', offline: true })
    expect(outbox.list().map((r) => r.clientReportId)).toEqual(['a', 'b', 'c'])
    outbox.remove(['a', 'b'])
    expect(outbox.list().map((r) => r.clientReportId)).toEqual(['c'])
  })

  it('shows a move as done or started locally before it syncs', () => {
    outbox.add({ clientReportId: 'a', moveKey: 'm1', kind: 'start', offline: true })
    expect(outbox.localStatus('m1')).toBe('in_progress')
    outbox.add({ clientReportId: 'b', moveKey: 'm1', kind: 'complete', offline: true })
    expect(outbox.localStatus('m1')).toBe('done')
    expect(outbox.localStatus('other')).toBeNull()
  })

  it('still works when browser storage refuses', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
      },
    })
    outbox.add({ clientReportId: 'x', moveKey: 'm9', kind: 'start', offline: true })
    expect(outbox.list().some((r) => r.clientReportId === 'x')).toBe(true)
  })

  it('makes a different id each time', () => {
    expect(newReportId()).not.toBe(newReportId())
  })
})
