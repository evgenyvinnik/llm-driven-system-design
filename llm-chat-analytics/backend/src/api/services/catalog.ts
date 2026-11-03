/**
 * Metric catalog: the written definition, unit, stream, sensitivity and
 * formula of every number the dashboard can show. The definitions page, the
 * query API and the export worker all read this one list, so a metric cannot
 * mean one thing on a chart and another in a CSV.
 * @module api/services/catalog
 */
import type { EventType, Stream } from '../../shared/contract.js'

export const DIMENSIONS = ['model', 'feature'] as const
export type Dimension = (typeof DIMENSIONS)[number]

const BOTH: Dimension[] = ['model', 'feature']
const CONVERSATION_NOTE = 'a conversation is counted when it starts, before any feature is used. Messages sent and Active users can be split by feature.'

export interface Aggregates {
  conversations: number
  messages: number
  responses_ok: number
  responses_failed: number
  responses_abandoned: number
  input_tokens: number
  output_tokens: number
  cost_micros: number
  late_events: number
  last_revised_at: string | null
  active_users: number
  ttft: [number, number, number]
  latency: [number, number, number]
}

export const EMPTY_AGGREGATES: Aggregates = {
  conversations: 0,
  messages: 0,
  responses_ok: 0,
  responses_failed: 0,
  responses_abandoned: 0,
  input_tokens: 0,
  output_tokens: 0,
  cost_micros: 0,
  late_events: 0,
  last_revised_at: null,
  active_users: 0,
  ttft: [0, 0, 0],
  latency: [0, 0, 0],
}

export type Unit = 'count' | 'percent' | 'ms' | 'usd' | 'tokens'
export type Kind = 'sum' | 'ratio' | 'distinct' | 'percentile'

export interface MetricDef {
  id: string
  label: string
  unit: Unit
  kind: Kind
  definition: string
  /** Watermark that applies: the minimum over these streams. */
  streams: Stream[]
  /** billing: only roles with billing:read ever receive it. */
  sensitivity: 'standard' | 'billing'
  approximate: boolean
  higherIsBetter: boolean | null
  /** Dimensions the metric's events carry. Filtering by any other is refused, not answered with 0. */
  dimensions: Dimension[]
  dimensionNote?: string
  /** Raw events a drill-down lists for one bucket, and what the bucket's drill count counts. */
  drill: { eventTypes: EventType[]; counts: 'events' | 'users'; orderBy: 'time' | 'ttft' | 'latency' }
  value(a: Aggregates): number | null
  /** How many drill rows the bucket represents (shown next to the bar, checked against the drill-down). */
  drillCount(a: Aggregates): number
}

const attempts = (a: Aggregates) => a.responses_ok + a.responses_failed + a.responses_abandoned
const ratio = (num: number, den: number) => (den > 0 ? num / den : null)
const RESPONSES: EventType[] = ['response_completed', 'response_failed', 'response_abandoned']

