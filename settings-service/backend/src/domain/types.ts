/**
 * Domain types shared by resolution, validation and patch planning. These
 * modules are pure (no I/O), so the whole contract is unit-testable.
 * @module domain/types
 */

export type SettingType = 'boolean' | 'enum' | 'integer' | 'string'
/** `user`: users may set it, the org may default or enforce it. `org`: only the org sets it; users see it read-only. */
export type SettingScope = 'user' | 'org'
export type StringFormat = 'hhmm' | 'timezone'
/** Setting values are JSON primitives. Strict equality is therefore value equality. */
export type SettingValue = boolean | number | string
export type KeyStatus = 'active' | 'deprecated' | 'retired'

export interface Definition {
  key: string
  type: SettingType
  scope: SettingScope
  defaultValue: SettingValue
  allowedValues: string[] | null
  minValue: number | null
  maxValue: number | null
  maxLength: number | null
  format: StringFormat | null
  category: string
  label: string
  description: string
  displayOrder: number
  deprecatedAt: Date | null
  /** End of the grace window. From this instant the key is retired: writes get 422 RETIRED. */
  sunsetAt: Date | null
  replacedBy: string | null
  /** Catalog revision at which this definition was created or last changed. */
  catalogRev: number
}

/** An org policy row. `value: null` is a tombstone (policy cleared), kept so its `rev` survives. */
export interface OrgValue {
  key: string
  value: SettingValue | null
  enforced: boolean
  /** Org policy revision at which this row last changed. */
  rev: number
  updatedAt: Date
}

/** A user's own choice. `value: null` is a tombstone ("reset to inherited"), kept so its `rev` survives. */
export interface UserValue {
  key: string
  value: SettingValue | null
  /** The user's settings revision at which this key last changed. Monotonic, so no ABA on delete + re-create. */
  rev: number
  updatedAt: Date
  updatedBy: string | null
}

/** Where an effective value came from, highest precedence first. */
export type Source = 'enforced' | 'user' | 'org' | 'default'
export type LockReason = 'enforced' | 'org_scope'

export interface EffectiveEntry {
  value: SettingValue
  source: Source
  locked: boolean
  lockReason: LockReason | null
  /** Revision at which the user's own value for this key last changed; 0 if never set. */
  rev: number
  /** The user's own value while enforcement shadows it. It is kept and wins again when the policy is lifted. */
  userValue?: SettingValue
  updatedAt?: string
  updatedBy?: string
  deprecated?: true
}

export type FieldErrorCode =
  | 'UNKNOWN_KEY'
  | 'RETIRED'
  | 'DEPRECATED'
  | 'INVALID_TYPE'
  | 'NOT_ALLOWED'
  | 'OUT_OF_RANGE'
  | 'TOO_LONG'
  | 'INVALID_FORMAT'
  | 'LOCKED'
  | 'NOT_USER_WRITABLE'

export interface FieldError {
  key: string
  code: FieldErrorCode
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
  /** The revision the client said it had seen (If-Match). */
  baseRevision: number
  /** The revision at which someone else changed this key after the client's base. */
  changedAtRevision: number
  yourValue: SettingValue | null
  /** The stored user value that won (null = reset to inherited). */
  currentValue: SettingValue | null
  changedBy: string | null
}
