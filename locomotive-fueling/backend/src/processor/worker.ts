/**
 * Telemetry processor. Consumes the partition streams (the local stand-in for
 * Kafka topics keyed by locomotive id) with a consumer group, and for each
 * batch:
 *   1. runs the estimator per locomotive in sequence order,
 *   2. writes history to PostgreSQL (ON CONFLICT DO NOTHING drops replays),
 *   3. saves estimator state and the latest-state hash (sequence-guarded),
 *   4. opens alerts and enqueues re-plan triggers,
 *   5. acknowledges the stream entries, only after all of the above.
 * A crash anywhere before step 5 means redelivery; every step is idempotent.
 * @module processor/worker
 */
import type { Redis } from 'ioredis'
import { forecastBurn, legAt, reserveGallons, tiltOffset, unitShares } from '../domain/consumption.js'
import { raiseAlert, resolveAlert, type AlertIntent } from '../shared/alerts.js'
import { createRedisConnection, keys, redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { publishEvent } from '../shared/events.js'
import { logger } from '../shared/logger.js'
import { processorLagSeconds, telemetryProcessed } from '../shared/metrics.js'
import { simNow } from '../shared/sim-clock.js'
import { readStates, writeStateGuarded, type LocoState } from '../shared/state.js'
import { enqueuePlan } from '../shared/triggers.js'
import { applyCorrection, CAL_MIN_EVIDENCE, calibration, initialRuntime, leakSuspects, step, type Correction, type Effect, type LocoRuntime, type Reading } from './estimator.js'
import { FleetCache, type TrainView } from './fleet-cache.js'

const GROUP = 'processor'

interface Entry {
  stream: string
  id: string
  reading?: Reading
  correction?: Correction
}

interface Row {
  r: Reading
  trainId: string | null
  smoothed: number | null
  late: boolean
}

export class ProcessorWorker {
  private reader: Redis
  private running = false
  private runtimes = new Map<string, LocoRuntime>()
  private lastNode = new Map<string, number>()
  private lastPublish = new Map<string, number>()
  private cache = new FleetCache()
  private streams: string[]
  private consumer: string

  constructor(partitions: number[]) {
    this.reader = createRedisConnection('processor-reader')
    this.streams = partitions.map((p) => keys.telemetryStream(p))
    this.consumer = `proc-${partitions.join('-')}`
  }

  private async ensureGroups(): Promise<void> {
    for (const stream of this.streams) {
      try {
        await redis.xgroup('CREATE', stream, GROUP, '0', 'MKSTREAM')
      } catch (err) {
        if (!String((err as Error).message).includes('BUSYGROUP')) throw err
      }
    }
  }

  async start(): Promise<void> {
    await this.ensureGroups()
    this.running = true
    void this.loop()
  }

  async stop(): Promise<void> {
    this.running = false
    this.reader.disconnect()
  }

  private async loop(): Promise<void> {
    // First drain this consumer's own pending entries (delivered before a crash, never acked).
    let draining = true
    while (this.running) {
      try {
        const ids = this.streams.map(() => (draining ? '0' : '>'))
        const res = (await this.reader.xreadgroup(
          'GROUP', GROUP, this.consumer, 'COUNT', config.processor.readCount, 'BLOCK', draining ? 1 : 2000, 'STREAMS', ...this.streams, ...ids,
        )) as [string, [string, string[]][]][] | null
        const entries: Entry[] = []
        for (const [stream, messages] of res ?? []) {
          for (const [id, fields] of messages) {
            const r = fields.indexOf('r')
            const c = fields.indexOf('c')
            if (r >= 0) entries.push({ stream, id, reading: JSON.parse(fields[r + 1]) as Reading })
            else if (c >= 0) entries.push({ stream, id, correction: JSON.parse(fields[c + 1]) as Correction })
            else entries.push({ stream, id })
          }
        }
        if (draining && entries.length === 0) {
          draining = false
          continue
        }
        if (entries.length) await this.handle(entries)
      } catch (err) {
        if (!this.running) return
        // The streams were deleted (e.g. a reseed): recreate the group and carry on.
        if (String((err as Error).message).includes('NOGROUP')) {
          this.runtimes.clear()
          await this.ensureGroups().catch(() => undefined)
          continue
        }
        logger.error({ err }, 'processor loop error')
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }

  private async runtimeFor(locoId: string, first: Reading, seeded: LocoState | undefined): Promise<LocoRuntime> {
    const cached = this.runtimes.get(locoId)
    if (cached) return cached
    const raw = await redis.get(keys.locoFilter(locoId))
    if (raw) return JSON.parse(raw) as LocoRuntime
    // No saved estimator: start from the seeded latest state if there is one, else from the reading.
    if (seeded) return initialRuntime(seeded.fuelGal, seeded.seq, seeded.recordedAt, seeded.milepost)
    return initialRuntime(first.fuelGal, -1, first.recordedAt, first.milepost)
  }

  async handle(entries: Entry[]): Promise<void> {
    await this.cache.refresh()
    const params = this.cache.params
    // Per locomotive, in stream order: readings and ticket corrections interleaved as they arrived.
    const byLoco = new Map<string, (Reading | Correction)[]>()
    for (const e of entries) {
      const item = e.reading ?? e.correction
      if (!item) continue
      const list = byLoco.get(item.locomotiveId) ?? []
      list.push(item)
      byLoco.set(item.locomotiveId, list)
    }
    if ([...byLoco.keys()].some((id) => !this.cache.byLoco.has(id))) await this.cache.refresh(true)
    const seeded = await readStates([...byLoco.keys()].filter((id) => !this.runtimes.has(id)))

    const rows: Row[] = []
    const effects: { locoId: string; trainId: string | null; effect: Effect; at: number }[] = []
    const latest = new Map<string, { r: Reading; state: LocoRuntime }>()
    const touchedTrains = new Set<string>()

    for (const [locoId, readings] of byLoco) {
      const link = this.cache.byLoco.get(locoId)
      const capacity = link?.unit.tankGal ?? 5000
      const reserve = reserveGallons(capacity, params.reservePct, params.reserveMinGal)
      const first = readings.find((x): x is Reading => 'seq' in x)
      let state = await this.runtimeFor(locoId, first ?? ({ fuelGal: 0, recordedAt: 0, milepost: 0 } as Reading), seeded.get(locoId))
      for (const item of readings) {
        if (!('seq' in item)) {
          state = applyCorrection(state, item, capacity)
          continue
        }
        const r = item
        const forecast =
          link && r.milepost > state.lastMilepost && state.lastSeq >= 0
            ? (link.view.baseShare.get(locoId) ?? 0) *
              forecastBurn(link.view.legs, state.lastMilepost, r.milepost, link.view.train.plannedTons, link.view.train.units.length).gallons
            : 0
        const tiltGal = link ? tiltOffset(legAt(link.view.legs, r.milepost)) : 0
        const res = step(state, r, { capacityGal: capacity, reserveGal: reserve, forecastGallons: forecast, tiltGal })
        rows.push({ r, trainId: link?.view.train.id ?? null, smoothed: res.smoothed, late: !res.applied })
        if (res.applied) {
          state = res.state
          latest.set(locoId, { r, state })
          for (const effect of res.effects) effects.push({ locoId, trainId: link?.view.train.id ?? null, effect, at: r.recordedAt })
        }
      }
      this.runtimes.set(locoId, state)
      if (link) touchedTrains.add(link.view.train.id)
    }

    // History. Rows that collide on (locomotive_id, seq) were already stored: true duplicates.
    const inserted = await this.insertTelemetry(rows)
    const firstSeen = new Set<string>()
    for (const row of rows) {
      const key = `${row.r.locomotiveId}:${row.r.seq}`
      // A second copy inside the same batch is a duplicate too, even though its key was inserted.
      const outcome = !inserted.has(key) || firstSeen.has(key) ? 'duplicate' : row.late ? 'late' : 'applied'
      firstSeen.add(key)
      telemetryProcessed.inc({ outcome })
    }

    // Estimator state and latest state.
    const pipe = redis.pipeline()
    for (const locoId of byLoco.keys()) pipe.set(keys.locoFilter(locoId), JSON.stringify(this.runtimes.get(locoId)))
    for (const [locoId, { r, state }] of latest) {
      const link = this.cache.byLoco.get(locoId)
      writeStateGuarded(pipe as unknown as { eval: (...args: (string | number)[]) => unknown }, {
        locomotiveId: locoId,
        seq: r.seq,
        recordedAt: r.recordedAt,
        trainId: link?.view.train.id ?? null,
        milepost: r.milepost,
        speedMph: r.speedMph,
        notch: r.notch,
        engineState: r.engineState,
        fuelRaw: r.fuelGal,
        fuelGal: state.level,
        capacityGal: link?.unit.tankGal ?? 5000,
        calibration: calibration(state),
        sensorSuspect: state.sensorSuspect,
        leakSuspect: state.leakSuspect,
        lat: r.lat,
        lon: r.lon,
      })
    }
    await pipe.exec()

    for (const e of effects) await this.applyEffect(e.locoId, e.trainId, e.effect, e.at)
    for (const trainId of touchedTrains) {
      const view = this.cache.trains.get(trainId)
      if (view) await this.trainChecks(view)
    }

    await this.ack(entries)
    if (rows.length) {
      const newest = Math.max(...rows.map((r) => r.r.recordedAt))
      processorLagSeconds.set(Math.max(0, ((await simNow()).getTime() - newest) / 1000))
    }
  }

  private async insertTelemetry(rows: Row[]): Promise<Set<string>> {
    if (rows.length === 0) return new Set()
    const res = await pool.query<{ locomotive_id: string; seq: string }>(
      `INSERT INTO telemetry (locomotive_id, seq, recorded_at, train_id, milepost, lat, lon, speed_mph, notch, engine_state, fuel_raw, fuel_smoothed, late)
       SELECT * FROM unnest($1::text[], $2::bigint[], $3::timestamptz[], $4::text[], $5::float8[], $6::float8[], $7::float8[],
                            $8::float8[], $9::smallint[], $10::text[], $11::float8[], $12::float8[], $13::boolean[])
       ON CONFLICT (locomotive_id, seq) DO NOTHING
       RETURNING locomotive_id, seq`,
      [
        rows.map((x) => x.r.locomotiveId),
        rows.map((x) => x.r.seq),
        rows.map((x) => new Date(x.r.recordedAt)),
        rows.map((x) => x.trainId),
        rows.map((x) => x.r.milepost),
        rows.map((x) => x.r.lat),
        rows.map((x) => x.r.lon),
        rows.map((x) => x.r.speedMph),
        rows.map((x) => x.r.notch),
        rows.map((x) => x.r.engineState),
        rows.map((x) => x.r.fuelGal),
        rows.map((x) => x.smoothed),
        rows.map((x) => x.late),
      ],
    )
    return new Set(res.rows.map((r) => `${r.locomotive_id}:${r.seq}`))
  }

  private async applyEffect(locoId: string, trainId: string | null, effect: Effect, at: number): Promise<void> {
    const when = new Date(at)
    const alert = (a: Omit<AlertIntent, 'trainId' | 'locomotiveId'>) => raiseAlert({ ...a, trainId, locomotiveId: locoId }, when)
    switch (effect.kind) {
      case 'fueling_completed': {
        const view = trainId ? this.cache.trains.get(trainId) : undefined
        const node = view?.nodes.find((n) => Math.abs(n.milepost - effect.milepost) < 1.5)
        await pool.query(
          `INSERT INTO fueling_events (locomotive_id, train_id, location_id, started_at, ended_at, level_before, level_after, gallons_observed)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (locomotive_id, started_at) DO NOTHING`,
          [locoId, trainId, node?.locationId ?? null, new Date(effect.startedAt), new Date(effect.endedAt), effect.levelBefore, effect.levelAfter, effect.levelAfter - effect.levelBefore],
        )
        if (trainId) await enqueuePlan(trainId, 'fueled', `unit ${locoId} took on ~${Math.round(effect.levelAfter - effect.levelBefore)} gal`)
        return
      }
      case 'sensor_fault':
        await alert({
          type: 'sensor_fault',
          severity: 'warning',
          message: `Unit ${locoId}: fuel level read +${Math.round(effect.jumpGal)} gal while moving. Sensor ignored; level now estimated from throttle notch.`,
          details: { jumpGal: Math.round(effect.jumpGal) },
        })
        return
      case 'stationary_loss':
        await alert({
          type: 'leak_suspected',
          severity: 'critical',
          message: `Unit ${locoId}: lost ${Math.round(effect.lossGal)} gal beyond idle burn in ${effect.hours.toFixed(1)} h while stationary (leak or theft).`,
          details: { lossGal: Math.round(effect.lossGal) },
        })
        if (trainId) await enqueuePlan(trainId, 'leak_suspected', `stationary loss on ${locoId}`)
        return
      case 'low_fuel': {
        await alert({ type: 'low_fuel', severity: 'critical', message: `Unit ${locoId} is below reserve: ${Math.round(effect.level)} gal.`, details: { level: Math.round(effect.level) } })
        return
      }
      case 'fuel_recovered':
        await resolveAlert(`low_fuel:${locoId}`, when)
        return
    }
  }

  /** Train-level checks: station passage, burn deviation, leak vs consist-mates, range to the next fuel. */
  private async trainChecks(view: TrainView): Promise<void> {
    const params = this.cache.params
    const { train } = view
    const units = train.units.map((u) => ({ u, rt: this.runtimes.get(u.locomotiveId) })).filter((x) => x.rt)
    if (units.length === 0) return
    const lead = units.find((x) => x.u.role === 'lead')?.rt ?? units[0].rt!
    const mile = lead.lastMilepost
    const at = new Date(lead.lastAt)

    // Station passage → checkpoint re-plan.
    let idx = -1
    view.nodes.forEach((n, i) => {
      if (n.milepost <= mile + 0.01) idx = i
    })
    const prevIdx = this.lastNode.get(train.id)
    this.lastNode.set(train.id, idx)
    if (prevIdx !== undefined && idx > prevIdx && idx >= 0) {
      const node = view.nodes[idx]
      await pool.query(`UPDATE trains SET last_milepost = $2, last_location = $3, updated_at = now() WHERE id = $1`, [train.id, mile, node.locationId])
      await enqueuePlan(train.id, 'checkpoint', `passed ${node.locationId}`)
    }

    // Leak while moving: one unit burning far above its consist-mates.
    const suspects = leakSuspects(units.map(({ u, rt }) => ({ id: u.locomotiveId, cal: calibration(rt!), evidence: rt!.calForecast })))
    for (const id of suspects) {
      const rt = this.runtimes.get(id)!
      if (rt.leakSuspect) continue
      rt.leakSuspect = true
      await redis.set(keys.locoFilter(id), JSON.stringify(rt))
      await raiseAlert(
        {
          type: 'leak_suspected',
          severity: 'critical',
          trainId: train.id,
          locomotiveId: id,
          message: `Unit ${id} is burning ${Math.round((calibration(rt) - 1) * 100)}% above forecast while its consist-mates are on model. Possible fuel leak.`,
          details: { calibration: calibration(rt) },
        },
        at,
      )
      await enqueuePlan(train.id, 'leak_suspected', `unit ${id} burning ${calibration(rt).toFixed(2)}× forecast`)
    }

    // Burn deviation vs what the current plan assumed.
    const healthy = units.filter(({ rt }) => !rt!.sensorSuspect && !rt!.leakSuspect)
    const fa = healthy.reduce((s, { rt }) => s + rt!.calForecast, 0)
    if (healthy.length > 0 && fa > CAL_MIN_EVIDENCE * healthy.length) {
      const kTrain = healthy.reduce((s, { rt }) => s + rt!.calActual, 0) / fa
      await redis.set(keys.trainCal(train.id), kTrain.toFixed(4))
      const planCal = Number((await redis.get(keys.trainPlanCal(train.id))) ?? 1)
      if (Math.abs(kTrain - planCal) > params.deviationBand) {
        const pct = Math.round((kTrain - 1) * 100)
        await enqueuePlan(train.id, 'burn_deviation', `burn running ${pct >= 0 ? '+' : ''}${pct}% vs forecast (plan assumed ${Math.round((planCal - 1) * 100)}%)`)
      }
    }

    // Range check, independent of the planner: can the consist reach the next fuel facility above reserve?
    const next = this.cache.nextFuelNode(view, mile)
    if (next) {
      const shares = unitShares(train.units.map((u) => ({ horsepower: u.horsepower, modelFactor: u.modelFactor, calibration: calibration(this.runtimes.get(u.locomotiveId) ?? initialRuntime(0)), online: u.online })))
      let headroom = Infinity
      train.units.forEach((u, i) => {
        const rt = this.runtimes.get(u.locomotiveId)
        if (!rt) return
        headroom = Math.min(headroom, (rt.level - reserveGallons(u.tankGal, params.reservePct, params.reserveMinGal)) / shares[i])
      })
      const need = forecastBurn(view.legs, mile, next.milepost, train.plannedTons, train.units.length).gallons * (1 + params.safetyMarginPct)
      const dedupKey = `range_risk:${train.id}`
      if (headroom < need) {
        await raiseAlert(
          {
            type: 'range_risk',
            severity: 'warning',
            trainId: train.id,
            locomotiveId: null,
            dedupKey,
            message: `${train.symbol} may not reach ${next.locationId} above reserve (needs ~${Math.round(need)} train-gal, has ~${Math.round(Math.max(0, headroom))}).`,
          },
          at,
        )
      } else if (headroom > need * 1.2) {
        await resolveAlert(dedupKey, at)
      }
    }

    const now = Date.now()
    if (now - (this.lastPublish.get(train.id) ?? 0) > 1000) {
      this.lastPublish.set(train.id, now)
      await publishEvent({ type: 'train', trainId: train.id })
    }
  }

  private async ack(entries: Entry[]): Promise<void> {
    const byStream = new Map<string, string[]>()
    for (const e of entries) byStream.set(e.stream, [...(byStream.get(e.stream) ?? []), e.id])
    for (const [stream, ids] of byStream) await redis.xack(stream, GROUP, ...ids)
  }
}
