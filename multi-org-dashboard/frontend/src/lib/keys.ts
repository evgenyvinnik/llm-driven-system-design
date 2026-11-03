/**
 * Every query key starts with ['org', orgId]. Data from two orgs can't share
 * a cache entry, and leaving or losing an org is one removeQueries call.
 */
import type { ConversationFilters } from '@/types'

export const keys = {
  org: (orgId: string) => ['org', orgId] as const,
  manifest: (orgId: string) => ['org', orgId, 'manifest'] as const,
  overview: (orgId: string) => ['org', orgId, 'overview'] as const,
  agents: (orgId: string) => ['org', orgId, 'agents'] as const,
  knowledge: (orgId: string) => ['org', orgId, 'knowledge'] as const,
  conversations: (orgId: string, filters: ConversationFilters) => ['org', orgId, 'conversations', filters] as const,
  conversation: (orgId: string, id: string) => ['org', orgId, 'conversation', id] as const,
  analytics: (orgId: string, days: number) => ['org', orgId, 'analytics', days] as const,
  prompts: (orgId: string) => ['org', orgId, 'prompts'] as const,
  prompt: (orgId: string, id: string) => ['org', orgId, 'prompt', id] as const,
  members: (orgId: string) => ['org', orgId, 'members'] as const,
  invitations: (orgId: string) => ['org', orgId, 'invitations'] as const,
  links: (orgId: string) => ['org', orgId, 'links'] as const,
  audit: (orgId: string, action: string) => ['org', orgId, 'audit', action] as const,
  features: (orgId: string) => ['org', orgId, 'features'] as const,
  billing: (orgId: string) => ['org', orgId, 'billing'] as const,
  exports: (orgId: string) => ['org', orgId, 'exports'] as const,
}
