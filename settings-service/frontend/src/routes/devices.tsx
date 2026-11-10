import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ChaosBar } from '@/components/devices/ChaosBar'
import { ContractProbes } from '@/components/devices/ContractProbes'
import { DevicePane } from '@/components/devices/DevicePane'
import { newClientId } from '@/lib/display'
import { createSettingsStore } from '@/lib/settings-store'
import { createApi } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/devices')({ component: DevicesPage })

/**
 * The same user on two simulated devices, each with its own settings client,
 * revision, write queue and SSE stream. The phone talks to API instance A
 * (/api); the laptop talks to instance B (/api-b). A write on one reaches the
 * other through Valkey pub/sub across instances.
 */
function DevicesPage() {
  const user = useAuthStore((s) => s.user)
  const [phone] = useState(() =>
    createSettingsStore({ api: createApi('/api'), apiBase: '/api', identity: { clientId: newClientId('phone'), clientLabel: 'Phone (iOS app)' }, broadcast: false }),
  )
  const [laptop] = useState(() =>
    createSettingsStore({ api: createApi('/api-b'), apiBase: '/api-b', identity: { clientId: newClientId('laptop'), clientLabel: 'Laptop (web)' }, broadcast: false }),
  )

  useEffect(() => {
    if (!user) return
    phone.getState().start(user.id)
    laptop.getState().start(user.id)
    return () => {
      phone.getState().stop()
      laptop.getState().stop()
    }
  }, [user, phone, laptop])

  const orgName = user?.orgName ?? 'your organization'
  return (
    <main className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Two devices, one user</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Change different settings on each device: both survive. To see a conflict, freeze the laptop, change a setting on the phone, then change the
          same setting on the laptop: its write carries an old If-Match revision and gets a 409 with the current state.
        </p>
      </div>
      <ChaosBar />
      <div className="grid gap-4 lg:grid-cols-2">
        <DevicePane kind="phone" label="Phone (iOS app)" instanceHint="REST + SSE via API instance A (/api)" store={phone} orgName={orgName} />
        <DevicePane kind="laptop" label="Laptop (web)" instanceHint="REST + SSE via API instance B (/api-b)" store={laptop} orgName={orgName} />
      </div>
      <ContractProbes store={phone} />
    </main>
  )
}
