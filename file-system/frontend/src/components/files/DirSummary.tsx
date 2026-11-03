import { formatBytes } from '@/lib/format'
import type { DirListing } from '@/types'

export function DirSummary({ listing }: { listing: DirListing }) {
  const dirs = listing.entries.filter((e) => e.kind === 'dir').length
  return (
    <section className="card p-4">
      <h2 className="panel-title">This directory</h2>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900">{formatBytes(listing.bytes)}</p>
      <p className="mt-1 text-sm text-slate-500">
        {listing.fileCount} {listing.fileCount === 1 ? 'file' : 'files'} below, in {listing.entries.length} entries ({dirs}{' '}
        {dirs === 1 ? 'directory' : 'directories'})
      </p>
    </section>
  )
}
