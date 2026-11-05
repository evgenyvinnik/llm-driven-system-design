/**
 * Inventory writes and reads. Upserts are batched (one statement per page) and
 * guarded by the resource's lastModifiedAt, so whichever read is newest wins
 * regardless of arrival order: a Resource Graph page that lags an ARM read
 * made by the change-feed path is skipped for that account.
 * @module store/inventory
 */
import type { GraphRow, ResourceBody, SubscriptionInfo } from '../arm/control-plane.js'
import type { AccountProperties, AccountSnapshot, BlobServiceProperties, DiagnosticsProperties, UsageSummary } from '../domain/types.js'
import { parseResourceId } from '../domain/types.js'
import type { Queryable } from '../shared/db.js'

export interface SubscriptionMeta {
  environment: string
  ownerTeam: string | null
}

export async function upsertSubscriptions(db: Queryable, subs: SubscriptionInfo[]): Promise<Map<string, SubscriptionMeta>> {
  const rows = subs.map((s) => ({ subscription_id: s.subscriptionId, display_name: s.displayName, management_group: s.managementGroup, environment: s.tags.env ?? 'unknown', owner_team: s.tags.owner ?? null }))
  await db.query(
    `INSERT INTO subscriptions (subscription_id, display_name, management_group, environment, owner_team)
     SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(subscription_id text, display_name text, management_group text, environment text, owner_team text)
     ON CONFLICT (subscription_id) DO UPDATE SET display_name = EXCLUDED.display_name, management_group = EXCLUDED.management_group,
       environment = EXCLUDED.environment, owner_team = EXCLUDED.owner_team, updated_at = now()`,
    [JSON.stringify(rows)],
  )
  return new Map(subs.map((s) => [s.subscriptionId, { environment: s.tags.env ?? 'unknown', ownerTeam: s.tags.owner ?? null }]))
}

export async function loadSubscriptionMeta(db: Queryable): Promise<Map<string, SubscriptionMeta>> {
  const { rows } = await db.query<{ subscription_id: string; environment: string; owner_team: string | null }>('SELECT subscription_id, environment, owner_team FROM subscriptions')
  return new Map(rows.map((r) => [r.subscription_id, { environment: r.environment, ownerTeam: r.owner_team }]))
}

export interface AccountObservation {
  id: string
  location: string
  tags: Record<string, string>
  properties: AccountProperties
  modifiedAt: string
  via: 'graph' | 'arm' | 'event'
}

export function observationFromGraph(row: GraphRow): AccountObservation {
  return { id: row.id, location: row.location, tags: row.tags ?? {}, properties: stripAccountProps(row.properties), modifiedAt: row.systemData.lastModifiedAt, via: 'graph' }
}

export function observationFromArm(body: ResourceBody, via: 'arm' | 'event'): AccountObservation {
  return { id: body.id, location: body.location ?? 'unknown', tags: body.tags ?? {}, properties: stripAccountProps(body.properties), modifiedAt: body.systemData?.lastModifiedAt ?? new Date().toISOString(), via }
}

function stripAccountProps(p: Record<string, unknown>): AccountProperties {
  return {
    allowBlobPublicAccess: Boolean(p.allowBlobPublicAccess),
    allowSharedKeyAccess: p.allowSharedKeyAccess === undefined ? true : Boolean(p.allowSharedKeyAccess),
    minimumTlsVersion: (p.minimumTlsVersion as AccountProperties['minimumTlsVersion']) ?? 'TLS1_0',
    supportsHttpsTrafficOnly: Boolean(p.supportsHttpsTrafficOnly),
    publicNetworkAccess: (p.publicNetworkAccess as AccountProperties['publicNetworkAccess']) ?? 'Enabled',
    networkAcls: (p.networkAcls as AccountProperties['networkAcls']) ?? { defaultAction: 'Allow', bypass: 'AzureServices', ipRules: [] },
  }
}

