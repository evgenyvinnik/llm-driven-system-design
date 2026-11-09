import { Chip } from '@/components/shared/Chips'
import type { DiffFile } from '@/types'

function lineClass(line: string): string {
  if (line.startsWith('+')) return 'bg-emerald-50 text-emerald-900'
  if (line.startsWith('-')) return 'bg-rose-50 text-rose-900'
  if (line.startsWith('@@')) return 'bg-slate-100 text-slate-500'
  return 'text-slate-700'
}

const MAX_FILES = 12

export function DiffViewer({ files, sha }: { files: DiffFile[] | null | undefined; sha: string }) {
  if (!files) return <section aria-label="Diff" className="card p-4 text-sm text-slate-500">No diff recorded yet.</section>
  const shown = files.slice(0, MAX_FILES)
  return (
    <section aria-label="Diff" className="card overflow-hidden">
      <h2 className="panel-title border-b border-slate-100 px-4 py-3">Diff at {sha.slice(0, 7)} ({files.length} file{files.length === 1 ? '' : 's'})</h2>
      {shown.map((f) => (
        <div key={f.filename} className="border-b border-slate-100 last:border-0">
          <div className="flex flex-wrap items-center gap-1.5 bg-slate-50 px-4 py-1.5 text-xs">
            <code className="font-mono font-medium text-slate-800">{f.filename}</code>
            {f.previous_filename && <span className="text-amber-800">renamed from <code className="font-mono">{f.previous_filename}</code></span>}
            <Chip>{f.status}</Chip>
            {f.binary && <Chip tone="bad">binary</Chip>}
            {f.mode === '120000' && <Chip tone="bad">symlink</Chip>}
            {f.mode === '160000' && <Chip tone="bad">submodule</Chip>}
            <span className="num text-emerald-700">+{f.additions}</span>
            <span className="num text-rose-700">−{f.deletions}</span>
          </div>
          {f.patch && (
            <pre className="overflow-x-auto py-1 font-mono text-xs leading-5">
              {f.patch.split('\n').map((line, i) => <div key={i} className={`px-4 ${lineClass(line)}`}>{line || ' '}</div>)}
            </pre>
          )}
        </div>
      ))}
      {files.length > MAX_FILES && <p className="px-4 py-2 text-xs text-slate-500">{files.length - MAX_FILES} more files not shown.</p>}
    </section>
  )
}
