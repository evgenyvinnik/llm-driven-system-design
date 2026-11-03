import { createFileRoute } from '@tanstack/react-router'
import { InvitationsTab, TabGate } from '@/components/settings'

export const Route = createFileRoute('/orgs/$orgId/settings/invitations')({
  component: () => (
    <TabGate tab="invitations">
      <InvitationsTab />
    </TabGate>
  ),
})
