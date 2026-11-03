import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { XIcon } from '@/components/icons'
import { ErrorNote, Loading, StatusBadge } from '@/components/shared'
import { useOrg } from '@/hooks/useOrg'
import { dateTime, money } from '@/lib/format'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'

const AUTHOR_STYLE = {
  customer: 'bg-slate-100 text-slate-800',
  agent: 'bg-brand-50 text-slate-800',
  human: 'bg-amber-50 text-amber-900',
}

/**
 * Fetched on its own, so a deep link opens even when the row isn't in the
 * loaded pages (or isn't in the current filter at all).
 */
export function DetailPane({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const { orgId } = useOrg()
  const heading = useRef<HTMLHeadingElement>(null)
  const { data, error, isPending } = useQuery({
    queryKey: keys.conversation(orgId, conversationId),
    queryFn: ({ signal }) => api.conversation(orgId, conversationId, signal),
  })
  useEffect(() => {
    heading.current?.focus()
  }, [conversationId, data])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside className="card flex w-[26rem] shrink-0 flex-col overflow-hidden" aria-label="Conversation detail" data-testid="detail-pane">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 ref={heading} tabIndex={-1} className="truncate text-sm font-semibold outline-none">
          {data?.conversation.subject ?? 'Conversation'}
        </h2>
        <button className="text-slate-400 hover:text-slate-600" onClick={onClose} aria-label="Close detail">
          <XIcon />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {isPending && <Loading />}
        {error && <ErrorNote error={error} notFound="This conversation doesn't exist, or it's in a project you can't access." />}
        {data && (
          <>
            <dl className="mb-4 grid grid-cols-2 gap-2 text-xs">
              <div><dt className="text-slate-500">Customer</dt><dd className="font-medium">{data.conversation.customerName}</dd></div>
              <div><dt className="text-slate-500">Status</dt><dd><StatusBadge status={data.conversation.status} /></dd></div>
              <div><dt className="text-slate-500">Agent</dt><dd>{data.conversation.agentName}</dd></div>
              <div><dt className="text-slate-500">Project</dt><dd>{data.conversation.projectName}</dd></div>
              <div><dt className="text-slate-500">Started</dt><dd>{dateTime(data.conversation.startedAt)}</dd></div>
              <div><dt className="text-slate-500">CSAT</dt><dd>{data.conversation.csat ?? '—'}</dd></div>
              {data.conversation.costCents !== undefined && (
                <div><dt className="text-slate-500">Model cost</dt><dd>{money(data.conversation.costCents)}</dd></div>
              )}
            </dl>
            <ol className="space-y-2">
              {data.conversation.messages.map((m) => (
                <li key={m.id} className={`rounded-lg px-3 py-2 text-sm ${AUTHOR_STYLE[m.author]}`}>
                  <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{m.author}</p>
                  {m.body}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </aside>
  )
}
