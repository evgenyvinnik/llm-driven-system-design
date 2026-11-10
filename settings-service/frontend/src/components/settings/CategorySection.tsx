import { useStore } from 'zustand'
import type { ComponentType } from 'react'
import { BellIcon, EyeIcon, GlobeIcon, LayersIcon, PaletteIcon, ShieldIcon, UserIcon, type IconProps } from '@/components/icons'
import { categoryTitle } from '@/lib/display'
import type { SettingsStore } from '@/lib/settings-store'
import type { Definition } from '@/types'
import { SettingRow } from './SettingRow'

const ICONS: Record<string, ComponentType<IconProps>> = {
  notifications: BellIcon,
  appearance: PaletteIcon,
  privacy: EyeIcon,
  regional: GlobeIcon,
  profile: UserIcon,
  security: ShieldIcon,
}

interface Props {
  store: SettingsStore
  category: string
  defs: Definition[]
  orgName: string
  dense?: boolean
}

/** One card of settings rows, all bound to the same settings client. */
export function CategorySection({ store, category, defs, orgName, dense }: Props) {
  const settings = useStore(store, (s) => s.doc?.settings)
  const pending = useStore(store, (s) => s.pending)
  const flash = useStore(store, (s) => s.flash)
  const actions = store.getState()
  const Icon = ICONS[category] ?? LayersIcon
  return (
    <section className="card overflow-hidden" aria-label={categoryTitle(category)} id={`cat-${category}`}>
      <h2 className="flex items-center gap-2 border-b border-line bg-sunken/50 px-5 py-3 text-sm font-semibold text-ink">
        <Icon className="h-4 w-4 text-accent-600" />
        {categoryTitle(category)}
      </h2>
      <div className="divide-y divide-line">
        {defs.map((def) => (
          <SettingRow
            key={def.key}
            def={def}
            entry={settings?.[def.key]}
            pending={pending[def.key]}
            orgName={orgName}
            flashAt={flash[def.key]}
            dense={dense}
            onChange={(v) => actions.set(def.key, v)}
            onResolve={(c) => actions.resolveConflict(def.key, c)}
            onDismiss={() => actions.dismiss(def.key)}
          />
        ))}
      </div>
    </section>
  )
}
