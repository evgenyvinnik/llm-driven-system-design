import { useCallback } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { DetailPane } from '@/components/conversations'

export const Route = createFileRoute('/orgs/$orgId/conversations/$conversationId')({ component: ConversationPane })

function ConversationPane() {
  const { orgId, conversationId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate()
  // Closing keeps the filters: back to exactly the list the pane was opened from.
  const close = useCallback(() => void navigate({ to: '/orgs/$orgId/conversations', params: { orgId }, search }), [navigate, orgId, search])
  return <DetailPane conversationId={conversationId} onClose={close} />
}
