/**
 * Broker streams: one Valkey stream per event family, standing in for Kafka
 * topics. The relay publishes every event from the store to exactly one of
 * them. Detector readings are split into a live and a backfill lane at ingest,
 * by how late they arrived, so a reconnecting site's backlog never queues in
 * front of fresh readings from other sites.
 * @module shared/stream
 */
import { config } from './config.js'

export type Lane = 'live' | 'backfill'

/** Every broker stream, in the order the Ops page lists them. */
export const FAMILIES = [
  'wayside.passes',
  'wayside.readings.live',
  'wayside.readings.backfill',
  'identity',
  'trends',
  'trips.position',
  'detectors.health',
  'cases',
  'cars',
] as const
export type Family = (typeof FAMILIES)[number]

export const streamKey = (family: string) => `${config.stream.prefix}${family}`
export const familyOfKey = (key: string) => key.slice(config.stream.prefix.length)
export const laneKey = (lane: Lane) => streamKey(lane === 'live' ? 'wayside.readings.live' : 'wayside.readings.backfill')

/**
 * Fresh passes go to the live lane; passes that sat in a gateway buffer go to
 * the backfill lane, so a reconnecting site's hours of backlog never queue in
 * front of a new critical reading from another site.
 */
export function laneFor(lagSeconds: number, lateAfterMinutes = config.analysis.lateAfterMinutes): Lane {
  return lagSeconds > lateAfterMinutes * 60 ? 'backfill' : 'live'
}

export function fieldsToObject(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < fields.length; i += 2) out[fields[i]] = fields[i + 1]
  return out
}
