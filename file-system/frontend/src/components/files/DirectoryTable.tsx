import { Link } from '@tanstack/react-router'
import { FolderIcon } from '@/components/icons'
import { formatBytes, percent } from '@/lib/format'
import { joinPath } from '@/lib/paths'
import type { DirListing } from '@/types'
import { FileRow } from './FileRow'

interface DirectoryTableProps {
  listing: DirListing
  onChanged: () => void
}

export function DirectoryTable({ listing, onChanged }: DirectoryTableProps) {
  if (listing.entries.length === 0) {
    return (
      <div className="card px-6 py-12 text-center text-sm text-slate-500">
        The namespace is empty. Directories appear when a file is added below them.
      </div>
    )
  }

  return (
    <div className="card overflow-hidden">
      <table className="w-full">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Name</th>
            <th className="th w-64">Size</th>
            <th className="th w-20">Files</th>
            <th className="th w-28">Owner</th>
            <th className="th w-24" />
          </tr>
        </thead>
        <tbody>
          {listing.entries.map((entry) => {
            const path = joinPath(listing.path, entry.name)
            if (entry.kind === 'file') return <FileRow key={entry.name} entry={entry} path={path} onChanged={onChanged} />
            const share = percent(entry.size, listing.bytes)
            return (
              <tr key={entry.name} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="td">
                  <Link to="/" search={{ path }} className="flex items-center gap-2 font-mono font-medium text-slate-900 hover:text-accent-700">
                    <FolderIcon className="h-4 w-4 text-accent-600" />
                    {entry.name}/
                  </Link>
                </td>
                <td className="td">
                  <div className="flex items-center gap-2">
                    <span className="w-16 tabular-nums text-slate-700">{formatBytes(entry.size)}</span>
                    <span className="h-1.5 flex-1 rounded-full bg-slate-100" title={`${share}% of this directory`}>
                      <span className="block h-1.5 rounded-full bg-accent-500" style={{ width: `${share}%` }} />
                    </span>
                  </div>
                </td>
                <td className="td tabular-nums text-slate-600">{entry.fileCount}</td>
                <td className="td text-slate-400">—</td>
                <td className="td" />
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
