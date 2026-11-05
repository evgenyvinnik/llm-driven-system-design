/**
 * The processor's view of the fleet: which train each locomotive is in, the
 * train's path as legs, and the fuel options along it. Refreshed every few
 * seconds from PostgreSQL (consists and paths change on reroutes and new trips).
 * @module processor/fleet-cache
 */
import { buildLegs, nodeMileposts, type Leg } from '../domain/consumption.js'
import type { ModelParams } from '../domain/params.js'
import { loadFuelOptions, loadParams, loadTracks, loadTrains, type ConsistUnitRow, type FuelOptionRow, type TrainRow } from '../shared/repo.js'

export interface TrainView {
  train: TrainRow
  legs: Leg[]
  nodes: { locationId: string; milepost: number }[]
  totalMiles: number
  /** Horsepower share × model factor per unit, without calibration. */
  baseShare: Map<string, number>
}

export class FleetCache {
  private loadedAt = 0
  trains = new Map<string, TrainView>()
  byLoco = new Map<string, { view: TrainView; unit: ConsistUnitRow }>()
  options: FuelOptionRow[] = []
  params!: ModelParams

  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.loadedAt < 5000) return
    const [tracks, trains, options, params] = await Promise.all([loadTracks(), loadTrains({ status: 'running' }), loadFuelOptions(), loadParams()])
    const nextTrains = new Map<string, TrainView>()
    const nextByLoco = new Map<string, { view: TrainView; unit: ConsistUnitRow }>()
    for (const train of trains) {
      const legs = buildLegs(train.path, tracks)
      const online = train.units.filter((u) => u.online)
      const totalHp = online.reduce((s, u) => s + u.horsepower, 0) || 1
      const view: TrainView = {
        train,
        legs,
        nodes: nodeMileposts(legs),
        totalMiles: legs.length ? legs[legs.length - 1].endMile : 0,
        baseShare: new Map(train.units.map((u) => [u.locomotiveId, u.online ? (u.horsepower / totalHp) * u.modelFactor : 0.02])),
      }
      nextTrains.set(train.id, view)
      for (const unit of train.units) nextByLoco.set(unit.locomotiveId, { view, unit })
    }
    this.trains = nextTrains
    this.byLoco = nextByLoco
    this.options = options
    this.params = params
    this.loadedAt = Date.now()
  }

  /** The next node ahead of a milepost that has an active fuel option. */
  nextFuelNode(view: TrainView, milepost: number): { locationId: string; milepost: number } | null {
    const active = new Set(this.options.filter((o) => o.active).map((o) => o.locationId))
    return view.nodes.find((n, i) => i < view.nodes.length - 1 && n.milepost > milepost + 0.5 && active.has(n.locationId)) ?? null
  }
}
