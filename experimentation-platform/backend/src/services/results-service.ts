/**
 * Experiment results, computed from ClickHouse at read time (so late events
 * are included the moment they land).
 *
 * For each experiment the same query runs twice: once over exposures (the
 * analysis) and once over assignments (for comparison). A unit's first event
 * fixes its variant and config version; a conversion counts if it happened
 * strictly after that first event and within the attribution window.
 *
 * Every aggregate is duplicate-insensitive (distinct units, min time, "any
 * conversion in window"), so a duplicate row that ReplacingMergeTree has not
 * merged away yet cannot change a number. Raw row counts are shown next to
 * distinct event counts so duplicates are visible rather than hidden.
 * @module services/results-service
 */
import { analyze, type AnalysisResult, type UnitAggregate } from '../domain/analysis.js'
import { chQuery } from '../shared/clickhouse.js'
import { config } from '../shared/config.js'
import { HttpError } from '../shared/errors.js'
import type { UnitType } from '../shared/evaluation.js'
import { allocationsByVersion, getFlag } from './flag-service.js'

/** Which conversion column joins to each unit type's bucketing id. */
const UNIT_COLUMN: Record<UnitType, string> = { user: 'stable_id', anonymous: 'anonymous_id', org: 'org_id' }

async function unitAggregates(table: 'exposures' | 'assignments', environment: string, flagKey: string, unitType: UnitType, metric: string, windowHours: number): Promise<UnitAggregate[]> {
  const col = UNIT_COLUMN[unitType]
  const rows = await chQuery<{ variant: string; version: number; units: number; crossovers: number; conversions: number }>(
    `SELECT first_variant AS variant, first_version AS version,
            toUInt32(count()) AS units,
            toUInt32(countIf(variants_seen > 1)) AS crossovers,
            toUInt32(countIf(variants_seen = 1 AND converted)) AS conversions
       FROM (
         SELECT e.unit_id, e.first_variant, e.first_version, e.variants_seen,
                countIf(c.ts > e.first_ts AND c.ts <= e.first_ts + toIntervalHour({window:UInt32})) > 0 AS converted
           FROM (
             SELECT unit_id,
                    argMin(variant, ts) AS first_variant,
                    argMin(flag_version, ts) AS first_version,
                    min(ts) AS first_ts,
                    uniqExact(variant) AS variants_seen
               FROM ${table}
              WHERE environment = {env:String} AND flag_key = {key:String}
              GROUP BY unit_id
           ) AS e
           LEFT JOIN (
             SELECT ${col} AS unit_id, ts FROM conversions
              WHERE environment = {env:String} AND event_name = {metric:String} AND ${col} != ''
           ) AS c ON c.unit_id = e.unit_id
          GROUP BY e.unit_id, e.first_variant, e.first_version, e.variants_seen
       )
      GROUP BY variant, version
      ORDER BY variant, version`,
    { env: environment, key: flagKey, metric, window: windowHours },
  )
  return rows.map((r) => ({ variant: r.variant, version: Number(r.version), units: Number(r.units), crossovers: Number(r.crossovers), conversions: Number(r.conversions) }))
}

interface EventCounts {
  rows: number
  unique: number
  late: number
  dataThrough: string | null
}

async function eventCounts(table: 'exposures' | 'assignments' | 'conversions', environment: string, filterColumn: string, filterValue: string): Promise<EventCounts> {
  const lateSeconds = Math.round(config.ingest.lateThresholdMs / 1000)
  const [row] = await chQuery<{ rows: number; unique_events: number; late: number; through: string }>(
    `SELECT toUInt32(count()) AS rows, toUInt32(uniqExact(event_id)) AS unique_events,
            toUInt32(uniqExactIf(event_id, dateDiff('second', ts, received_at) > {late:UInt32})) AS late,
            toString(max(received_at)) AS through
       FROM ${table} WHERE environment = {env:String} AND ${filterColumn} = {value:String}`,
    { env: environment, value: filterValue, late: lateSeconds },
  )
  const rows = Number(row?.rows ?? 0)
  return { rows, unique: Number(row?.unique_events ?? 0), late: Number(row?.late ?? 0), dataThrough: rows > 0 && row?.through ? `${row.through.replace(' ', 'T')}Z` : null }
}

export interface ResultsDTO {
  flag: {
    key: string
    name: string
    kind: string
    unitType: UnitType
    status: string
    version: number
    primaryMetric: string
    attributionWindowHours: number
    surface: string
    defaultVariant: string
    variants: { key: string; name: string }[]
    startedAt: string | null
    stoppedAt: string | null
  }
  environment: string
  exposed: AnalysisResult
  assigned: AnalysisResult
  events: { exposures: EventCounts; assignments: EventCounts; conversions: EventCounts; lateThresholdMinutes: number }
  computedAt: string
}

export async function getResults(flagKey: string, environment: string): Promise<ResultsDTO> {
  const flag = await getFlag(flagKey)
  if (flag.kind !== 'experiment') throw new HttpError(409, 'NOT_AN_EXPERIMENT', 'Flags have no analysis; only experiments log exposures')
  const cfg = flag.configs[environment]
  if (!cfg) throw new HttpError(404, 'NOT_FOUND', `No ${environment} config`)
  const allocations = await allocationsByVersion(flag.id, environment)
  const variants = flag.variants.map((v) => v.key)
  const [exposedRows, assignedRows, exposures, assignments, conversions] = await Promise.all([
    unitAggregates('exposures', environment, flag.key, flag.unitType, flag.primaryMetric, flag.attributionWindowHours),
    unitAggregates('assignments', environment, flag.key, flag.unitType, flag.primaryMetric, flag.attributionWindowHours),
    eventCounts('exposures', environment, 'flag_key', flag.key),
    eventCounts('assignments', environment, 'flag_key', flag.key),
    eventCounts('conversions', environment, 'event_name', flag.primaryMetric),
  ])
  const common = { variants, control: flag.defaultVariant, allocations, current: cfg.allocation }
  return {
    flag: {
      key: flag.key,
      name: flag.name,
      kind: flag.kind,
      unitType: flag.unitType,
      status: cfg.status,
      version: cfg.version,
      primaryMetric: flag.primaryMetric,
      attributionWindowHours: flag.attributionWindowHours,
      surface: flag.surface,
      defaultVariant: flag.defaultVariant,
      variants: flag.variants.map((v) => ({ key: v.key, name: v.name })),
      startedAt: cfg.startedAt,
      stoppedAt: cfg.stoppedAt,
    },
    environment,
    exposed: analyze({ ...common, rows: exposedRows }),
    assigned: analyze({ ...common, rows: assignedRows }),
    events: { exposures, assignments, conversions, lateThresholdMinutes: Math.round(config.ingest.lateThresholdMs / 60_000) },
    computedAt: new Date().toISOString(),
  }
}
