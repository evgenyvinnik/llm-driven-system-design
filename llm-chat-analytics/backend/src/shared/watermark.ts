/**
 * "Complete through" watermarks, one per stream.
 *
 * Each Kafka partition reports a position: the received_time of the last
 * message ingest has written to ClickHouse, or "now" when the partition has no
 * backlog. Kafka keeps each partition in arrival order, so everything received
 * before a partition's position has been processed. The slowest partition
 * bounds what we know, and each stream subtracts its lateness allowance (how
 * long after happening an event can still reasonably arrive). The result is a
 * claim the UI can make honestly: events with event_time before the watermark
 * have almost certainly all been counted.
 * @module shared/watermark
 */
import type { Stream } from './contract.js'

export interface PartitionPosition {
  /** Epoch ms: everything received before this has been ingested. */
  position: number
  /** Epoch ms when the owning ingest instance last reported. */
  updatedAt: number
  /** Messages still waiting in this partition at the last report. */
  lag?: number
}

export type Watermarks = Record<Stream, number | null>

export interface WatermarkReport {
  watermarks: Watermarks
  /** Slowest partition position, before lateness allowances. */
  processedThrough: number | null
  /** Partitions that never reported: the watermark is unknown until they do. */
  missing: number[]
  /** Partitions whose owner stopped reporting. They hold the watermark back. */
  stalled: number[]
  totalLag: number
}

export function computeWatermarks(
  positions: Record<string, PartitionPosition>,
  partitionCount: number,
  now: number,
  allowanceMs: Record<Stream, number>,
  staleMs: number,
): WatermarkReport {
  const missing: number[] = []
  const stalled: number[] = []
  let processedThrough: number | null = null
  let totalLag = 0

  for (let p = 0; p < partitionCount; p++) {
    const pos = positions[String(p)]
    if (!pos) {
      missing.push(p)
      continue
    }
    if (now - pos.updatedAt > staleMs) stalled.push(p)
    totalLag += pos.lag ?? 0
    processedThrough = processedThrough === null ? pos.position : Math.min(processedThrough, pos.position)
  }

  if (missing.length > 0 || processedThrough === null) {
    return { watermarks: { client: null, server: null }, processedThrough: null, missing, stalled, totalLag }
  }
  return {
    watermarks: {
      client: processedThrough - allowanceMs.client,
      server: processedThrough - allowanceMs.server,
    },
    processedThrough,
    missing,
    stalled,
    totalLag,
  }
}
