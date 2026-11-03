/**
 * Query hooks. Each widget's cache key is derived from the resolved query, so
 * two widgets asking the same question share one request, and a response can
 * only ever land in the cache entry for the question it answers: a slow reply
 * for old filters fills the old entry, never the one on screen.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  api,
  queryWidget,
  type BreakdownResponse,
  type DrilldownResponse,
  type FreshnessResponse,
  type LatencyResponse,
  type Meta,
  type OverviewResponse,
  type PipelineResponse,
  type SeriesResponse,
} from './api'
import { canonicalString, toParams, type Dimension, type ResolvedQuery } from './filters'

/** Ranges that include the current moment keep refreshing; closed ranges never change except through late data. */
function liveInterval(q: ResolvedQuery): number | false {
  return Date.parse(q.to) > Date.now() ? 60_000 : false
}

function widgetQuery<T extends { echo: string }>(widget: string, q: ResolvedQuery | null, extra: Record<string, string | undefined> = {}, enabled = true) {
  const echo = q ? canonicalString(q, extra) : ''
  return {
    queryKey: ['widget', widget, echo],
    queryFn: ({ signal }: { signal: AbortSignal }) => queryWidget<T>(widget, toParams(q!, extra), echo, signal),
    enabled: enabled && q !== null,
    // Keep the previous answer on screen, dimmed, while the new one loads.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    refetchInterval: q ? liveInterval(q) : false,
  }
}

export const useOverview = (q: ResolvedQuery | null) => useQuery(widgetQuery<OverviewResponse>('overview', q))

export const useSeries = (q: ResolvedQuery | null, metric: string, enabled = true) =>
  useQuery(widgetQuery<SeriesResponse>('series', q, { metric }, enabled))

export const useLatency = (q: ResolvedQuery | null) => useQuery(widgetQuery<LatencyResponse>('latency', q))

export const useBreakdown = (q: ResolvedQuery | null, metric: string, dim: Dimension) =>
  useQuery(widgetQuery<BreakdownResponse>('breakdown', q, { metric, dim }))

export function useDrilldown(q: ResolvedQuery | null, metric: string, bucket: string | undefined, offset: number) {
  const extra = { metric }
  const echo = q ? canonicalString(q, extra) : ''
  return useQuery({
    queryKey: ['drilldown', echo, bucket, offset],
    queryFn: ({ signal }) =>
      queryWidget<DrilldownResponse>('drilldown', toParams(q!, { ...extra, bucket, offset, limit: 25 }), echo, signal),
    enabled: q !== null && bucket !== undefined,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === bucket ? prev : undefined),
    retry: (count, err) => !(err instanceof Error && 'status' in err && [403, 400].includes((err as { status: number }).status)) && count < 2,
  })
}

export const useFreshness = (org: string | undefined) =>
  useQuery({
    queryKey: ['freshness', org],
    queryFn: ({ signal }) => api<FreshnessResponse>(`/freshness?org=${encodeURIComponent(org!)}`, { signal }),
    enabled: !!org,
    refetchInterval: 15_000,
  })

export const useMeta = () =>
  useQuery({ queryKey: ['meta'], queryFn: ({ signal }) => api<Meta>('/meta', { signal }), staleTime: 5 * 60_000 })

export const usePipeline = () =>
  useQuery({ queryKey: ['pipeline'], queryFn: ({ signal }) => api<PipelineResponse>('/pipeline', { signal }), refetchInterval: 5_000 })
