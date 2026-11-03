/**
 * Handles frames from the tab's event stream. Events are invalidation hints:
 * the handler refetches or removes cached state; it never trusts an event's
 * payload as the new permissions.
 */
import { keys } from '@/lib/keys'
import { getActiveOrgId } from '@/lib/org-scope'
import { queryClient } from '@/lib/query-client'
import { useAccess } from '@/stores/access-store'
import { useAuth } from '@/stores/auth-store'
import { useToasts } from '@/stores/toast-store'
import type { ExportJob, Role } from '@/types'
import { api } from './api'
import { refreshManifestIfBehind } from './wiring'

export type StreamEvent =
  | { type: 'hello' | 'versions'; orgs: Array<{ orgId: string; version: number }> }
  | { type: 'authz.changed'; orgId: string; version: number; reason: string }
  | { type: 'role.changed'; orgId: string; orgName: string; from: Role; to: Role }
  | { type: 'access.revoked'; orgId: string; orgName: string }
  | { type: 'membership.added'; orgId: string; orgName: string; role: Role }
  | { type: 'export.progress'; orgId: string; exportId: string; processedRows: number; totalRows: number }
  | { type: 'export.completed'; orgId: string; exportId: string; totalRows: number }
  | { type: 'export.failed'; orgId: string; exportId: string; error: string }
  | { type: 'session.revoked'; reason: string }

function patchExport(orgId: string, exportId: string, patch: Partial<ExportJob>) {
  queryClient.setQueryData<{ exports: ExportJob[] }>(keys.exports(orgId), (data) =>
    data ? { exports: data.exports.map((e) => (e.id === exportId ? { ...e, ...patch } : e)) } : data,
  )
}

function orgName(orgId: string): string {
  return useAuth.getState().orgs.find((o) => o.id === orgId)?.name ?? 'your organization'
}

export function handleStreamEvent(event: StreamEvent): void {
  const toast = useToasts.getState().push
  switch (event.type) {
    case 'hello':
    case 'versions':
      for (const { orgId, version } of event.orgs) refreshManifestIfBehind(orgId, version)
      return
    case 'authz.changed':
      if (event.reason !== 'role_changed') useAccess.getState().recordChange(event.orgId, { reason: event.reason as never })
      refreshManifestIfBehind(event.orgId, event.version)
      return
    case 'role.changed':
      useAccess.getState().recordChange(event.orgId, { reason: 'role_changed', from: event.from, to: event.to })
      void useAuth.getState().refreshOrgs()
      toast({ tone: 'warning', title: `Your role in ${event.orgName} is now ${event.to}`, body: `It was ${event.from}.` })
      return
    case 'access.revoked': {
      const name = event.orgName || orgName(event.orgId)
      useAccess.getState().markRevoked(event.orgId, name)
      // Nothing from that org may stay on screen or in memory.
      queryClient.removeQueries({ queryKey: keys.org(event.orgId) })
      void useAuth.getState().refreshOrgs().catch(() => undefined)
      if (getActiveOrgId() !== event.orgId) toast({ tone: 'warning', title: `You no longer have access to ${name}` })
      return
    }
    case 'membership.added':
      useAccess.getState().forget(event.orgId)
      void useAuth.getState().refreshOrgs()
      toast({ tone: 'success', title: `You joined ${event.orgName} as ${event.role}` })
      return
    case 'export.progress':
      patchExport(event.orgId, event.exportId, { status: 'running', processedRows: event.processedRows, totalRows: event.totalRows })
      return
    case 'export.completed':
      patchExport(event.orgId, event.exportId, { status: 'completed', processedRows: event.totalRows, totalRows: event.totalRows })
      void queryClient.invalidateQueries({ queryKey: keys.exports(event.orgId) })
      toast(
        {
          tone: 'success',
          title: 'Export ready',
          body: `${event.totalRows.toLocaleString()} conversations from ${orgName(event.orgId)}`,
          action: { label: 'Download', href: api.downloadUrl(event.orgId, event.exportId) },
        },
        15000,
      )
      return
    case 'export.failed':
      patchExport(event.orgId, event.exportId, { status: 'failed', errorCode: event.error })
      void queryClient.invalidateQueries({ queryKey: keys.exports(event.orgId) })
      toast({
        tone: 'error',
        title: 'Export failed',
        body: event.error === 'ACCESS_REVOKED' ? 'You no longer have permission to export from this organization.' : undefined,
      })
      return
    case 'session.revoked':
      useAuth.getState().expire('Your access was removed, so you were signed out.', true)
      return
  }
}

const EVENT_TYPES: StreamEvent['type'][] = [
  'hello',
  'versions',
  'authz.changed',
  'role.changed',
  'access.revoked',
  'membership.added',
  'export.progress',
  'export.completed',
  'export.failed',
  'session.revoked',
]

/** Opens the tab's single event stream. EventSource reconnects by itself; each reconnect gets a fresh hello. */
export function openEventStream(): () => void {
  const source = new EventSource('/api/v1/events')
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (e) => {
      try {
        handleStreamEvent(JSON.parse((e as MessageEvent).data))
      } catch (err) {
        console.warn('bad stream event', err)
      }
    })
  }
  source.onerror = () => {
    // EventSource can't see status codes; ask the API whether the session is still alive.
    void api.me().catch(() => undefined)
  }
  return () => source.close()
}
