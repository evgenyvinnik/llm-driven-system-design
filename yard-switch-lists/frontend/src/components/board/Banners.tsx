import { Link } from '@tanstack/react-router'
import { AlertIcon, RefreshIcon, SpinnerIcon } from '@/components/icons'
import { SeverityChip } from '@/components/shared/Chips'
import type { Board, Conflict } from '@/types'

function Banner({ tone, children, role = 'status' }: { tone: 'bad' | 'warn' | 'info'; children: React.ReactNode; role?: string }) {
  const cls = { bad: 'border-rose-300 bg-rose-100 text-rose-900', warn: 'border-amber-300 bg-amber-50 text-amber-900', info: 'border-sky-200 bg-sky-50 text-sky-900' }[tone]
  return (
    <div className={`flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm ${cls}`} role={role}>
      {children}
    </div>
  )
}

interface Props {
  board: Board
  onRelease: (conflict: Conflict) => void
  onAck: (id: string) => void
  notice: { tone: 'bad' | 'warn' | 'info'; text: string; action?: { label: string; run: () => void } } | null
  onDismissNotice: () => void
}

export function Banners({ board, onRelease, onAck, notice, onDismissNotice }: Props) {
  const conflicts = board.working?.conflicts ?? []
  const violations = board.validation.violations.filter((v) => v.code !== 'LOCK_VIOLATED')
  const misses = (board.working?.consequences ?? []).filter((c) => c.kind === 'departure_missed' && c.reason === 'was_planned')
  return (
    <div className="space-y-2" data-testid="banners">
      {notice && (
        <Banner tone={notice.tone} role="alert">
          <AlertIcon />
          <span className="flex-1">{notice.text}</span>
          {notice.action && (
            <button type="button" className="btn-secondary" onClick={notice.action.run}>
              {notice.action.label}
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={onDismissNotice}>Dismiss</button>
        </Banner>
      )}
      {conflicts.map((c) => (
        <Banner key={`${c.lockId}-${c.code}`} tone="bad" role="alert">
          <AlertIcon />
          <span className="font-semibold">Lock conflict:</span>
          <span className="flex-1" data-testid="conflict-message">{c.message}</span>
          <button type="button" className="btn-secondary" onClick={() => onRelease(c)}>Release lock</button>
        </Banner>
      ))}
      {misses.map((c, i) => (
        <Banner key={i} tone="bad" role="alert">
          <AlertIcon />
          <span className="flex-1" data-testid="missed-departure">{c.message}</span>
        </Banner>
      ))}
      {violations.length > 0 && (
        <Banner tone="warn">
          <AlertIcon />
          <span className="font-semibold">Validator:</span>
          <SeverityChip severity={violations[0].severity} />
          <span className="flex-1">{violations[0].message}</span>
          {violations.length > 1 && <span className="text-xs">+{violations.length - 1} more</span>}
        </Banner>
      )}
      {board.validation.ok && conflicts.length === 0 && <Banner tone="info"><span data-testid="validator-ok">Validator: this plan passes every rule against the yard right now.</span></Banner>}
      {(board.solving.length > 0 || board.pendingTriggers > 0) && (
        <Banner tone="info">
          <SpinnerIcon />
          {board.solving.length > 0 ? `Planner working: ${board.solving[0].reason} (attempt ${board.solving[0].attempts || 1})` : `${board.pendingTriggers} replan trigger(s) waiting to coalesce`}
        </Banner>
      )}
      {board.stale && !board.solving.length && board.pendingTriggers === 0 && (
        <Banner tone="warn">
          <RefreshIcon /> This plan was built on yard state {board.working?.basedOnStateVersion}; the yard is at {board.stateVersion}.
        </Banner>
      )}
      {board.alerts.filter((a) => a.kind !== 'plan_needs_review').slice(0, 6).map((a) => (
        <Banner key={a.id} tone={a.severity === 'critical' ? 'bad' : 'warn'}>
          <AlertIcon />
          <span className="flex-1">{a.message}</span>
          <button type="button" className="btn-ghost" onClick={() => onAck(a.id)}>Acknowledge</button>
        </Banner>
      ))}
      {board.working && !board.workingIsHead && (
        <Banner tone="warn">
          Crews are still working from v{board.head?.versionNo ?? '–'}. <Link className="underline" to="/plans/$id" params={{ id: board.working.id }}>See what changes in v{board.working.versionNo}</Link>
        </Banner>
      )}
    </div>
  )
}
