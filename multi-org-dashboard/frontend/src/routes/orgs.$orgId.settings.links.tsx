import { createFileRoute } from '@tanstack/react-router'
import { LinksTab, TabGate } from '@/components/settings'

export const Route = createFileRoute('/orgs/$orgId/settings/links')({
  component: () => (
    <TabGate tab="links">
      <LinksTab />
    </TabGate>
  ),
})
