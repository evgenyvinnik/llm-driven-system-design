export type Role = 'member' | 'org_admin' | 'platform_admin'

export interface User {
  id: string
  username: string
  displayName: string
  role: Role
  orgId: string
  orgName: string
}

export type SettingValue = boolean | number | string
export type SettingType = 'boolean' | 'enum' | 'integer' | 'string'
export type Source = 'enforced' | 'user' | 'org' | 'default'
export type KeyStatus = 'active' | 'deprecated' | 'retired'

export interface Definition {
  key: string
  type: SettingType
  scope: 'user' | 'org'
  defaultValue: SettingValue
  allowedValues: string[] | null
  minValue: number | null
  maxValue: number | null
  maxLength: number | null
  format: 'hhmm' | 'timezone' | null
  category: string
  label: string
  description: string
  displayOrder: number
  status: KeyStatus
  deprecatedAt: string | null
  sunsetAt: string | null
  replacedBy: string | null
}

export interface EffectiveEntry {
  value: SettingValue
  source: Source
  locked: boolean
  lockReason: 'enforced' | 'org_scope' | null
  rev: number
  userValue?: SettingValue
  updatedAt?: string
  updatedBy?: string
  deprecated?: true
}

export interface Revisions {
  revision: number
  orgRevision: number
  catalogRevision: number
}

export interface EffectiveDoc extends Revisions {
  settings: Record<string, EffectiveEntry>
}

export interface FieldError {
  key: string
  code: string
  message: string
  replacedBy?: string | null
}

export interface PatchWarning {
  key: string
  code: 'DEPRECATED_IGNORED'
  message: string
  replacedBy: string | null
  sunsetAt: string | null
}

export interface KeyConflict {
  key: string
  baseRevision: number
  changedAtRevision: number
  yourValue: SettingValue | null
  currentValue: SettingValue | null
  changedBy: string | null
}

export interface PatchResult extends EffectiveDoc {
  applied: string[]
  unchanged: string[]
  warnings: PatchWarning[]
}

export interface UserChangedEvent extends Revisions {
  type: 'user'
  userId: string
  changes: Record<string, EffectiveEntry>
  clientId: string | null
  clientLabel: string | null
  origin: string
  at: string
}

export interface OrgChangedEvent {
  type: 'org'
  orgId: string
  orgRevision: number
  keys: string[]
  origin: string
}

export interface CatalogChangedEvent {
  type: 'catalog'
  catalogRevision: number
  keys: string[]
  origin: string
}

export interface HelloEvent extends Revisions {
  instanceId: string
}

export interface PolicyItem {
  key: string
  status: KeyStatus
  value: SettingValue | null
  enforced: boolean
  rev: number
  updatedAt: string | null
  overrideCount: number
}

export interface OrgPolicy {
  orgId: string
  orgName: string
  orgRevision: number
  catalogRevision: number
  memberCount: number
  items: PolicyItem[]
}

export interface ChangeLogEntry {
  id: number
  scope: 'user' | 'org' | 'catalog'
  key: string
  oldValue: SettingValue | null
  newValue: SettingValue | null
  enforced: boolean | null
  revision: number
  actor: string | null
  clientLabel: string | null
  at: string
}
