import { useState } from 'react'
import { AlertIcon, ShieldIcon, SparkleIcon } from '@/components/icons'
import { compact } from '@/lib/format'
import { isActive, useAssistantStore } from '@/stores/assistant-store'
import type { TurnState } from '@/types'
import { ActionCard } from './ActionCard'
import { Markdown } from './Markdown'
import { StepsList } from './StepsList'
import { NoticeRow, ToolRow } from './TimelineRows'

export function TurnView({ turn }: { turn: TurnState }) {
  const decide = useAssistantStore((s) => s.decide)
  const [showSteps, setShowSteps] = useState(false)
  const active = isActive(turn.status)
  const final = !active
  const lastText = [...turn.items].reverse().find((i) => i.kind === 'text')
  return (
    <div className="space-y-2.5" data-turn={turn.id} data-status={turn.status}>
      <div className="ml-8 rounded-2xl rounded-tr-sm bg-slate-800 px-3 py-2 text-[13.5px] text-white">{turn.userText}</div>
      <div className="flex gap-2">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-600 text-white">
          <SparkleIcon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          {turn.items.map((item, i) => {
            if (item.kind === 'text') {
              return (
                <div key={`t${i}`} className={item === lastText && active && turn.status === 'running' ? 'after:ml-0.5 after:inline-block after:h-3.5 after:w-1.5 motion-safe:after:animate-blink after:bg-accent-500' : ''}>
                  <Markdown text={item.text} citations={turn.citations} final={final} />
                </div>
              )
            }
            if (item.kind === 'tool') return <ToolRow key={item.callId} item={item} />
            if (item.kind === 'notice') return <NoticeRow key={`n${i}`} item={item} />
            return <ActionCard key={item.action.actionId} action={item.action} status={item.status} onDecide={(approve) => void decide(turn.id, item.action.actionId, approve)} />
          })}
          {turn.items.length === 0 && active && <div className="text-xs text-slate-400">Thinking…</div>}
          {turn.status === 'failed' && (
            <div className="flex items-start gap-1.5 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700">
              <AlertIcon className="mt-0.5 h-3.5 w-3.5" /> {turn.errorMessage ?? 'Something went wrong.'}
            </div>
          )}
          {turn.status === 'cancelled' && <div className="text-xs text-slate-400">Stopped.</div>}
          {final && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-[11px] text-slate-400">
              {turn.tainted && (
                <span className="flex items-center gap-1 text-amber-700" title="This conversation read content from outside your control">
                  <ShieldIcon className="h-3 w-3" /> read outside content
                </span>
              )}
              {turn.usage && (
                <span>
                  {turn.usage.steps} model call{turn.usage.steps === 1 ? '' : 's'} · {compact(turn.usage.inputTokens)} in / {compact(turn.usage.outputTokens)} out
                  {turn.usage.inputTokens > 0 && ` · ${Math.round((turn.usage.cacheReadTokens / turn.usage.inputTokens) * 100)}% cached`}
                </span>
              )}
              <button type="button" className="underline-offset-2 hover:text-slate-600 hover:underline" onClick={() => setShowSteps((v) => !v)}>
                {showSteps ? 'Hide steps' : 'What I did'}
              </button>
            </div>
          )}
          {showSteps && (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
              <StepsList turnId={turn.id} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
