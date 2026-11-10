import type { Progress } from '@/types'

const SEGMENTS: { key: keyof Progress; tone: string }[] = [
  { key: 'succeeded', tone: 'bg-emerald-500' },
  { key: 'errored', tone: 'bg-rose-500' },
  { key: 'cancelled', tone: 'bg-amber-400' },
  { key: 'running', tone: 'bg-sky-500' },
]

export function ProgressBar({ progress, total }: { progress: Progress; total: number }) {
  const done = progress.succeeded + progress.errored + progress.cancelled
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-2 w-28 overflow-hidden rounded-full bg-slate-200" aria-label={`${done} of ${total} tasks finished`}>
        {SEGMENTS.map((s) => (progress[s.key] > 0 ? <div key={s.key} className={s.tone} style={{ width: `${(progress[s.key] / Math.max(1, total)) * 100}%` }} /> : null))}
      </div>
      <span className="num text-xs text-slate-500">
        {done}/{total}
      </span>
    </div>
  )
}
