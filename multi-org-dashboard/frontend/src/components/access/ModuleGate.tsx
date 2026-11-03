import type { ReactNode } from 'react'
import { useOrg } from '@/hooks/useOrg'
import { decide, moduleByKey, type ModuleKey } from '@/lib/modules'
import { useAccess } from '@/stores/access-store'
import { AccessChanged } from './AccessChanged'
import { Forbidden } from './Forbidden'

/**
 * Route guard for a module. It reads the same manifest as the sidebar, so a
 * deep link to a hidden module and a click on a visible one can't disagree.
 * When the manifest changes underneath an open page, the page is replaced
 * by an explanation instead of erroring or going blank.
 */
export function ModuleGate({ module, children }: { module: ModuleKey; children: ReactNode }) {
  const { orgId, manifest } = useOrg()
  const def = moduleByKey(module)
  const decision = decide(manifest, def.requires)
  const lost = useAccess((s) => s.lost[orgId]?.includes(module) ?? false)
  if (decision.allowed) return <>{children}</>
  if (lost) return <AccessChanged label={def.label} decision={decision} />
  return <Forbidden label={def.label} decision={decision} />
}
