import { createFileRoute, Navigate } from '@tanstack/react-router'

export const Route = createFileRoute('/orgs/$orgId/settings/')({ component: SettingsIndex })

function SettingsIndex() {
  const { orgId } = Route.useParams()
  return <Navigate to="/orgs/$orgId/settings/members" params={{ orgId }} replace />
}
