import { AlertIcon, CheckIcon, ShieldIcon, SpinnerIcon, ToolIcon, XIcon } from '@/components/icons'
import type { TimelineItem } from '@/types'

export function ToolRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const icon =
    item.status === 'running' || item.status === 'waiting' ? (
      <SpinnerIcon className="h-3.5 w-3.5 text-accent-600" />
    ) : item.status === 'done' ? (
      <CheckIcon className="h-3.5 w-3.5 text-emerald-600" />
    ) : (
      <XIcon className="h-3.5 w-3.5 text-red-500" />
    )
  const text = item.status === 'running' ? item.label : item.status === 'waiting' ? `${item.label} (in your browser)` : item.summary || item.label
  return (
    <div className="flex items-start gap-2 text-xs text-slate-500" data-tool={item.name}>
      <span className="mt-0.5">{icon}</span>
      <span className="min-w-0">
        <span className="font-mono text-[11px] text-slate-400">{item.name}</span> <span>{text}</span>
        {item.error && <span className="block text-red-600">{item.error}</span>}
      </span>
    </div>
  )
}

const NOTICE_STYLE: Record<string, string> = {
  untrusted: 'text-amber-700',
  retry: 'text-slate-500',
  budget: 'text-amber-700',
  loop: 'text-amber-700',
  recovered: 'text-sky-700',
}

export function NoticeRow({ item }: { item: Extract<TimelineItem, { kind: 'notice' }> }) {
  const Icon = item.noticeKind === 'untrusted' ? ShieldIcon : item.noticeKind === 'retry' ? ToolIcon : AlertIcon
  return (
    <div className={`flex items-start gap-2 text-xs ${NOTICE_STYLE[item.noticeKind] ?? 'text-slate-500'}`}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{item.message}</span>
    </div>
  )
}
