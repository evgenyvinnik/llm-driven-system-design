import { useEffect, useRef } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ErrorNote, Loading, StatusBadge } from '@/components/shared'
import { useOrg } from '@/hooks/useOrg'
import { dateTime, number } from '@/lib/format'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'
import type { ConversationFilters, ConversationPage } from '@/types'

const FULL = 'grid grid-cols-[9rem_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_4.5rem_6rem_3.5rem]'
// With the detail pane open the list keeps only what identifies a row.
const COMPACT = 'grid grid-cols-[8rem_minmax(0,1fr)_6rem]'

/**
 * Cursor-paginated and virtualized: only the visible rows are in the DOM,
 * and the next page is requested when the user scrolls near the end.
 */
export function ConversationTable({
  filters,
  selectedId,
  onOpen,
}: {
  filters: ConversationFilters
  selectedId?: string
  onOpen: (id: string) => void
}) {
  const { orgId } = useOrg()
  const compact = Boolean(selectedId)
  const COLS = compact ? COMPACT : FULL
  const headers = compact ? ['Started', 'Subject', 'Status'] : ['Started', 'Subject', 'Customer', 'Agent', 'Channel', 'Status', 'CSAT']
  const parentRef = useRef<HTMLDivElement>(null)
  const query = useInfiniteQuery({
    queryKey: keys.conversations(orgId, filters),
    queryFn: ({ pageParam, signal }) => api.conversations(orgId, filters, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ConversationPage) => last.nextCursor,
    // Keep showing the old rows while new filters load, but never another org's rows.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === orgId ? previous : undefined),
  })
  const rows = query.data?.pages.flatMap((p) => p.items) ?? []
  const total = query.data?.pages[0]?.total
  const virtualizer = useVirtualizer({
    count: rows.length + (query.hasNextPage ? 1 : 0),
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 12,
  })
  const items = virtualizer.getVirtualItems()
  const lastIndex = items.length ? items[items.length - 1].index : 0

  useEffect(() => {
    if (query.hasNextPage && !query.isFetchingNextPage && lastIndex >= rows.length - 25) void query.fetchNextPage()
  }, [lastIndex, rows.length, query])

  if (query.isPending) return <Loading label="Loading conversations…" />
  if (query.error && rows.length === 0) return <ErrorNote error={query.error} />

  return (
    <div className="card flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="conversation-table">
      <div className={`${COLS} border-b border-slate-200 bg-slate-50`} role="row">
        {headers.map((h) => (
          <div key={h} className="th" role="columnheader">{h}</div>
        ))}
      </div>
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto" role="rowgroup" aria-busy={query.isFetching}>
        {rows.length === 0 && <p className="p-6 text-sm text-slate-500">No conversations match these filters.</p>}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((item) => {
            const c = rows[item.index]
            return (
              <div
                key={item.key}
                className="absolute left-0 right-0"
                style={{ top: 0, transform: `translateY(${item.start}px)`, height: item.size }}
              >
                {c ? (
                  <button
                    className={`${COLS} h-full w-full items-center border-b border-slate-100 text-left hover:bg-slate-50 ${c.id === selectedId ? 'bg-brand-50' : ''}`}
                    onClick={() => onOpen(c.id)}
                    role="row"
                    aria-selected={c.id === selectedId}
                    data-conversation={c.id}
                  >
                    <span className="td text-xs text-slate-500">{dateTime(c.startedAt)}</span>
                    <span className="td truncate font-medium text-slate-900">{c.subject}</span>
                    {!compact && <span className="td truncate">{c.customerName}</span>}
                    {!compact && <span className="td truncate">{c.agentName}</span>}
                    {!compact && <span className="td">{c.channel}</span>}
                    <span className="td"><StatusBadge status={c.status} /></span>
                    {!compact && <span className="td">{c.csat ?? '—'}</span>}
                  </button>
                ) : (
                  <div className="px-3 py-3 text-xs text-slate-400">Loading more…</div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <div className="border-t border-slate-200 px-3 py-1.5 text-xs text-slate-500" data-testid="conversation-count">
        Showing {number(rows.length)} of {total ? `${number(total.count)}${total.capped ? '+' : ''}` : '…'}
        {query.isFetching && !query.isFetchingNextPage && ' · updating'}
      </div>
    </div>
  )
}
