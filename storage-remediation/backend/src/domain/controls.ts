/**
 * Controls are versioned rules. Each says which resource kind it reads, how to
 * judge the current value, which usage signal reveals a dependency on the
 * insecure setting, and how to write the desired value and restore the old one.
 * Findings record the control version that produced them, so a rule change
 * never silently rewrites history.
 * @module domain/controls
 */
import type {
  AccountProperties,
  AccountSnapshot,
  BlobServiceProperties,
  DiagnosticsProperties,
  KindProperties,
  PolicyEffect,
  ResourceKind,
  Severity,
  UsageSummary,
} from './types.js'

/** Which part of the usage summary shows that something depends on the insecure setting. */
export type DependencySignal = keyof Pick<UsageSummary['counts'], 'anonymous' | 'legacyTls' | 'http' | 'publicNetwork'> | 'sharedKey'

export interface Control {
  id: string
  key: string
  version: number
  title: string
  description: string
  severity: Severity
  kind: ResourceKind
  /** Can turning this on break a working application? */
  breaking: boolean
  dependency: DependencySignal | null
  property: string
  desiredLabel: string
  policy: { definition: string; effects: PolicyEffect[] }
  read(props: KindProperties): unknown
  isCompliant(value: unknown): boolean
  /** Body for the write that makes the resource compliant. */
  desired(value: unknown): Record<string, unknown>
  /** Body for the write that restores a previously read value. */
  restore(before: unknown): Record<string, unknown>
}

const account = (p: KindProperties) => p as AccountProperties

export const WORKSPACE_ID = '/subscriptions/sec-logging/resourceGroups/rg-logging/providers/Microsoft.OperationalInsights/workspaces/law-storage-central'

