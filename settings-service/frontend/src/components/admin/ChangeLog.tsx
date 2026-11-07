import { formatValue, timeAgo } from '@/lib/display'
import type { ChangeLogEntry } from '@/types'

/** The append-only change log, written in the same transaction as each change. */
export function ChangeLog({ changes, title }: { changes: ChangeLogEntry[]; title: string }) {
  return (
    <section className="card overflow-hidden" aria-label={title}>
      <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">{title}</h2>
      {changes.length === 0 ? (
        <p className="px-4 py-3 text-sm text-faint">No changes yet.</p>
      ) : (
        <ul className="divide-y divide-line text-xs">
          {changes.map((c) => (
            <li key={c.id} className="px-4 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-ink">{c.key}</span>
                <span className="shrink-0 text-faint">{timeAgo(c.at)}</span>
              </div>
              <div className="text-muted">
                {c.scope === 'catalog' ? (
                  <span>{c.clientLabel}</span>
                ) : (
                  <span>
                    {formatValue(undefined, c.oldValue)} → {formatValue(undefined, c.newValue)}
                    {c.enforced ? ' · enforced' : ''}
                  </span>
                )}
                <span className="text-faint">
                  {' '}
                  · {c.scope} r{c.revision}
                  {c.actor ? ` · ${c.actor}` : ''}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
