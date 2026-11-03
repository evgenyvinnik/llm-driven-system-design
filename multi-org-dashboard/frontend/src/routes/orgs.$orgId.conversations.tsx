import { useCallback } from 'react'
import { createFileRoute, Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { ModuleGate } from '@/components/access'
import { ConversationTable, ExportButton, Filters, parseFilters } from '@/components/conversations'
import { PageHeader } from '@/components/shared'
import { useOrg } from '@/hooks/useOrg'
import type { ConversationFilters } from '@/types'

export const Route = createFileRoute('/orgs/$orgId/conversations')({
  validateSearch: (search: Record<string, unknown>): ConversationFilters => parseFilters(search),
  component: () => (
    <ModuleGate module="conversations">
      <ConversationsPage />
    </ModuleGate>
  ),
})

/** The list and, through the child route, the detail pane over it: /conversations/<id>?filters. */
function ConversationsPage() {
  const { orgId } = useOrg()
  const filters = Route.useSearch()
  const navigate = useNavigate()
  const selectedId = useParams({ strict: false, select: (p) => (p as { conversationId?: string }).conversationId })

  const setFilters = useCallback(
    (next: ConversationFilters) => void navigate({ to: '.', search: parseFilters(next as Record<string, unknown>), replace: true }),
    [navigate],
  )
  const open = (id: string) =>
    void navigate({ to: '/orgs/$orgId/conversations/$conversationId', params: { orgId, conversationId: id }, search: filters })

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Conversations" description="Every conversation your agents handled, newest first." actions={<ExportButton filters={filters} />} />
      <Filters filters={filters} onChange={setFilters} />
      <div className="flex min-h-0 flex-1 gap-4">
        <ConversationTable filters={filters} selectedId={selectedId} onOpen={open} />
        <Outlet />
      </div>
    </div>
  )
}