export const CONTROLS: Control[] = [
  {
    id: 'SA-01',
    key: 'public-blob-access',
    version: 2,
    title: 'Disallow anonymous blob access',
    description: 'allowBlobPublicAccess must be false so no container can be made readable without credentials.',
    severity: 'high',
    kind: 'account',
    breaking: true,
    dependency: 'anonymous',
    property: 'allowBlobPublicAccess',
    desiredLabel: 'false',
    policy: { definition: 'Storage account public access should be disallowed', effects: ['audit', 'deny', 'modify'] },
    read: (p) => account(p).allowBlobPublicAccess,
    isCompliant: (v) => v === false,
    desired: () => ({ properties: { allowBlobPublicAccess: false } }),
    restore: (before) => ({ properties: { allowBlobPublicAccess: Boolean(before) } }),
  },
  {
    id: 'SA-02',
    key: 'shared-key-access',
    version: 1,
    title: 'Disable shared key authorization',
    description: 'allowSharedKeyAccess must be false; callers move to Microsoft Entra ID (RBAC) or user delegation SAS.',
    severity: 'high',
    kind: 'account',
    breaking: true,
    dependency: 'sharedKey',
    property: 'allowSharedKeyAccess',
    desiredLabel: 'false',
    policy: { definition: 'Storage accounts should prevent shared key access', effects: ['audit', 'deny', 'modify'] },
    read: (p) => account(p).allowSharedKeyAccess,
    isCompliant: (v) => v === false,
    desired: () => ({ properties: { allowSharedKeyAccess: false } }),
    restore: (before) => ({ properties: { allowSharedKeyAccess: Boolean(before) } }),
  },
  {
    id: 'SA-03',
    key: 'minimum-tls',
    version: 1,
    title: 'Require TLS 1.2 or later',
    description: 'minimumTlsVersion must be TLS1_2; older clients fail the handshake.',
    severity: 'medium',
    kind: 'account',
    breaking: true,
    dependency: 'legacyTls',
    property: 'minimumTlsVersion',
    desiredLabel: 'TLS1_2',
    policy: { definition: 'Storage accounts should have the specified minimum TLS version', effects: ['audit', 'deny', 'modify'] },
    read: (p) => account(p).minimumTlsVersion,
    isCompliant: (v) => v === 'TLS1_2',
    desired: () => ({ properties: { minimumTlsVersion: 'TLS1_2' } }),
    restore: (before) => ({ properties: { minimumTlsVersion: String(before) } }),
  },
  {
    id: 'SA-04',
    key: 'https-only',
    version: 1,
    title: 'Require secure transfer (HTTPS only)',
    description: 'supportsHttpsTrafficOnly must be true; plain HTTP requests are rejected.',
    severity: 'medium',
    kind: 'account',
    breaking: true,
    dependency: 'http',
    property: 'supportsHttpsTrafficOnly',
    desiredLabel: 'true',
    policy: { definition: 'Secure transfer to storage accounts should be enabled', effects: ['audit', 'deny', 'modify'] },
    read: (p) => account(p).supportsHttpsTrafficOnly,
    isCompliant: (v) => v === true,
    desired: () => ({ properties: { supportsHttpsTrafficOnly: true } }),
    restore: (before) => ({ properties: { supportsHttpsTrafficOnly: Boolean(before) } }),
  },
  {
    id: 'SA-05',
    key: 'network-default-deny',
    version: 1,
    title: 'Restrict network access',
    description: 'publicNetworkAccess Disabled, or networkAcls.defaultAction Deny with trusted Azure services bypassed.',
    severity: 'high',
    kind: 'account',
    breaking: true,
    dependency: 'publicNetwork',
    property: 'networkAcls.defaultAction',
    desiredLabel: 'Deny',
    policy: { definition: 'Storage accounts should restrict network access', effects: ['audit', 'deny'] },
    read: (p) => ({ publicNetworkAccess: account(p).publicNetworkAccess, defaultAction: account(p).networkAcls.defaultAction }),
    isCompliant: (v) => {
      const value = v as { publicNetworkAccess: string; defaultAction: string }
      return value.publicNetworkAccess === 'Disabled' || value.defaultAction === 'Deny'
    },
    desired: () => ({ properties: { networkAcls: { defaultAction: 'Deny', bypass: 'AzureServices', ipRules: [] } } }),
    restore: (before) => {
      const value = before as { publicNetworkAccess: string; defaultAction: string }
      return { properties: { publicNetworkAccess: value.publicNetworkAccess, networkAcls: { defaultAction: value.defaultAction, bypass: 'AzureServices', ipRules: [] } } }
    },
  },
  {
    id: 'SA-06',
    key: 'blob-soft-delete',
    version: 1,
    title: 'Enable blob soft delete (7+ days)',
    description: 'blobServices/default deleteRetentionPolicy enabled with at least 7 days, so deletes are recoverable.',
    severity: 'medium',
    kind: 'blobService',
    breaking: false,
    dependency: null,
    property: 'deleteRetentionPolicy',
    desiredLabel: 'enabled, 7 days',
    policy: { definition: 'Configure blob soft delete on storage accounts', effects: ['audit', 'deployIfNotExists'] },
    read: (p) => (p as BlobServiceProperties).deleteRetentionPolicy,
    isCompliant: (v) => {
      const value = v as { enabled: boolean; days?: number }
      return value.enabled === true && (value.days ?? 0) >= 7
    },
    desired: () => ({ properties: { deleteRetentionPolicy: { enabled: true, days: 7 } } }),
    restore: (before) => ({ properties: { deleteRetentionPolicy: before } }),
  },
  {
    id: 'SA-07',
    key: 'diagnostic-logs',
    version: 1,
    title: 'Send blob logs to Log Analytics',
    description: 'A diagnostic setting sends StorageRead, StorageWrite and StorageDelete to the central workspace. Also the prerequisite for usage evidence on every breaking control.',
    severity: 'medium',
    kind: 'diagnostics',
    breaking: false,
    dependency: null,
    property: 'diagnosticSettings',
    desiredLabel: 'StorageRead/Write/Delete → central workspace',
    policy: { definition: 'Configure diagnostic settings for Blob Services to Log Analytics', effects: ['auditIfNotExists', 'deployIfNotExists'] },
    read: (p) => {
      const d = p as DiagnosticsProperties
      return { enabled: d.enabled, workspaceId: d.workspaceId }
    },
    isCompliant: (v) => {
      const value = v as { enabled: boolean; workspaceId: string | null }
      return value.enabled === true && value.workspaceId === WORKSPACE_ID
    },
    desired: () => ({ properties: { enabled: true, workspaceId: WORKSPACE_ID, categories: ['StorageRead', 'StorageWrite', 'StorageDelete'] } }),
    restore: (before) => {
      const value = before as { enabled: boolean; workspaceId: string | null }
      return { properties: { enabled: value.enabled, workspaceId: value.workspaceId, categories: value.enabled ? ['StorageRead', 'StorageWrite', 'StorageDelete'] : [] } }
    },
  },
]

const byId = new Map(CONTROLS.map((c) => [c.id, c]))

export function getControl(id: string): Control {
  const control = byId.get(id)
  if (!control) throw new Error(`Unknown control ${id}`)
  return control
}

export function findControl(id: string): Control | undefined {
  return byId.get(id)
}

/** The properties of the kind a control reads, or null when not yet observed. */
export function propsFor(snapshot: AccountSnapshot, kind: ResourceKind): KindProperties | null {
  if (kind === 'account') return snapshot.properties
  if (kind === 'blobService') return snapshot.blobService
  return snapshot.diagnostics
}

export interface ControlResult {
  controlId: string
  version: number
  /** null when the resource kind hasn't been read yet (no finding either way). */
  compliant: boolean | null
  observed: unknown
  severity: Severity
}

/** Public access on data tagged confidential or restricted is critical, not high. */
export function effectiveSeverity(control: Control, snapshot: AccountSnapshot): Severity {
  const classification = (snapshot.tags.dataClassification ?? '').toLowerCase()
  if (control.id === 'SA-01' && (classification === 'confidential' || classification === 'restricted')) return 'critical'
  return control.severity
}

export function evaluateAccount(snapshot: AccountSnapshot, controls: Control[] = CONTROLS): ControlResult[] {
  return controls.map((control) => {
    const props = propsFor(snapshot, control.kind)
    if (!props) return { controlId: control.id, version: control.version, compliant: null, observed: null, severity: control.severity }
    const observed = control.read(props)
    return {
      controlId: control.id,
      version: control.version,
      compliant: control.isCompliant(observed),
      observed,
      severity: effectiveSeverity(control, snapshot),
    }
  })
}
