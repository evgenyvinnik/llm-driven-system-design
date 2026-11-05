/**
 * In-process control plane over a Fleet object: same semantics as HTTP
 * (etags, 412, 429 with Retry-After, ambiguous 5xx), no network. Used by the
 * seed script to run the first scan, and by tests.
 * @module arm/in-process
 */
import { Fleet, type SimResponse } from '../cloud-sim/fleet.js'
import type { PolicyEffect, ResourceKind } from '../domain/types.js'
import { kindPath } from '../domain/types.js'
import { parseLogTable, parseTransactions, type ArmResult, type ChangesPage, type ControlPlane, type GraphPage, type LogRecord, type ResourceBody, type SubscriptionInfo, type TransactionPoint } from './control-plane.js'

function toResult<T>(r: SimResponse): ArmResult<T> {
  const result: ArmResult<T> = { status: r.status, etag: r.headers?.etag, body: r.body as T }
  const retry = r.headers?.['Retry-After']
  if (retry) result.retryAfterMs = Number(retry) * 1000
  const quota = r.headers?.['x-ms-user-quota-resets-after']
  if (quota) result.retryAfterMs = Number(quota.split(':')[2]) * 1000
  return result
}

export class InProcessControlPlane implements ControlPlane {
  constructor(
    public fleet: Fleet,
    private principal = 'in-process',
  ) {}

  async listSubscriptions(): Promise<SubscriptionInfo[]> {
    return (this.fleet.listSubscriptions().body as { value: SubscriptionInfo[] }).value
  }

  async queryGraph(subscriptions: string[], skipToken?: string, top = 500): Promise<ArmResult<GraphPage>> {
    return toResult(this.fleet.graphQuery({ subscriptions, skipToken, top }, this.principal))
  }

  async get(accountId: string, kind: ResourceKind): Promise<ArmResult> {
    return toResult<ResourceBody>(this.fleet.getResource(kindPath(accountId, kind)))
  }

  async write(accountId: string, kind: ResourceKind, body: Record<string, unknown>, ifMatch?: string, operationId?: string): Promise<ArmResult> {
    return toResult<ResourceBody>(this.fleet.writeResource(kindPath(accountId, kind), body, ifMatch, operationId))
  }

  async changes(since: number, limit: number): Promise<ArmResult<ChangesPage>> {
    return toResult(this.fleet.changesSince(since, limit))
  }

  async queryLogs(resourceIds: string[], days: number): Promise<ArmResult<LogRecord[]>> {
    const r = this.fleet.queryLogs(resourceIds, days, this.principal)
    const result = toResult<unknown>(r)
    return { status: r.status, retryAfterMs: result.retryAfterMs, body: r.status === 200 ? parseLogTable(r.body) : [] }
  }

  async transactions(accountId: string, from: number, to: number): Promise<TransactionPoint[]> {
    return parseTransactions(this.fleet.metrics(accountId, from, to).body)
  }

  async setPolicy(controlId: string, effect: PolicyEffect | null): Promise<ArmResult<unknown>> {
    return toResult(this.fleet.setPolicy(controlId, effect))
  }
}
