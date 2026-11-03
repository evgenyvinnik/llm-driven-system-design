import { createFileRoute } from '@tanstack/react-router'
import { MembersTab, TabGate } from '@/components/settings'

export const Route = createFileRoute('/orgs/$orgId/settings/members')({
  component: () => (
    <TabGate tab="members">
      <MembersTab />
    </TabGate>
  ),
})
