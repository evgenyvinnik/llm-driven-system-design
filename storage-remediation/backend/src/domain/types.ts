/**
 * Resource shapes shared by the cloud simulator and the remediation services.
 * They follow the Azure storage account model: account properties on the
 * account resource, soft delete on the blobServices/default child, and logging
 * on a diagnostic setting attached to the blob service.
 * @module domain/types
 */

export type ResourceKind = 'account' | 'blobService' | 'diagnostics'

export type TlsVersion = 'TLS1_0' | 'TLS1_1' | 'TLS1_2'

export interface AccountProperties {
  allowBlobPublicAccess: boolean
  allowSharedKeyAccess: boolean
  minimumTlsVersion: TlsVersion
  supportsHttpsTrafficOnly: boolean
  publicNetworkAccess: 'Enabled' | 'Disabled'
  networkAcls: { defaultAction: 'Allow' | 'Deny'; bypass: string; ipRules: { value: string }[] }
}

export interface BlobServiceProperties {
  deleteRetentionPolicy: { enabled: boolean; days?: number }
}

export interface DiagnosticsProperties {
  enabled: boolean
  workspaceId: string | null
  categories: string[]
  /** When logging started; bounds how far back usage evidence can reach. */
  createdAt: string | null
}

export type KindProperties = AccountProperties | BlobServiceProperties | DiagnosticsProperties

/** An account as the remediation system knows it: one inventory row. */
export interface AccountSnapshot {
  id: string
  subscriptionId: string
  resourceGroup: string
  name: string
  location: string
  tags: Record<string, string>
  properties: AccountProperties
  /** null until the child resource has been read. */
  blobService: BlobServiceProperties | null
  diagnostics: DiagnosticsProperties | null
}

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export type EvidenceClass = 'safe_to_fix' | 'needs_owner_migration' | 'insufficient_evidence'

export type PolicyEffect = 'audit' | 'deny' | 'modify' | 'deployIfNotExists' | 'auditIfNotExists'

export type Ring = 'nonprod' | 'prod'

/** Usage signals derived from access logs (StorageBlobLogs) for one account. */
export interface UsageSummary {
  hasLogs: boolean
  /** Days of logs actually available: min(lookback, days since logging started). */
  windowDays: number
  counts: {
    anonymous: number
    sas: number
    accountKey: number
    oauth: number
    legacyTls: number
    http: number
    publicNetwork: number
    total: number
  }
  callers: UsageCaller[]
}

export interface UsageCaller {
  callerIp: string
  userAgent: string
  authType: 'Anonymous' | 'SAS' | 'AccountKey' | 'OAuth'
  tlsVersion: string
  protocol: 'HTTPS' | 'HTTP'
  requests: number
  lastSeen: string
}

export function parseResourceId(id: string): { subscriptionId: string; resourceGroup: string; name: string } | null {
  const m = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Storage\/storageAccounts\/([^/]+)$/i.exec(id)
  return m ? { subscriptionId: m[1], resourceGroup: m[2], name: m[3] } : null
}

export function accountResourceId(subscriptionId: string, resourceGroup: string, name: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${name}`
}

/** The ARM path of a resource kind under an account. */
export function kindPath(accountId: string, kind: ResourceKind): string {
  switch (kind) {
    case 'account':
      return accountId
    case 'blobService':
      return `${accountId}/blobServices/default`
    case 'diagnostics':
      return `${accountId}/blobServices/default/providers/Microsoft.Insights/diagnosticSettings/storage-logs`
  }
}

/** prod or nonprod, from the env tag; sandbox, dev, test and staging count as nonprod. */
export function ringOf(environment: string | undefined | null): Ring {
  return (environment ?? '').toLowerCase() === 'prod' ? 'prod' : 'nonprod'
}
