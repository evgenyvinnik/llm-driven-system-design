import { createFileRoute } from '@tanstack/react-router'
import { CampaignHeader } from '@/components/campaigns/CampaignHeader'
import { CounterRow } from '@/components/campaigns/CounterRow'
import { EventFeed } from '@/components/campaigns/EventFeed'
import { TargetTable } from '@/components/campaigns/TargetTable'
import { WaveProgress } from '@/components/campaigns/WaveProgress'
import { ErrorNote, Loading } from '@/components/shared'
import { useCampaignLive } from '@/hooks/useCampaignLive'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/campaigns/$campaignId')({ component: CampaignPage })

function CampaignPage() {
  const { campaignId } = Route.useParams()
  const user = useAuthStore((s) => s.user)!
  const { snapshot, events, mode, error, setSnapshot } = useCampaignLive(campaignId)

  if (error && !snapshot) return <ErrorNote error={error} />
  if (!snapshot) return <Loading />
  return (
    <div className="space-y-4">
      <CampaignHeader campaign={snapshot.campaign} mode={mode} canControl={user.role === 'security'} onChanged={() => void api.campaign(campaignId).then(setSnapshot)} />
      <CounterRow counts={snapshot.counts} />
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          <WaveProgress waves={snapshot.waves} />
          <TargetTable targets={snapshot.recent} />
        </div>
        <EventFeed events={events} />
      </div>
    </div>
  )
}
