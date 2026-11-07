/**
 * In-memory CorrelatorStore. Used by the tests (order-independence, late
 * upgrade, train-explained downgrade, duplicate redelivery) so the same engine
 * code that runs against PostgreSQL is exercised without a database.
 * @module correlator/memory-store
 */
import { randomUUID } from 'node:crypto'
import type { DomainEventDraft } from '../shared/events/domain.js'
import { HAZARD_CLOSING_TYPES } from '../shared/events/domain.js'
import type { CorrelatorStore, Trigger } from './engine.js'
import type { Sample } from './heat.js'
import type { Evidence, HazardRecord, TrainFix } from './rules.js'

export interface AppendedEvent {
  streamId: string
  version: number
  type: string
  payload: Record<string, unknown>
}

export class MemoryCorrelatorStore implements CorrelatorStore {
  evidence = new Map<string, Evidence>()
  hazards = new Map<string, HazardRecord>()
  events: AppendedEvent[] = []
  trains: TrainFix[] = []
  samples = new Map<string, Sample[]>()
  heat = new Map<string, { band: string; hazardId: string | null }>()
  private codes = 1000

  async nearbyEvidence(sub: string, mpFrom: number, mpTo: number, fromIso: string, toIso: string): Promise<Evidence[]> {
    return [...this.evidence.values()].filter((e) => e.subdivisionId === sub && e.milepost >= mpFrom - 1e-9 && e.milepost <= mpTo + 1e-9 && e.occurredAt >= fromIso && e.occurredAt <= toIso).map((e) => ({ ...e }))
  }

  async openHazardsNear(sub: string, mpFrom: number, mpTo: number): Promise<HazardRecord[]> {
    return [...this.hazards.values()].filter((h) => h.subdivisionId === sub && h.mpTo >= mpFrom - 1e-9 && h.mpFrom <= mpTo + 1e-9 && this.isOpen(h.hazardId)).map((h) => ({ ...h }))
  }

  async hazardEvidence(hazardId: string): Promise<Evidence[]> {
    return [...this.evidence.values()].filter((e) => e.hazardId === hazardId).map((e) => ({ ...e }))
  }

  async hazardRecord(hazardId: string): Promise<HazardRecord | null> {
    const h = this.hazards.get(hazardId)
    return h ? { ...h } : null
  }

  async saveEvidence(e: Evidence): Promise<void> {
    if (!this.evidence.has(e.eventId)) this.evidence.set(e.eventId, { ...e })
  }

  async updateEvidence(ids: string[], patch: { hazardId?: string | null; explainedByTrain?: string | null }): Promise<void> {
    for (const id of ids) {
      const e = this.evidence.get(id)
      if (!e) continue
      if (patch.hazardId !== undefined) e.hazardId = patch.hazardId
      if (patch.explainedByTrain !== undefined) e.explainedByTrain = patch.explainedByTrain
    }
  }

  async saveHazard(h: HazardRecord): Promise<void> {
    this.hazards.set(h.hazardId, { ...h })
  }

  async newHazard(): Promise<{ hazardId: string; code: string }> {
    this.codes += 1
    return { hazardId: randomUUID(), code: `HZ-${this.codes}` }
  }

  async appendHazard(h: HazardRecord, drafts: DomainEventDraft[], _trigger: Trigger): Promise<number> {
    const streamId = `hazard-${h.hazardId}`
    const current = this.events.filter((e) => e.streamId === streamId).length
    if (current !== h.streamVersion) throw new Error(`concurrency: ${streamId} at ${current}, expected ${h.streamVersion}`)
    drafts.forEach((d, i) => this.events.push({ streamId, version: current + i + 1, type: d.type, payload: d.payload as Record<string, unknown> }))
    return current + drafts.length
  }

  /** Simulates a person closing a hazard (HazardCleared). */
  close(hazardId: string): void {
    const streamId = `hazard-${hazardId}`
    const version = this.events.filter((e) => e.streamId === streamId).length + 1
    this.events.push({ streamId, version, type: 'HazardCleared', payload: { hazardId, by: 'test' } })
  }

  private isOpen(hazardId: string): boolean {
    return !this.events.some((e) => e.streamId === `hazard-${hazardId}` && HAZARD_CLOSING_TYPES.includes(e.type as never))
  }

  async hazardStreamState(hazardId: string): Promise<{ open: boolean; version: number } | null> {
    const events = this.events.filter((e) => e.streamId === `hazard-${hazardId}`)
    if (events.length === 0) return null
    return { open: this.isOpen(hazardId), version: events.length }
  }

  addTrainFix(f: TrainFix): void {
    if (!this.trains.some((t) => t.trainId === f.trainId && t.occurredAt === f.occurredAt)) this.trains.push(f)
  }

  async trainFixesAround(_sub: string, atIso: string): Promise<Array<{ before: TrainFix | null; after: TrainFix | null }>> {
    const ids = [...new Set(this.trains.map((t) => t.trainId))]
    return Promise.all(ids.map((id) => this.trainFixesAdjacent(id, atIso, true)))
  }

  async trainFixesAdjacent(trainId: string, atIso: string, inclusive = false): Promise<{ before: TrainFix | null; after: TrainFix | null }> {
    const mine = this.trains.filter((t) => t.trainId === trainId).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    const before = [...mine].reverse().find((t) => (inclusive ? t.occurredAt <= atIso : t.occurredAt < atIso)) ?? null
    const after = mine.find((t) => t.occurredAt > atIso) ?? null
    return { before, after }
  }

  async unexplainedVibration(sub: string, mpFrom: number, mpTo: number, fromIso: string, toIso: string): Promise<Evidence[]> {
    return (await this.nearbyEvidence(sub, mpFrom, mpTo, fromIso, toIso)).filter((e) => e.kind === 'ground_vibration' && !e.explainedByTrain)
  }

  async railTempSamples(sensorId: string, sinceIso: string): Promise<Sample[]> {
    return (this.samples.get(sensorId) ?? []).filter((s) => s.occurredAt >= sinceIso)
  }

  async addRailTempSample(sensorId: string, s: Sample): Promise<void> {
    const list = this.samples.get(sensorId) ?? []
    if (!list.some((x) => x.occurredAt === s.occurredAt)) list.push(s)
    this.samples.set(sensorId, list)
  }

  async heatState(segmentId: string) {
    return this.heat.get(segmentId) ?? null
  }

  async setHeatState(segmentId: string, band: string, hazardId: string | null): Promise<void> {
    this.heat.set(segmentId, { band, hazardId })
  }
}
