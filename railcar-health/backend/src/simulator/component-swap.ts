/**
 * Demo of the component-lifecycle follow-up: "a detector reconnects and uploads
 * a concerning reading recorded 2 hours ago, but that wheelset was replaced 1
 * hour ago."
 *
 *   npm run demo:component-swap [-- --api http://localhost:3000]
 *
 * It builds a short demo train with two cars whose L2 bearings read hot at one
 * detector. HPRX 555001 had its axle-2 wheelset replaced an hour ago (recorded
 * by a yard user); HPRX 555002 did not. The hot reading, measured two hours ago,
 * arrives now through the backfill lane. Expected: an alert for 555002 only;
 * 555001's reading is kept as history of the old wheelset.
 */
import { parseArgs } from 'node:util'
import { config } from '../shared/config.js'
import { post } from './client.js'

const { values: args } = parseArgs({ options: { api: { type: 'string', default: config.apiUrl } } })
const api = args.api!

async function json(path: string, init: RequestInit & { cookie?: string } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${api}/api/v1${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.cookie ? { Cookie: init.cookie } : {}) },
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

async function login(username: string): Promise<string> {
  const res = await fetch(`${api}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password123' }) })
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  if (!res.ok || !cookie) throw new Error(`login failed for ${username}: ${res.status}`)
  return cookie
}

function readings(units: Array<{ type: string; carId?: string }>, hot: Set<string>, ambient: number) {
  const axles: Array<{ seq: number; rail: 'N' | 'S'; bearingF: number; wheelF: number }> = []
  let seq = 0
  for (const u of units) {
    const count = u.type === 'locomotive' ? 6 : 4
    for (let i = 1; i <= count; i++) {
      seq += 1
      for (const rail of ['N', 'S'] as const) {
        // Westbound with the A-end leading: the car's L side is on the south rail and axle 2 is the 3rd to arrive.
        const isHot = u.carId !== undefined && hot.has(u.carId) && rail === 'S' && i === 3
        axles.push({ seq, rail, bearingF: ambient + 38 + (seq % 5) + (isHot ? 62 : 0), wheelF: ambient + 12 })
      }
    }
  }
  return { axles, axleCount: seq }
}

async function main(): Promise<void> {
  const clock = await json('/clock')
  const nowMs = new Date(String(clock.body.now)).getTime()
  const iso = (offsetMin: number) => new Date(nowMs + offsetMin * 60_000).toISOString()
  const tripId = `DEMO-SWAP-${Math.floor(nowMs / 1000)}`
  const cars = ['HPRX 555001', 'HPRX 555002', 'HPRX 555003', 'HPRX 555004', 'HPRX 555005', 'HPRX 555006', 'HPRX 555007', 'HPRX 555008']
  const units: Array<{ type: string; carId?: string }> = [{ type: 'locomotive' }, ...cars.map((carId) => ({ type: 'car', carId }))]

  const consist = await post(api, '/consists', {
    tripId, symbol: 'X-DEMO', direction: 'WB', originYardId: 'CDJ', destinationYardId: 'HAR', stops: ['HAR'], departedAt: iso(-170), revision: 1,
    units: units.map((u, i) => ({
      position: i + 1, unitId: u.carId ?? 'PLNR 4999', unitType: u.type, axleCount: u.type === 'locomotive' ? 6 : 4, leadingEnd: 'A',
      ownerMark: 'HPRX', ownerName: 'High Plains Railcar', carType: 'boxcar',
    })),
  })
  console.log(`1. consist ${tripId}: HTTP ${consist.status}`)

  const bob = await login('bob')
  const install = await json('/cars/HPRX%20555001/components', {
    method: 'POST', cookie: bob,
    body: JSON.stringify({ clientSubmissionId: `${tripId}-install`, axle: 2, componentId: 'WS-2026-118842', installedAt: iso(-60) }),
  })
  console.log(`2. wheelset WS-2026-118842 installed on HPRX 555001 axle 2, event time ${iso(-60)}: HTTP ${install.status}`)

  // An earlier, normal pass so the trip has context, then the late hot one.
  const normal = readings(units, new Set(), 55)
  await post(api, '/passes', { gatewayId: 'GW-112', sentAt: iso(-135), passes: [{ passId: `${tripId}-112`, detectorId: 'HBD-112', tripId, passedAt: iso(-135), direction: 'WB', speedMph: 45, ambientF: 55, ...normal }] })
  const hot = readings(units, new Set(['HPRX 555001', 'HPRX 555002']), 55)
  const late = await post(api, '/passes', {
    gatewayId: 'GW-100', sentAt: iso(0),
    passes: [{ passId: `${tripId}-100`, detectorId: 'HBD-100', tripId, passedAt: iso(-120), direction: 'WB', speedMph: 45, ambientF: 55, ...hot }],
  })
  const result = (late.body as { results?: Array<{ lagMinutes: number; lane: string }> }).results?.[0]
  console.log(`3. HBD-100 reconnects and uploads a pass measured at ${iso(-120)} (lag ${result?.lagMinutes} min, ${result?.lane} lane): HTTP ${late.status}`)

  const carol = await login('carol')
  let alerts: Array<{ carId: string; tierName: string; position: string; reasons: string[] }> = []
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const res = await json(`/alerts?status=all`, { cookie: carol })
    alerts = ((res.body.alerts as typeof alerts) ?? []).filter((a) => a.carId.startsWith('HPRX 55500'))
    if (alerts.length > 0) break
  }
  console.log('4. alerts on the demo cars:')
  for (const a of alerts) console.log(`   ${a.tierName} ${a.carId} ${a.position}: ${a.reasons[0]}`)
  const replaced = alerts.some((a) => a.carId === 'HPRX 555001')
  console.log(replaced ? '   UNEXPECTED: the replaced wheelset was blamed for the old reading' : '   HPRX 555001: no alert. The reading predates its new wheelset and is kept only as history.')
  const trend = await json('/cars/HPRX%20555001/trend?position=L2', { cookie: carol })
  const points = ((trend.body.series as Array<{ points: Array<{ detectorId: string; superseded: boolean; sideDelta: number }> }>) ?? [])[0]?.points ?? []
  console.log(`5. HPRX 555001 L2 history: ${points.map((p) => `${p.detectorId} ${p.sideDelta >= 0 ? '+' : ''}${p.sideDelta}°F${p.superseded ? ' (previous wheelset)' : ''}`).join(', ')}`)
  // The demo train is still "en route" from Cedar Junction; say it arrived so it doesn't linger.
  await post(api, '/trip-events', { eventId: `${tripId}:arrived`, tripId, kind: 'arrived', yardId: 'HAR', at: iso(0) })
}

await main()
