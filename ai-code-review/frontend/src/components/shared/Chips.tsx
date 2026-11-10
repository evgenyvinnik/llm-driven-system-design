import type { ReactNode } from 'react'
import { CheckIcon, ClockIcon, MinusIcon, ShieldIcon, XIcon } from '@/components/icons'
import { OUTCOME_LABEL } from '@/lib/format'
import type { Outcome, RepoMode, RuleStatus } from '@/types'

type Tone = 'good' | 'bad' | 'warn' | 'info' | 'mute'

const TONES: Record<Tone, string> = {
  good: 'bg-emerald-100 text-emerald-800',
  bad: 'bg-rose-100 text-rose-800',
  warn: 'bg-amber-100 text-amber-800',
  info: 'bg-sky-100 text-sky-800',
  mute: 'bg-slate-100 text-slate-600',
}

export function Chip({ tone = 'mute', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`chip ${TONES[tone]}`} title={title}>
      {children}
    </span>
  )
}

const OUTCOME_TONE: Record<Outcome, Tone> = { auto_approved: 'good', human_approved: 'good', escalated: 'bad', human_rejected: 'bad', shadow: 'info', waiting_ci: 'warn' }

export function OutcomeChip({ outcome, invalidated }: { outcome: Outcome; invalidated?: boolean }) {
  if (invalidated) return <Chip tone="mute"><span className="line-through">{OUTCOME_LABEL[outcome]}</span> invalidated</Chip>
  return <Chip tone={OUTCOME_TONE[outcome]}>{OUTCOME_LABEL[outcome]}</Chip>
}

export function ModeChip({ mode, killSwitch }: { mode: RepoMode; killSwitch?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Chip tone={mode === 'narrow_auto' ? 'good' : 'info'}>{mode === 'narrow_auto' ? 'narrow auto' : 'observe'}</Chip>
      {killSwitch && <Chip tone="bad"><ShieldIcon className="h-3 w-3" /> kill switch</Chip>}
    </span>
  )
}

export function RuleIcon({ status }: { status: RuleStatus }) {
  if (status === 'pass') return <CheckIcon className="h-4 w-4 text-emerald-600" title="Passed" />
  if (status === 'fail') return <XIcon className="h-4 w-4 text-rose-600" title="Failed" />
  return <ClockIcon className="h-4 w-4 text-amber-600" title="Unknown" />
}

export function ToneIcon({ ok }: { ok: boolean | null }) {
  if (ok === null) return <MinusIcon className="h-4 w-4 text-slate-400" />
  return ok ? <CheckIcon className="h-4 w-4 text-emerald-600" /> : <XIcon className="h-4 w-4 text-rose-600" />
}

export function Sha({ sha }: { sha: string | null | undefined }) {
  return <code className="code">{sha ? sha.slice(0, 7) : '—'}</code>
}
