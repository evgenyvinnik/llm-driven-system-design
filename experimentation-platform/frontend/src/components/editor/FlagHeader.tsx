import { Link } from '@tanstack/react-router'
import { ChartIcon, FlagIcon } from '@/components/icons'
import { KindChip, StatusChip } from '@/components/shared/StatusChip'
import type { Flag } from '@/types'

export function FlagHeader({ flag, env, tab }: { flag: Flag; env: string; tab: 'config' | 'results' }) {
  const cfg = flag.configs[env]
  const tabClass = (active: boolean) => `inline-flex items-center gap-1.5 border-b-2 px-1 pb-2 text-sm font-medium ${active ? 'border-accent-600 text-accent-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`
  return (
    <header className="space-y-3">
      <div className="text-xs text-slate-500">
        <Link to="/flags" className="hover:underline">
          Flags &amp; experiments
        </Link>{' '}
        / <span className="font-mono">{flag.key}</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="h1">{flag.name}</h1>
        <code className="code">{flag.key}</code>
        <KindChip kind={flag.kind} />
        {cfg && <StatusChip status={cfg.status} />}
        <span className="chip bg-slate-100 text-slate-600">{env}</span>
      </div>
      {flag.description && <p className="max-w-3xl text-sm text-slate-600">{flag.description}</p>}
      <nav className="flex gap-5 border-b border-slate-200" aria-label="Flag sections">
        <Link to="/flags/$key" params={{ key: flag.key }} className={tabClass(tab === 'config')}>
          <FlagIcon className="h-3.5 w-3.5" /> Configuration
        </Link>
        {flag.kind === 'experiment' && (
          <Link to="/flags/$key/results" params={{ key: flag.key }} className={tabClass(tab === 'results')}>
            <ChartIcon className="h-3.5 w-3.5" /> Results
          </Link>
        )}
      </nav>
    </header>
  )
}