/** Returns how many observations were written; the rest were older than what we already had. */
export async function upsertAccounts(db: Queryable, observations: AccountObservation[], subs: Map<string, SubscriptionMeta>): Promise<{ written: string[]; stale: number }> {
  if (observations.length === 0) return { written: [], stale: 0 }
  const rows = observations.flatMap((o) => {
    const ref = parseResourceId(o.id)
    if (!ref) return []
    const sub = subs.get(ref.subscriptionId)
    const owner = o.tags.owner ?? sub?.ownerTeam ?? null
    return [
      {
        id: o.id,
        subscription_id: ref.subscriptionId,
        resource_group: ref.resourceGroup,
        name: ref.name,
        location: o.location,
        tags: o.tags,
        owner,
        owner_source: o.tags.owner ? 'tag' : 'subscription',
        environment: o.tags.env ?? sub?.environment ?? 'unknown',
        data_classification: o.tags.dataClassification ?? null,
        properties: o.properties,
        properties_modified_at: o.modifiedAt,
        observed_via: o.via,
      },
    ]
  })
  const { rows: written } = await db.query<{ id: string }>(
    `INSERT INTO storage_accounts (id, subscription_id, resource_group, name, location, tags, owner, owner_source, environment,
       data_classification, properties, properties_modified_at, observed_via, observed_at)
     SELECT r.id, r.subscription_id, r.resource_group, r.name, r.location, r.tags, r.owner, r.owner_source, r.environment,
       r.data_classification, r.properties, r.properties_modified_at, r.observed_via, now()
     FROM jsonb_to_recordset($1::jsonb) AS r(id text, subscription_id text, resource_group text, name text, location text, tags jsonb,
       owner text, owner_source text, environment text, data_classification text, properties jsonb, properties_modified_at timestamptz, observed_via text)
     ON CONFLICT (id) DO UPDATE SET tags = EXCLUDED.tags, owner = EXCLUDED.owner, owner_source = EXCLUDED.owner_source,
       environment = EXCLUDED.environment, data_classification = EXCLUDED.data_classification, location = EXCLUDED.location,
       properties = EXCLUDED.properties, properties_modified_at = EXCLUDED.properties_modified_at,
       observed_via = EXCLUDED.observed_via, observed_at = now(), deleted_at = NULL
     WHERE storage_accounts.properties_modified_at <= EXCLUDED.properties_modified_at
     RETURNING id`,
    [JSON.stringify(rows)],
  )
  return { written: written.map((r) => r.id), stale: rows.length - written.length }
}

export interface ChildObservation {
  accountId: string
  props: BlobServiceProperties | DiagnosticsProperties
  modifiedAt: string
}

export async function upsertChildren(db: Queryable, kind: 'blobService' | 'diagnostics', observations: ChildObservation[]): Promise<number> {
  if (observations.length === 0) return 0
  const col = kind === 'blobService' ? 'blob_service' : 'diagnostics'
  const rows = observations.map((o) => ({ id: o.accountId, props: o.props, modified_at: o.modifiedAt }))
  const { rowCount } = await db.query(
    `UPDATE storage_accounts a SET ${col} = r.props, ${col}_modified_at = r.modified_at, children_read_at = now()
     FROM jsonb_to_recordset($1::jsonb) AS r(id text, props jsonb, modified_at timestamptz)
     WHERE a.id = r.id AND (a.${col}_modified_at IS NULL OR a.${col}_modified_at <= r.modified_at)`,
    [JSON.stringify(rows)],
  )
  return rowCount ?? 0
}

interface SnapshotRow {
  id: string
  subscription_id: string
  resource_group: string
  name: string
  location: string
  tags: Record<string, string>
  properties: AccountProperties
  blob_service: BlobServiceProperties | null
  diagnostics: DiagnosticsProperties | null
  has_logs: boolean | null
  window_days: number | null
  counts: UsageSummary['counts'] | null
  callers: UsageSummary['callers'] | null
}

export interface LoadedAccount {
  snapshot: AccountSnapshot
  usage: UsageSummary | null
}

export async function loadAccounts(db: Queryable, ids: string[]): Promise<LoadedAccount[]> {
  if (ids.length === 0) return []
  const { rows } = await db.query<SnapshotRow>(
    `SELECT a.id, a.subscription_id, a.resource_group, a.name, a.location, a.tags, a.properties, a.blob_service, a.diagnostics,
            e.has_logs, e.window_days, e.counts, e.callers
       FROM storage_accounts a LEFT JOIN usage_evidence e ON e.account_id = a.id
      WHERE a.id = ANY($1) AND a.deleted_at IS NULL`,
    [ids],
  )
  return rows.map((r) => ({
    snapshot: {
      id: r.id,
      subscriptionId: r.subscription_id,
      resourceGroup: r.resource_group,
      name: r.name,
      location: r.location,
      tags: r.tags,
      properties: r.properties,
      blobService: r.blob_service,
      diagnostics: r.diagnostics,
    },
    usage: r.counts ? { hasLogs: Boolean(r.has_logs), windowDays: r.window_days ?? 0, counts: r.counts, callers: r.callers ?? [] } : null,
  }))
}
