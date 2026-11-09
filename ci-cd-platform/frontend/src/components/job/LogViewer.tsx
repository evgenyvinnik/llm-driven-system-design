import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, useState } from 'react'
import { PlugOffIcon } from '@/components/icons'
import { useLogStream, type StreamStatus } from '@/lib/use-log-stream'

const STATUS: Record<StreamStatus, { label: string; className: string }> = {
  connecting: { label: 'connecting', className: 'bg-slate-200 text-slate-700' },
  live: { label: 'live', className: 'bg-emerald-100 text-emerald-800' },
  reconnecting: { label: 'reconnecting', className: 'bg-amber-200 text-amber-900' },
  ended: { label: 'complete', className: 'bg-slate-200 text-slate-700' },
  denied: { label: 'no access', className: 'bg-rose-100 text-rose-800' },
}

const ROW_HEIGHT = 20

export function LogViewer({ jobId, attempt, active }: { jobId: string; attempt: number; active: boolean }) {
  const stream = useLogStream(jobId, attempt)
  const parent = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  const virtualizer = useVirtualizer({ count: stream.lines.length, getScrollElement: () => parent.current, estimateSize: () => ROW_HEIGHT, overscan: 20 })

  useEffect(() => {
    if (follow && stream.lines.length > 0) virtualizer.scrollToIndex(stream.lines.length - 1, { align: 'end' })
  }, [follow, stream.lines.length, virtualizer])

  const status = STATUS[stream.status]
  return (
    <section className="card overflow-hidden" aria-label="Logs">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-2 text-xs text-slate-600">
        <h2 className="panel-title">Logs, attempt {attempt}</h2>
        <span className={`chip ${status.className}`} data-log-status={stream.status}>
          {status.label}
        </span>
        <span className="num">{stream.lines.length} lines</span>
        {stream.servedBy && <span>served by {stream.servedBy}</span>}
        {stream.source && <span>from {stream.source === 'archive' ? 'the MinIO archive' : stream.source === 'database' ? 'PostgreSQL' : 'nowhere: no output'}</span>}
        {stream.reconnects > 0 && <span className="num">{stream.reconnects} reconnect{stream.reconnects === 1 ? '' : 's'}</span>}
        <div className="flex-1" />
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        <button type="button" className="btn-secondary !py-1 !text-xs" disabled={!active || stream.status === 'ended'} onClick={stream.drop} title="Abort this connection. The client reconnects with Last-Event-ID and receives only what it missed.">
          <PlugOffIcon className="h-3.5 w-3.5" /> Drop connection
        </button>
      </header>
      {stream.lastResume && (
        <div className="border-b border-emerald-100 bg-emerald-50 px-4 py-1.5 text-xs text-emerald-900" role="status" aria-label="Resume note">
          Reconnected with Last-Event-ID {stream.lastResume.after}: received {stream.lastResume.received} line{stream.lastResume.received === 1 ? '' : 's'} starting at {stream.lastResume.after + 1}, no gap, no duplicates.
        </div>
      )}
      <div ref={parent} className="h-[440px] overflow-auto bg-slate-950 font-mono text-[12px] text-slate-200" aria-label="Log output" data-testid="log-output">
        {stream.lines.length === 0 && <div className="p-4 text-slate-500">{stream.status === 'ended' ? 'This attempt produced no output.' : stream.status === 'denied' ? 'You do not have access to this log.' : 'Waiting for output…'}</div>}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: 'max-content', width: '100%' }}>
          {virtualizer.getVirtualItems().map((row) => {
            const line = stream.lines[row.index]
            const platform = line.text.startsWith('[platform]')
            const runner = line.text.startsWith('[runner]')
            return (
              <div key={line.n} className={`absolute left-0 flex w-full whitespace-pre hover:bg-slate-800/60 ${platform ? 'bg-amber-500/15 text-amber-200' : runner ? 'text-accent-200' : ''}`} style={{ top: row.start, height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px` }}>
                <span className="w-14 shrink-0 select-none pr-3 text-right text-slate-600">{line.n}</span>
                <span className="w-8 shrink-0 select-none text-slate-600" title={`Step ${line.step + 1}`}>
                  s{line.step + 1}
                </span>
                <span className="pr-4">{line.text}</span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
