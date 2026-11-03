import { useRef, type ReactNode } from 'react'
import { AccessChanged, Forbidden } from '@/components/access'
import { useOrg } from '@/hooks/useOrg'
import { decide, SETTINGS_TABS, type SettingsTab } from '@/lib/modules'

/** Guard for one settings tab: same manifest, same decision function as the modules. */
export function TabGate({ tab, children }: { tab: SettingsTab; children: ReactNode }) {
  const { manifest } = useOrg()
  const def = SETTINGS_TABS.find((t) => t.key === tab)!
  const decision = decide(manifest, def.requires)
  const wasAllowed = useRef(decision.allowed)
  if (decision.allowed) {
    wasAllowed.current = true
    return <>{children}</>
  }
  return wasAllowed.current ? <AccessChanged label={def.label} decision={decision} /> : <Forbidden label={def.label} decision={decision} />
}
