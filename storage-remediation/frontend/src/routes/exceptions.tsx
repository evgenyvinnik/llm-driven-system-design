import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { ExceptionsTable } from '@/components/exceptions/ExceptionsTable'
import { ErrorNote, Loading } from '@/components/shared'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import type { ExceptionRecord } from '@/types'

export const Route = createFileRoute('/exceptions')({ component: ExceptionsPage })

const FILTERS = ['all', 'pending', 'approved', 'expired', 'rejected', 'revoked']

function ExceptionsPage() {
  const user = useAuthStore((s) => s.user)!
  const [status, setStatus] = useState('all')
  const [rows, setRows] = useState<ExceptionRecord[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const load = useCallback(() => api.exceptions(status).then((r) => setRows(r.exceptions), setError), [status])

  useEffect(() => {
    void load()
    const timer = setInterval(load, 10_000)
    return () => clearInterval(timer)
  }, [load])

  const decide = (id: string, decision: 'approve' | 'reject') => {
    const note = decision === 'reject' ? window.prompt('Reason for rejecting (shown to the owner)') ?? undefined : undefined
    api.decideException(id, decision, note).then(load, setError)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Exceptions</h1>
          <p className="text-sm text-slate-500">Accepted risk is time-boxed: an owner and a justification, an approver who is not the requester, and an expiry after which the finding reopens on its own.</p>
        </div>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button key={f} type="button" className={f === status ? 'btn-primary px-2.5 py-1 text-xs' : 'btn-secondary px-2.5 py-1 text-xs'} onClick={() => setStatus(f)}>{f}</button>
          ))}
        </div>
      </div>
      <ErrorNote error={error} />
      {rows ? <ExceptionsTable rows={rows} user={user} onDecide={decide} onRevoke={(id) => void api.revokeException(id).then(load, setError)} /> : <Loading />}
    </div>
  )
}
