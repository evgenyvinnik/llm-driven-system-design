import { describe, expect, it } from 'vitest'
import { Fleet } from './fleet.js'
import { generateFleet, mulberry32 } from './generate.js'

function setup() {
  let now = Date.parse('2026-11-05T12:00:00Z')
  const state = generateFleet(42, 4, 60, now)
  state.faults = { ...state.faults, error5xxRate: 0 }
  const fleet = new Fleet(state, () => now, mulberry32(1))
  return { fleet, advance: (ms: number) => (now += ms), account: fleet.state.accounts[0] }
}

describe('fleet generation', () => {
  it('is deterministic for a seed', () => {
    const a = generateFleet(5, 10, 200, 0)
    const b = generateFleet(5, 10, 200, 0)
    expect(a.accounts.map((x) => x.name)).toEqual(b.accounts.map((x) => x.name))
    expect(a.accounts).toHaveLength(200)
    expect(new Set(a.accounts.map((x) => x.name)).size).toBe(200)
  })

  it('never generates a caller that the current config already breaks', async () => {
    const { clientBlocked } = await import('./traffic.js')
    const state = generateFleet(11, 20, 800, 0)
    for (const a of state.accounts) for (const c of a.clients) expect(clientBlocked(c, a.account.props)).toBe(false)
  })
})

describe('control-plane semantics', () => {
  it('rejects a write whose If-Match etag is stale with 412', () => {
    const { fleet, account } = setup()
    const etag = account.account.etag
    expect(fleet.writeResource(account.id, { properties: { minimumTlsVersion: 'TLS1_2' } }, etag).status).toBe(200)
    expect(fleet.writeResource(account.id, { properties: { allowSharedKeyAccess: false } }, etag).status).toBe(412)
  })

  it('throttles writes per subscription with 429 and Retry-After', () => {
    const { fleet, account, advance } = setup()
    fleet.setFaults({ writeCapacity: 2, writeRefillPerSec: 0.5 })
    expect(fleet.writeResource(account.id, { properties: {} }, undefined).status).toBe(200)
    expect(fleet.writeResource(account.id, { properties: {} }, undefined).status).toBe(200)
    const throttled = fleet.writeResource(account.id, { properties: {} }, undefined)
    expect(throttled.status).toBe(429)
    expect(throttled.headers?.['Retry-After']).toBe('2')
    const other = fleet.state.accounts.find((a) => a.subscriptionId !== account.subscriptionId)!
    expect(fleet.writeResource(other.id, { properties: {} }, undefined).status).toBe(200)
    advance(2000)
    expect(fleet.writeResource(account.id, { properties: {} }, undefined).status).toBe(200)
  })

  it('shows writes in Resource Graph only after the lag, while ARM reads are immediate', () => {
    const { fleet, account, advance } = setup()
    fleet.setFaults({ graphLagMs: 10_000 })
    const before = account.account.props.allowSharedKeyAccess
    fleet.writeResource(account.id, { properties: { allowSharedKeyAccess: !before } }, undefined)
    const graphRow = () => (fleet.graphQuery({ top: 1000 }, 'p').body as { data: { id: string; properties: { allowSharedKeyAccess: boolean } }[] }).data.find((r) => r.id === account.id)!
    expect((fleet.getResource(account.id).body as { properties: { allowSharedKeyAccess: boolean } }).properties.allowSharedKeyAccess).toBe(!before)
    expect(graphRow().properties.allowSharedKeyAccess).toBe(before)
    advance(10_000)
    expect(graphRow().properties.allowSharedKeyAccess).toBe(!before)
  })

  it('records every change in the feed and expires old cursors with 410', () => {
    const { fleet, account } = setup()
    fleet.writeResource(account.id, { properties: { minimumTlsVersion: 'TLS1_2' } }, undefined)
    fleet.writeResource(`${account.id}/blobServices/default`, { properties: { deleteRetentionPolicy: { enabled: true, days: 7 } } }, undefined)
    const page = fleet.changesSince(0, 10).body as { events: { kind: string }[]; latest: number }
    expect(page.events.map((e) => e.kind)).toEqual(['account', 'blobService'])
    expect(fleet.changesSince(99, 10).status).toBe(410)
  })

  it('applies policy effects to every writer: deny rejects, modify corrects', () => {
    const { fleet, account } = setup()
    fleet.setPolicy('SA-01', 'deny')
    const denied = fleet.writeResource(account.id, { properties: { allowBlobPublicAccess: true } }, undefined)
    expect(denied.status).toBe(403)
    fleet.setPolicy('SA-01', 'modify')
    const created = fleet.createFromTemplate(mulberry32(3))
    expect(created.status).toBe('created')
    expect(fleet.account(created.id!)!.account.props.allowBlobPublicAccess).toBe(false)
    fleet.setPolicy('SA-02', 'deny')
    expect(fleet.createFromTemplate(mulberry32(4)).status).toBe('denied')
  })

  it('synthesizes logs only within the window that logging has existed', () => {
    const { fleet } = setup()
    const withLogs = fleet.state.accounts.find((a) => a.diagnostics.props.enabled)!
    const withoutLogs = fleet.state.accounts.find((a) => !a.diagnostics.props.enabled)!
    const rows = (ids: string[]) => (fleet.queryLogs(ids, 30).body as { tables: { rows: unknown[][] }[] }).tables[0].rows
    expect(rows([withLogs.id]).length).toBeGreaterThan(0)
    expect(rows([withoutLogs.id])).toHaveLength(0)
  })

  it('turns a removed auth path into 403s for the callers that use it', () => {
    const { fleet, account, advance } = setup()
    fleet.writeResource(account.id, { properties: { allowSharedKeyAccess: true } }, undefined)
    fleet.injectHiddenDependency(account.id, 'AccountKey')
    fleet.setFaults({ periodicFireDelayMs: 0 })
    const start = Date.parse('2026-11-05T12:00:00Z')
    fleet.writeResource(account.id, { properties: { allowSharedKeyAccess: false } }, undefined)
    advance(30_000)
    const series = (fleet.metrics(account.id, start, start + 30_000).body as { value: { timeseries: { metadatavalues: { value: string }[]; data: { total: number }[] }[] }[] }).value[0].timeseries
    const errors = series.find((s) => s.metadatavalues[0].value === 'AuthorizationError')!.data.reduce((n, d) => n + d.total, 0)
    expect(errors).toBeGreaterThan(10)
  })
})
