import { Link } from '@tanstack/react-router'
import { formatBytes } from '@/lib/format'
import { parentPath } from '@/lib/paths'
import type { LargestFile } from '@/types'

interface LargestFilesProps {
  path: string
  files: LargestFile[]
}

export function LargestFiles({ path, files }: LargestFilesProps) {
  const prefix = path === '/' ? '/' : `${path}/`
  return (
    <section className="card p-4">
      <h2 className="panel-title">Largest files</h2>
      <p className="mt-1 text-xs text-slate-500">
        Everything under <span className="font-mono">{prefix}</span>, biggest first, ties by path.
      </p>
      {files.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No files.</p>
      ) : (
        <ol className="mt-3 space-y-1.5">
          {files.map((file, i) => (
            <li key={file.path} className="flex items-baseline gap-2 text-sm">
              <span className="w-4 text-right text-xs tabular-nums text-slate-400">{i + 1}</span>
              <Link
                to="/"
                search={{ path: parentPath(file.path) }}
                className="min-w-0 flex-1 truncate font-mono text-slate-700 hover:text-accent-700"
                title={file.path}
              >
                {file.path.slice(prefix.length)}
              </Link>
              <span className="tabular-nums text-slate-500">{formatBytes(file.size)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
