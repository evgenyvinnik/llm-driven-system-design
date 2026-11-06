/**
 * Re-derives the "late reading after a wheelset swap" decision purely from the
 * event store (plus the fact-log rows its claim checks point to).
 *
 * The follow-up: a detector reconnects and uploads a hot reading measured two
 * hours ago, but that wheelset was replaced an hour ago. `npm run
 * demo:component-swap` produces exactly that. This tool reads the trip's events
 * (ConsistVersionChanged, PassRecorded, AxleReadingsRecorded) and the cars'
 * ComponentReplaced events, rebuilds identity and trend state in memory with the
 * analyzer's own pure functions, and decides again:
 *   1. in log order (global position, i.e. the order we learned things), and
 *   2. with the install moved to the end of the log, as if the repair had been
 *      recorded after the late reading arrived.
 * Both must end with the same open cases as the ones the live system recorded:
 * an alert for the car whose wheelset was NOT replaced, none for the one that was.
 * In order 2 the replaced car's alert opens and then closes as
 * component_replaced, which is what the analyzer does on ComponentReplaced.
 * @module replay/swap-case
 */
import type { Queryable } from '../shared/db.js'
import type { Direction, Rail } from '../shared/domain.js'
import { DETECTORS, yardById } from '../shared/network.js'
import { loadThresholds } from '../shared/thresholds.js'
import { describeEvent } from '../events/describe.js'
import { toEnvelope, type EventEnvelope, type StoredEventRow } from '../events/envelope.js'
import { currentInstalls, type Install } from '../analyzer/components.js'
import { buildAxleMap, consistRevisionAt, decideIdentity, resolveAxle, type ConsistUnit } from '../analyzer/identity.js'
import { scoreTripPure, passContextOf } from '../analyzer/pipeline.js'
import type { PassContext, ReadingRow } from '../analyzer/trend.js'
import { TIER_NAMES } from '../shared/domain.js'

type P = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

interface Model {
  consists: Array<{ revision: number; effectiveAtMs: number; units: ConsistUnit[] }>
  passes: Map<string, PassContext>
  rows: ReadingRow[]
  installs: Install[]
  open: Map<string, number>
  closed: Set<string>
}

const hhmm = (iso: string) => iso.slice(11, 16)

async function readingsFor(db: Queryable, e: EventEnvelope, m: Model): Promise<void> {
  const p = e.payload as P
  // Claim check: the readings and the pass's AEI read live in the fact log, keyed by (detector, pass).
  const [readings, pass] = await Promise.all([
    db.query<{ axle_seq: number; rail: Rail; bearing_f: number; wheel_f: number }>(
      'SELECT axle_seq, rail, bearing_f, wheel_f FROM axle_readings WHERE detector_id = $1 AND pass_id = $2', [p.claimCheck.detectorId, p.claimCheck.passId]),
    db.query<{ aei: Array<{ position: number; unitId: string; leadingEnd: 'A' | 'B' }> | null; edge_alarms: Array<{ axleSeq: number; rail: Rail }> | null; ambient_f: number; direction: Direction; passed_at: Date; lag_seconds: number }>(
      'SELECT aei, edge_alarms, ambient_f, direction, passed_at, lag_seconds FROM detector_passes WHERE detector_id = $1 AND pass_id = $2', [p.detectorId, p.passId]),
  ])
  const f = pass.rows[0]
  const site = DETECTORS.find((d) => d.id === p.detectorId)!
  const revision = consistRevisionAt(m.consists.map((c) => ({ revision: c.revision, effectiveAtMs: c.effectiveAtMs })), f.passed_at.getTime())
  const units = m.consists.find((c) => c.revision === revision)?.units ?? []
  const decision = decideIdentity(units, p.axleCount, f.aei)
  if (decision.status === 'unresolved') return
  const map = buildAxleMap(decision.units)
  m.passes.set(`${p.detectorId}|${p.passId}`, passContextOf({ ...f, detector_id: p.detectorId, pass_id: p.passId, milepost: site.milepost, braking_zone: site.brakingZone }, 0))
  for (const r of readings.rows) {
    const at = resolveAxle(map, r.axle_seq, r.rail, f.direction)
    if (!at) continue
    m.rows.push({ detectorId: p.detectorId, passId: p.passId, axleSeq: r.axle_seq, rail: r.rail, bearingF: r.bearing_f, wheelF: r.wheel_f, carId: at.carId, carSide: at.carSide, carAxle: at.carAxle, passedAtMs: f.passed_at.getTime() })
  }
}

