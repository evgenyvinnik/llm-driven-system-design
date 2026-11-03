import { createFileRoute } from '@tanstack/react-router'
import { FeaturesTab, TabGate } from '@/components/settings'

export const Route = createFileRoute('/orgs/$orgId/settings/features')({
  component: () => (
    <TabGate tab="features">
      <FeaturesTab />
    </TabGate>
  ),
})
