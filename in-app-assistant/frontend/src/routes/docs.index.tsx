import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { DocIcon } from '@/components/icons'
import { Loading } from '@/components/shared/Loading'
import { relativeTime } from '@/lib/format'
import { api } from '@/services/api'
import type { DocumentSummary } from '@/types'

export const Route = createFileRoute('/docs/')({ component: DocsList })

const ROLE_STYLE = { owner: 'bg-slate-100 text-slate-600', editor: 'bg-sky-50 text-sky-700', viewer: 'bg-amber-50 text-amber-700' }

function DocsList() {
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null)
  useEffect(() => {
    api.documents().then((r) => setDocs(r.documents)).catch(() => setDocs([]))
  }, [])
  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="mb-4 text-xl font-semibold text-slate-900">Documents</h1>
      {!docs ? <Loading /> : (
        <table className="w-full max-w-3xl text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="py-2">Title</th><th>Owner</th><th>Access</th><th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="py-2.5">
                  <Link to="/docs/$docId" params={{ docId: d.id }} className="flex items-center gap-2 font-medium text-slate-900 hover:text-accent-700">
                    <DocIcon className="h-4 w-4 text-sky-600" /> {d.title}
                  </Link>
                </td>
                <td className="text-slate-600">{d.owner}</td>
                <td><span className={`chip ${ROLE_STYLE[d.role]}`}>{d.role}</span></td>
                <td className="text-slate-400">{relativeTime(d.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
