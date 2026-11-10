import { GitForkIcon, PlayIcon, ZapOffIcon } from '@/components/icons'
import type { Scenario } from '@/types'

export function ScenarioCard({ scenario, disabled, onTrigger }: { scenario: Scenario; disabled: boolean; onTrigger: (killOnStep: boolean) => void }) {
  return (
    <div className="card flex flex-col gap-2 p-3">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
        {scenario.fork && <GitForkIcon className="h-4 w-4 text-orange-700" />} {scenario.title}
      </h3>
      <p className="flex-1 text-xs text-slate-600">{scenario.description}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary !py-1 !text-xs" disabled={disabled} onClick={() => onTrigger(false)} data-scenario={scenario.name}>
          <PlayIcon className="h-3.5 w-3.5" /> Send event
        </button>
        {scenario.killableStep && (
          <button type="button" className="btn-danger !py-1 !text-xs" disabled={disabled} onClick={() => onTrigger(true)} title={`The runner kills itself with SIGKILL once step "${scenario.killableStep}" has started`}>
            <ZapOffIcon className="h-3.5 w-3.5" /> Send, kill runner on "{scenario.killableStep}"
          </button>
        )}
      </div>
    </div>
  )
}
