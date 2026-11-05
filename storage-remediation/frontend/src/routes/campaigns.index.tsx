import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { CampaignForm } from '@/components/campaigns/CampaignForm'
import { CampaignList } from '@/components/campaigns/CampaignList'
import { PlusIcon } from '@/components/icons'
import { ErrorNote, Loading } from '@/components/shared'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import type { Campaign, ControlPolicy } from '@/types'

export const Route = createFileRoute('/campaigns/')({ component: CampaignsPage })

function CampaignsPage() {
  const user = useAuthStore((s) => s.user)!
  const navigate = useNavigate()
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null)
  const [controls, setControls] = useState<ControlPolicy[]>([])
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    const load = () => api.campaigns().then((r) => setCampaigns(r.campaigns), setError)
    void load()
    api.controls().then((r) => setControls(r.controls), setError)
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="page-title">Remediation campaigns</h1>
          <p className="text-sm text-slate-500">One control at a time, in waves: non-production first, a canary in each ring, bake-time verification and automatic rollback.</p>
        </div>
        {user.role === 'security' && (
          <button type="button" className="btn-primary" onClick={() => setShowForm((s) => !s)}><PlusIcon /> New campaign</button>
        )}
      </div>
      {showForm && controls.length > 0 && <CampaignForm controls={controls} onCreated={(id) => void navigate({ to: '/campaigns/$campaignId', params: { campaignId: id } })} />}
      <ErrorNote error={error} />
      {campaigns ? <CampaignList campaigns={campaigns} /> : <Loading />}
    </div>
  )
}
