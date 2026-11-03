import type { ComponentType } from 'react'
import { Link } from '@tanstack/react-router'
import {
  BookIcon,
  BotIcon,
  CardIcon,
  ChartIcon,
  ChatIcon,
  CogIcon,
  DownloadIcon,
  HomeIcon,
  LockIcon,
  SparklesIcon,
  type IconProps,
} from '@/components/icons'
import { useOrg } from '@/hooks/useOrg'
import { MODULE_ROUTES, sidebarModules, type ModuleKey } from '@/lib/modules'

const ICONS: Record<ModuleKey, ComponentType<IconProps>> = {
  overview: HomeIcon,
  agents: BotIcon,
  knowledge: BookIcon,
  conversations: ChatIcon,
  analytics: ChartIcon,
  prompts: SparklesIcon,
  exports: DownloadIcon,
  billing: CardIcon,
  settings: CogIcon,
}

export function Sidebar() {
  const { orgId, manifest } = useOrg()
  return (
    <nav aria-label="Modules" className="flex w-56 shrink-0 flex-col gap-0.5 border-r border-slate-200 bg-white p-3">
      {sidebarModules(manifest).map((m) => {
        const Icon = ICONS[m.key]
        return (
          <Link
            key={m.key}
            to={MODULE_ROUTES[m.key]}
            params={{ orgId }}
            activeOptions={{ exact: m.path === '' }}
            className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900"
            activeProps={{ className: 'bg-brand-50 font-medium !text-brand-700' }}
            data-module={m.key}
          >
            <Icon className="h-4 w-4" />
            <span className="flex-1">{m.label}</span>
            {m.locked && <LockIcon className="h-3.5 w-3.5 text-slate-400" title="Not on your plan" />}
            {!m.locked && m.badge && <span className="chip bg-brand-50 text-brand-700">{m.badge}</span>}
          </Link>
        )
      })}
      <div className="mt-auto px-2.5 pt-4 text-xs text-slate-400">
        Access v{manifest.version} · {manifest.org.plan} plan
      </div>
    </nav>
  )
}
