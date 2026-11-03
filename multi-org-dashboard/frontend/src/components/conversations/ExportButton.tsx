import { useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { DownloadIcon, LockIcon } from '@/components/icons'
import { useOrg } from '@/hooks/useOrg'
import { idempotencyKey } from '@/lib/format'
import { keys } from '@/lib/keys'
import { decide } from '@/lib/modules'
import { api, ApiError } from '@/services/api'
import { useToasts } from '@/stores/toast-store'
import type { ConversationFilters } from '@/types'

/**
 * Starts a background export of exactly what the table shows. The
 * Idempotency-Key lives until the request succeeds, so a retry after a lost
 * response returns the same job instead of starting a second one.
 */
export function ExportButton({ filters }: { filters: ConversationFilters }) {
  const { orgId, manifest } = useOrg()
  const qc = useQueryClient()
  const toast = useToasts((s) => s.push)
  const pendingKey = useRef<string | null>(null)
  const decision = decide(manifest, { permission: 'conversations.export', entitlement: 'exports' })
  const start = useMutation({
    mutationFn: () => {
      pendingKey.current ??= idempotencyKey()
      return api.createExport(orgId, filters, pendingKey.current)
    },
    onSuccess: () => {
      pendingKey.current = null
      void qc.invalidateQueries({ queryKey: keys.exports(orgId) })
      toast({ tone: 'info', title: 'Export started', body: "Keep working; you'll get a notification when the file is ready." })
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status !== 0) pendingKey.current = null
      toast({ tone: 'error', title: 'Could not start the export', body: (err as Error).message })
    },
  })

  if (!decision.allowed && decision.reason === 'permission') return null
  if (!decision.allowed) {
    return (
      <button className="btn-secondary" disabled title={`Exports are part of the Pro plan (${manifest.org.name} is on ${manifest.org.plan})`}>
        <LockIcon /> Export CSV
      </button>
    )
  }
  return (
    <button className="btn-secondary" onClick={() => start.mutate()} disabled={start.isPending || manifest.readOnly} data-testid="export-button">
      <DownloadIcon /> {start.isPending ? 'Starting…' : 'Export CSV'}
    </button>
  )
}
