import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { FindingsFilters, type FindingFilters } from '@/components/findings/FindingsFilters'
import { FindingsTable } from '@/components/findings/FindingsTable'
import { ErrorNote, Loading } from '@/components/shared'
import { num } from '@/lib/format'
import { api } from '@/services/api'
import type { Facets, Finding } from '@/types'

const KEYS = ['control', 'subscription', 'owner', 'severity', 'evidence', 'environment', 'status', 'q'] as const

export const Route = createFileRoute('/findings')({
  validateSearch: (search: Record<string, unknown>): FindingFilters => {
    const out: FindingFilters = {}
    for (const k of KEYS) if (typeof search[k] === 'string' && search[k]) out[k] = search[k] as string
    const page = Number(search.page)
    if (Number.isInteger(page) && page > 1) out.page = page
    return out
  },
  component: FindingsPage,
})

function FindingsPage() {
  const filters = Route.useSearch()
  const navigate = useNavigate({ from: '/findings' })
  const [facets, setFacets] = useState<Facets | null>(null)
  const [result, setResult] = useState<{ findings: Finding[]; total: number; pageSize: number } | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    api.facets().then(setFacets, setError)
  }, [])
  useEffect(() => {
    let live = true
    api.findings({ ...filters, page: filters.page ?? 1 }).then((r) => live && setResult(r), setError)
    return () => {
      live = false
    }
  }, [filters])

  const page = filters.page ?? 1
  const pages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1
  const go = (next: FindingFilters) => void navigate({ search: next })

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="page-title">Findings</h1>
          <p className="text-sm text-slate-500">Sorted by risk: severity × internet exposure × data classification × whether the insecure path is in use</p>
        </div>
        {result && <span className="text-sm text-slate-500">{num(result.total)} findings</span>}
      </div>
      <FindingsFilters facets={facets} value={filters} onChange={go} />
      <ErrorNote error={error} />
      {result ? <FindingsTable findings={result.findings} /> : <Loading />}
      {result && pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => go({ ...filters, page: page - 1 })}>Previous</button>
          <span className="text-slate-500">Page {page} of {pages}</span>
          <button type="button" className="btn-secondary" disabled={page >= pages} onClick={() => go({ ...filters, page: page + 1 })}>Next</button>
        </div>
      )}
    </div>
  )
}