export const METRICS: MetricDef[] = [
  {
    id: 'active_users',
    label: 'Active users',
    unit: 'count',
    kind: 'distinct',
    definition:
      'Distinct users who sent at least one message in the period. Opening the app or receiving a response does not make a user active. Counted with a HyperLogLog sketch (about ±1%); weekly and monthly values merge sketches, so they are never a sum of daily counts.',
    streams: ['client'],
    sensitivity: 'standard',
    approximate: true,
    higherIsBetter: true,
    dimensions: BOTH,
    drill: { eventTypes: ['message_sent'], counts: 'users', orderBy: 'time' },
    value: (a) => a.active_users,
    drillCount: (a) => a.active_users,
  },
  {
    id: 'conversations',
    label: 'Conversations',
    unit: 'count',
    kind: 'sum',
    definition:
      'Conversations started: one conversation_started event, counted in the bucket of its event time (when it happened, not when it arrived), whatever happens in the conversation afterwards.',
    streams: ['client'],
    sensitivity: 'standard',
    approximate: false,
    higherIsBetter: true,
    dimensions: ['model'],
    dimensionNote: CONVERSATION_NOTE,
    drill: { eventTypes: ['conversation_started'], counts: 'events', orderBy: 'time' },
    value: (a) => a.conversations,
    drillCount: (a) => a.conversations,
  },
  {
    id: 'messages',
    label: 'Messages sent',
    unit: 'count',
    kind: 'sum',
    definition: 'User messages sent (message_sent events). Regenerating a response does not send a message.',
    streams: ['client'],
    sensitivity: 'standard',
    approximate: false,
    higherIsBetter: true,
    dimensions: BOTH,
    drill: { eventTypes: ['message_sent'], counts: 'events', orderBy: 'time' },
    value: (a) => a.messages,
    drillCount: (a) => a.messages,
  },
  {
    id: 'success_rate',
    label: 'Successful responses',
    unit: 'percent',
    kind: 'ratio',
    definition:
      'Share of response attempts that completed: the model streamed to its natural end and the server delivered the final token. Attempts are completed + failed + abandoned. Before abandoned generations were tracked, the denominator excludes them.',
    streams: ['server'],
    sensitivity: 'standard',
    approximate: false,
    higherIsBetter: true,
    dimensions: BOTH,
    drill: { eventTypes: RESPONSES, counts: 'events', orderBy: 'time' },
    value: (a) => ratio(a.responses_ok, attempts(a)),
    drillCount: attempts,
  },
  {
    id: 'error_rate',
    label: 'Error rate',
    unit: 'percent',
    kind: 'ratio',
    definition: 'Share of response attempts that ended in a server-reported error (overloaded, timeout, internal, context length).',
    streams: ['server'],
    sensitivity: 'standard',
    approximate: false,
    higherIsBetter: false,
    dimensions: BOTH,
    drill: { eventTypes: ['response_failed'], counts: 'events', orderBy: 'time' },
    value: (a) => ratio(a.responses_failed, attempts(a)),
    drillCount: (a) => a.responses_failed,
  },
  {
    id: 'abandon_rate',
    label: 'Abandoned generations',
    unit: 'percent',
    kind: 'ratio',
    definition:
      'Share of response attempts the user stopped (stop button) or left (disconnect) after the request started and before the final token. Reported by the server, which sees the stream end, so a closed tab still counts.',
    streams: ['server'],
    sensitivity: 'standard',
    approximate: false,
    higherIsBetter: false,
    dimensions: BOTH,
    drill: { eventTypes: ['response_abandoned'], counts: 'events', orderBy: 'time' },
    value: (a) => ratio(a.responses_abandoned, attempts(a)),
    drillCount: (a) => a.responses_abandoned,
  },
  ...(['p50', 'p95', 'p99'] as const).flatMap((p, i): MetricDef[] => [
    {
      id: `ttft_${p}`,
      label: `Time to first token ${p}`,
      unit: 'ms',
      kind: 'percentile',
      definition: `${p} of time to first token over completed responses: from the server accepting the request to the first output token. Merged from t-digest sketches, never an average of per-bucket percentiles.`,
      streams: ['server'],
      sensitivity: 'standard',
      approximate: true,
      higherIsBetter: false,
      dimensions: BOTH,
      drill: { eventTypes: ['response_completed'], counts: 'events', orderBy: 'ttft' },
      value: (a) => (a.responses_ok > 0 ? a.ttft[i] : null),
      drillCount: (a) => a.responses_ok,
    },
    {
      id: `latency_${p}`,
      label: `Total response time ${p}`,
      unit: 'ms',
      kind: 'percentile',
      definition: `${p} of total response time over completed responses: from the server accepting the request to the final token.`,
      streams: ['server'],
      sensitivity: 'standard',
      approximate: true,
      higherIsBetter: false,
      dimensions: BOTH,
      drill: { eventTypes: ['response_completed'], counts: 'events', orderBy: 'latency' },
      value: (a) => (a.responses_ok > 0 ? a.latency[i] : null),
      drillCount: (a) => a.responses_ok,
    },
  ]),
  {
    id: 'total_tokens',
    label: 'Tokens',
    unit: 'tokens',
    kind: 'sum',
    definition: 'Input plus output tokens across all response attempts, including the partial output of abandoned generations.',
    streams: ['server'],
    sensitivity: 'standard',
    approximate: false,
    higherIsBetter: null,
    dimensions: BOTH,
    drill: { eventTypes: RESPONSES, counts: 'events', orderBy: 'time' },
    value: (a) => a.input_tokens + a.output_tokens,
    drillCount: attempts,
  },
  {
    id: 'tokens_per_response',
    label: 'Output tokens per response',
    unit: 'tokens',
    kind: 'ratio',
    definition: 'Average output tokens per completed response. A newer metric: see its coverage note.',
    streams: ['server'],
    sensitivity: 'standard',
    approximate: false,
    higherIsBetter: null,
    dimensions: BOTH,
    drill: { eventTypes: ['response_completed'], counts: 'events', orderBy: 'time' },
    value: (a) => ratio(a.output_tokens, a.responses_ok),
    drillCount: (a) => a.responses_ok,
  },
  {
    id: 'cost_usd',
    label: 'Cost',
    unit: 'usd',
    kind: 'sum',
    definition: 'Model cost in USD at the list price in effect when each response happened. Billing data: only org admins receive it.',
    streams: ['server'],
    sensitivity: 'billing',
    approximate: false,
    higherIsBetter: null,
    dimensions: BOTH,
    drill: { eventTypes: RESPONSES, counts: 'events', orderBy: 'time' },
    value: (a) => a.cost_micros / 1_000_000,
    drillCount: attempts,
  },
  {
    id: 'cost_per_conversation',
    label: 'Cost per conversation',
    unit: 'usd',
    kind: 'ratio',
    definition: 'Cost divided by conversations started in the same period. Billing data.',
    streams: ['server', 'client'],
    sensitivity: 'billing',
    approximate: false,
    higherIsBetter: false,
    dimensions: ['model'],
    dimensionNote: CONVERSATION_NOTE,
    drill: { eventTypes: ['conversation_started'], counts: 'events', orderBy: 'time' },
    value: (a) => ratio(a.cost_micros / 1_000_000, a.conversations),
    drillCount: (a) => a.conversations,
  },
]

export const METRIC_BY_ID = new Map(METRICS.map((m) => [m.id, m]))

/** Metrics shown as KPI tiles on the overview, in order. */
export const OVERVIEW_METRICS = [
  'active_users',
  'conversations',
  'success_rate',
  'error_rate',
  'abandon_rate',
  'ttft_p95',
  'total_tokens',
  'cost_usd',
  'cost_per_conversation',
]

