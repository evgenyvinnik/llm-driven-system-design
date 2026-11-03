/**
 * Export column sets, derived from permissions at job creation.
 * @module exporter/columns
 */
import type { Permission } from '../shared/auth.js'

export type ExportKind = 'daily_metrics' | 'conversations'

const DAILY = [
  'local_date',
  'model',
  'feature',
  'active_users',
  'conversations',
  'messages',
  'success_rate',
  'error_rate',
  'abandon_rate',
  'ttft_p50_ms',
  'ttft_p95_ms',
  'latency_p95_ms',
  'total_tokens',
  'late_events',
  'suppressed',
]
const DAILY_BILLING = ['cost_usd', 'cost_per_conversation']

const CONVERSATIONS = [
  'conversation_id',
  'user_id',
  'started_at_local',
  'model',
  'features',
  'platform',
  'messages',
  'responses_completed',
  'responses_failed',
  'responses_abandoned',
  'total_tokens',
  'max_ttft_ms',
  'had_late_events',
]
const CONVERSATIONS_BILLING = ['cost_usd']

export function exportColumns(kind: ExportKind, permissions: Permission[]): string[] {
  const billing = permissions.includes('billing:read')
  if (kind === 'daily_metrics') return billing ? [...DAILY, ...DAILY_BILLING] : DAILY
  return billing ? [...CONVERSATIONS, ...CONVERSATIONS_BILLING] : CONVERSATIONS
}
