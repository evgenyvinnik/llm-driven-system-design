/**
 * HTTP implementation of the control plane, pointed at the cloud simulator.
 * Every request carries a client request ID for correlation and a principal
 * header (the simulator keys Resource Graph quotas by principal).
 * @module arm/http-client
 */
import { randomUUID } from 'node:crypto'
import type { PolicyEffect, ResourceKind } from '../domain/types.js'
import { kindPath } from '../domain/types.js'
import { armRequests, armThrottled } from '../shared/metrics.js'
import { parseRetryAfter } from '../shared/token-bucket.js'
import {
  parseLogTable,
  parseTransactions,
  type ArmResult,
  type ChangesPage,
  type ControlPlane,
  type GraphPage,
  type LogRecord,
  type ResourceBody,
  type SubscriptionInfo,
  type TransactionPoint,
} from './control-plane.js'

export class HttpControlPlane implements ControlPlane {
  constructor(
    private baseUrl: string,
    private principal: string,
    private timeoutMs = 10_000,
  ) {}

  private async request<T>(op: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ArmResult<T>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'x-ms-client-request-id': randomUUID(),
        'x-sim-principal': this.principal,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    armRequests.inc({ op, status: String(response.status) })
    const data = (await response.json().catch(() => ({}))) as T
    const result: ArmResult<T> = { status: response.status, etag: response.headers.get('etag') ?? undefined, body: data }
    if (response.status === 429 || response.status === 503) {
      if (response.status === 429) armThrottled.inc({ op })
      result.retryAfterMs = parseRetryAfter(response.headers, Date.now())
    }
    return result
  }

  async listSubscriptions(): Promise<SubscriptionInfo[]> {
    const r = await this.request<{ value: SubscriptionInfo[] }>('subscriptions', 'GET', '/subscriptions')
    if (r.status !== 200) throw new Error(`list subscriptions failed: ${r.status}`)
    return r.body.value
  }

  queryGraph(subscriptions: string[], skipToken?: string, top = 500): Promise<ArmResult<GraphPage>> {
    return this.request<GraphPage>('graph', 'POST', '/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01', {
      subscriptions,
      query: "Resources | where type =~ 'microsoft.storage/storageaccounts' | project id, name, location, resourceGroup, subscriptionId, tags, properties, systemData",
      options: { $top: top, $skipToken: skipToken },
    })
  }

  get(accountId: string, kind: ResourceKind): Promise<ArmResult> {
    return this.request<ResourceBody>(`get:${kind}`, 'GET', `${kindPath(accountId, kind)}?api-version=2023-05-01`)
  }

  write(accountId: string, kind: ResourceKind, body: Record<string, unknown>, ifMatch?: string, operationId?: string): Promise<ArmResult> {
    const headers: Record<string, string> = {}
    if (ifMatch) headers['if-match'] = ifMatch
    if (operationId) headers['x-ms-client-request-id'] = operationId
    return this.request<ResourceBody>(`write:${kind}`, kind === 'account' ? 'PATCH' : 'PUT', `${kindPath(accountId, kind)}?api-version=2023-05-01`, body, headers)
  }

  changes(since: number, limit: number): Promise<ArmResult<ChangesPage>> {
    return this.request<ChangesPage>('changes', 'GET', `/changes?since=${since}&limit=${limit}`)
  }

  async queryLogs(resourceIds: string[], days: number): Promise<ArmResult<LogRecord[]>> {
    const r = await this.request<unknown>('logs', 'POST', '/v1/workspaces/law-storage-central/query', {
      query: `StorageBlobLogs | where TimeGenerated > ago(${days}d) | summarize Requests=count(), Failed=countif(StatusCode == 403), LastSeen=max(TimeGenerated) by _ResourceId, AuthenticationType, CallerIpAddress, UserAgentHeader, TlsVersion, Protocol`,
      resourceIds,
      days,
    })
    return { status: r.status, retryAfterMs: r.retryAfterMs, body: r.status === 200 ? parseLogTable(r.body) : [] }
  }

  async transactions(accountId: string, from: number, to: number): Promise<TransactionPoint[]> {
    const timespan = `${new Date(from).toISOString()}/${new Date(to).toISOString()}`
    const r = await this.request<unknown>('metrics', 'GET', `${accountId}/providers/Microsoft.Insights/metrics?metricnames=Transactions&interval=PT5S&timespan=${encodeURIComponent(timespan)}&$filter=ResponseType%20eq%20'*'`)
    if (r.status !== 200) throw new Error(`metrics query failed: ${r.status}`)
    return parseTransactions(r.body)
  }

  setPolicy(controlId: string, effect: PolicyEffect | null): Promise<ArmResult<unknown>> {
    return this.request<unknown>('policy', 'PUT', `/providers/Microsoft.Authorization/policyAssignments/storage-${controlId.toLowerCase()}`, {
      properties: { metadata: { controlId }, parameters: { effect: { value: effect } } },
    })
  }
}
