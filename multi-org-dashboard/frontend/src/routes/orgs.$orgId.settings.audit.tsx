import { createFileRoute } from '@tanstack/react-router'
import { AuditTab, TabGate } from '@/components/settings'

export const Route = createFileRoute('/orgs/$orgId/settings/audit')({
  component: () => (
    <TabGate tab="audit">
      <AuditTab />
    </TabGate>
  ),
})
