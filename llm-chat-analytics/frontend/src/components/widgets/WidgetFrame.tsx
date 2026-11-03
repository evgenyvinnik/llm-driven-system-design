/**
 * Every widget renders one of these states, independently of the others:
 *   loading     nothing to show yet: skeleton
 *   refreshing  the previous answer stays, dimmed, labelled "Updating"
 *   error       this widget failed; the rest of the dashboard is unaffected
 *   forbidden   the role can't see it (the API returned 403)
 *   n/a         the metric can't be split by an active filter (422), e.g. conversations by feature
 *   empty       the query worked and matched nothing
 *   ready       with optional "partial" and "suppressed" notes
 */
import type { ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { ApiError } from '../../lib/api'
import { AlertIcon, InfoIcon, LockIcon, RefreshIcon, SpinnerIcon } from '../icons'

interface Props<T> {
  title: string
  subtitle?: ReactNode
  query: UseQueryResult<T>
  isEmpty?: (data: T) => boolean
  emptyText?: string
  notes?: (data: T) => ReactNode
  actions?: ReactNode
  minHeight?: number
  className?: string
  children: (data: T) => ReactNode
  testId?: string
}

export function WidgetFrame<T>({ title, subtitle, query, isEmpty, emptyText, notes, actions, minHeight = 220, className = '', children, testId }: Props<T>) {
  const { data, error, isPending, isFetching, isPlaceholderData, refetch } = query
  const refreshing = !isPending && (isPlaceholderData || (isFetching && !!data))
  const forbidden = error instanceof ApiError && error.status === 403
  const notApplicable = error instanceof ApiError && error.status === 422
  const state = isPending
    ? 'loading'
    : forbidden
      ? 'forbidden'
      : notApplicable
        ? 'not-applicable'
        : error && !data
          ? 'error'
          : data && isEmpty?.(data)
            ? 'empty'
            : 'ready'

  return (
    <section className={`card flex flex-col p-4 ${className}`} aria-busy={state === 'loading' || refreshing} data-testid={testId} data-state={state}>
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="widget-title">{title}</h2>
          {subtitle && <div className="mt-0.5 text-xs text-ink-2">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {refreshing && (
            <span className="badge bg-plane text-ink-2" role="status">
              <SpinnerIcon className="h-3 w-3" /> Updating
            </span>
          )}
          {actions}
        </div>
      </header>
      <div className="relative flex-1" style={{ minHeight }}>
        {state === 'loading' && <Skeleton />}
        {state === 'forbidden' && (
          <Message icon={<LockIcon className="h-5 w-5" />} title="Not available for your role">
            {(error as ApiError).message}
          </Message>
        )}
        {state === 'not-applicable' && (
          <Message icon={<InfoIcon className="h-5 w-5" />} title="Not available with these filters">
            {(error as ApiError).message}
          </Message>
        )}
        {state === 'error' && (
          <Message icon={<AlertIcon className="h-5 w-5 text-status-critical" />} title="This widget couldn’t load">
            <span className="block">{(error as Error).message}</span>
            <button type="button" className="btn-secondary mt-3" onClick={() => refetch()}>
              <RefreshIcon className="h-3.5 w-3.5" /> Retry
            </button>
          </Message>
        )}
        {state === 'empty' && <Message title="Nothing matches these filters">{emptyText ?? 'Try a longer range or remove a filter.'}</Message>}
        {state === 'ready' && data && (
          <div className={`transition-opacity ${refreshing ? 'opacity-50' : ''}`}>
            {error && <p className="mb-2 text-xs text-status-critical">Refresh failed: showing the last good result. {(error as Error).message}</p>}
            {children(data)}
            {notes && <div className="mt-3 space-y-1 text-xs text-ink-2">{notes(data)}</div>}
          </div>
        )}
      </div>
    </section>
  )
}

function Skeleton() {
  return (
    <div className="flex h-full animate-pulse flex-col gap-3 motion-reduce:animate-none" aria-label="Loading">
      <div className="h-3 w-1/3 rounded bg-plane" />
      <div className="flex-1 rounded bg-plane" />
    </div>
  )
}

function Message({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center py-8 text-center">
      {icon && <div className="mb-2 text-ink-muted">{icon}</div>}
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="mt-1 max-w-sm text-xs text-ink-2">{children}</div>}
    </div>
  )
}