async function derive(db: Queryable, log: EventEnvelope[], originMp: number, label: string): Promise<Map<string, number>> {
  const { config: thresholds } = await loadThresholds(db, true)
  const m: Model = { consists: [], passes: new Map(), rows: [], installs: [], open: new Map(), closed: new Set() }
  console.log(`\n  ${label}`)
  for (const e of log) {
    const p = e.payload as P
    if (e.type === 'ConsistVersionChanged') {
      m.consists.push({ revision: p.revision, effectiveAtMs: new Date(p.effectiveAt).getTime(), units: p.units })
    } else if (e.type === 'ComponentReplaced') {
      m.installs.push({ carId: p.carId, axle: p.axle, installedAtMs: new Date(p.installedAt).getTime(), removedAtMs: null })
    } else if (e.type === 'AxleReadingsRecorded') {
      await readingsFor(db, e, m)
    } else continue
    const scored = scoreTripPure({ passes: m.passes, rows: m.rows, cutoffs: currentInstalls(m.installs), history: new Map(), originMp, thresholds })
    const now = new Map(scored.candidates.filter((c) => c.score.tier > 0).map((c) => [`${c.carId}|${c.kind}|${c.position}`, c.score.tier]))
    const changes: string[] = []
    for (const [k, tier] of now) {
      if (!m.open.has(k)) changes.push(`raise ${TIER_NAMES[tier]} ${k.replace(/\|/g, ' ')}`)
      else if (tier > m.open.get(k)!) changes.push(`escalate ${k.replace(/\|/g, ' ')} to ${TIER_NAMES[tier]}`)
      m.open.set(k, Math.max(tier, m.open.get(k) ?? 0))
    }
    // Alerts never de-escalate; a case only closes when all its evidence predates the current wheelset.
    for (const k of [...m.open.keys()]) {
      const [carId, , position] = k.split('|')
      if (!now.has(k) && scored.replacedKeys.has(`${carId}|${position}`)) {
        m.open.delete(k)
        m.closed.add(k)
        changes.push(`close ${k.replace(/\|/g, ' ')} as component_replaced`)
      }
    }
    const excluded = scored.previous.length
    console.log(`   #${String(e.globalPosition).padStart(5)} ${e.type.padEnd(22)} occurred ${hhmm(e.occurredAt)}Z recorded ${hhmm(e.recordedAt)}Z  ${describeEvent(e).slice(0, 80)}`)
    if (excluded > 0 && e.type !== 'ConsistVersionChanged') console.log(`          ${excluded} reading(s) predate the wheelset now on their axle: history of the old wheelset, not evidence`)
    for (const c of changes) console.log(`          -> ${c}`)
  }
  return m.open
}

export async function replaySwapCase(db: Queryable, tripArg?: string): Promise<boolean> {
  const tripId =
    tripArg ??
    (await db.query<{ t: string }>(`SELECT payload->>'tripId' AS t FROM events WHERE type = 'ConsistVersionChanged' AND payload->>'tripId' LIKE 'DEMO-SWAP-%' ORDER BY global_position DESC LIMIT 1`)).rows[0]?.t
  if (!tripId) {
    console.log('No component-swap demo trip in the event store. Run `npm run demo:component-swap` first (or pass --trip).')
    return false
  }
  const tripRows = await db.query<StoredEventRow>(
    `SELECT * FROM events WHERE tags @> ARRAY[$1]::text[] AND type = ANY($2) ORDER BY global_position`,
    [`trip:${tripId}`, ['ConsistVersionChanged', 'PassRecorded', 'AxleReadingsRecorded', 'AlertRaised', 'AlertEscalated', 'CaseClosed']],
  )
  const tripEvents = tripRows.rows.map(toEnvelope)
  const consist = tripEvents.find((e) => e.type === 'ConsistVersionChanged')
  if (!consist) {
    console.log(`No consist for ${tripId} in the event store.`)
    return false
  }
  const cars = ((consist.payload as P).units as Array<{ unitId: string; unitType: string }>).filter((u) => u.unitType === 'car').map((u) => `car-${u.unitId}`)
  const carRows = await db.query<StoredEventRow>(`SELECT * FROM events WHERE stream_id = ANY($1) AND type = 'ComponentReplaced' ORDER BY global_position`, [cars])
  const installs = carRows.rows.map(toEnvelope)
  const facts = [...tripEvents.filter((e) => ['ConsistVersionChanged', 'AxleReadingsRecorded'].includes(e.type)), ...installs].sort((a, b) => a.globalPosition - b.globalPosition)
  const originMp = yardById(String((consist.payload as P).originYardId))!.milepost

  console.log(`Re-deriving ${tripId} from ${facts.length} events (and the fact-log rows their claim checks name):`)
  const inLogOrder = await derive(db, facts, originMp, 'Order 1: as recorded (global position)')
  const lateInstall = [...facts.filter((e) => e.type !== 'ComponentReplaced'), ...facts.filter((e) => e.type === 'ComponentReplaced')]
  const installLast = await derive(db, lateInstall, originMp, 'Order 2: the wheelset install recorded after the late reading')

  // What the live system recorded: cases raised for this trip and not closed.
  const raised = new Map<string, string>()
  const closedIds = new Set(tripEvents.filter((e) => e.type === 'CaseClosed').map((e) => String((e.payload as P).caseId)))
  for (const e of tripEvents.filter((x) => x.type === 'AlertRaised')) {
    const p = e.payload as P
    if (!closedIds.has(p.caseId)) raised.set(`${p.carId}|${p.kind}|${p.position}`, p.caseId)
  }
  const keys = (m: Map<string, unknown>) => [...m.keys()].sort().join(', ') || 'none'
  console.log(`\n  open cases recorded live:     ${keys(raised)}`)
  console.log(`  re-derived, order 1:          ${keys(inLogOrder)}`)
  console.log(`  re-derived, order 2:          ${keys(installLast)}`)
  const ok = keys(raised) === keys(inLogOrder) && keys(inLogOrder) === keys(installLast)
  console.log(ok ? '\n  MATCH: the decision follows from the events alone, in either order.' : '\n  MISMATCH: see the traces above.')
  return ok
}
