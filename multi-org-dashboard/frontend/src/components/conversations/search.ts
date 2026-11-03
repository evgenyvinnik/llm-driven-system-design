import type { Channel, ConversationFilters, ConversationStatus } from '@/types'

const STATUSES: ConversationStatus[] = ['open', 'resolved', 'escalated']
const CHANNELS: Channel[] = ['chat', 'email', 'voice']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Filters live in the URL, so a link reproduces the exact view. Anything
 * malformed is dropped rather than sent, and undefined keys are omitted so
 * the same filters always produce the same query key.
 */
export function parseFilters(search: Record<string, unknown>): ConversationFilters {
  const out: ConversationFilters = {}
  if (STATUSES.includes(search.status as ConversationStatus)) out.status = search.status as ConversationStatus
  if (CHANNELS.includes(search.channel as Channel)) out.channel = search.channel as Channel
  if (typeof search.agentId === 'string' && UUID.test(search.agentId)) out.agentId = search.agentId
  if (typeof search.q === 'string' && search.q.trim()) out.q = search.q.trim().slice(0, 100)
  if (typeof search.from === 'string' && DATE.test(search.from)) out.from = search.from
  if (typeof search.to === 'string' && DATE.test(search.to)) out.to = search.to
  return out
}

export { CHANNELS, STATUSES }
