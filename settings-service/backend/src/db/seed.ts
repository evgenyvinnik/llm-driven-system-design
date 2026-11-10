/**
 * Seeds the catalog, two orgs with policy, and seven users with some explicit
 * choices. Truncates first, so it is safe to rerun. Every password is password123.
 */
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { keys, redis } from '../shared/cache.js'
import { pool, withTransaction } from '../shared/db.js'
import type { SettingValue } from '../domain/types.js'

interface SeedDef {
  key: string
  type: 'boolean' | 'enum' | 'integer' | 'string'
  scope?: 'user' | 'org'
  def: SettingValue
  allowed?: string[]
  min?: number
  max?: number
  maxLength?: number
  format?: 'hhmm' | 'timezone'
  category: string
  label: string
  description: string
  /** Days ago it was deprecated, and days from now the grace window ends (negative = already retired). */
  deprecated?: { daysAgo: number; sunsetInDays: number; replacedBy: string }
}

const DEFS: SeedDef[] = [
  { key: 'notifications.email_enabled', type: 'boolean', def: true, category: 'notifications', label: 'Email notifications', description: 'Send me email about activity I am involved in.' },
  { key: 'notifications.email_digest', type: 'enum', def: 'daily', allowed: ['off', 'daily', 'weekly'], category: 'notifications', label: 'Email digest', description: 'A summary of what I missed.' },
  { key: 'notifications.push_enabled', type: 'boolean', def: true, category: 'notifications', label: 'Push notifications', description: 'Notifications on my phone and desktop.' },
  { key: 'notifications.quiet_hours_start', type: 'string', def: '22:00', format: 'hhmm', category: 'notifications', label: 'Quiet hours start', description: 'No push notifications from this time.' },
  { key: 'notifications.quiet_hours_end', type: 'string', def: '07:00', format: 'hhmm', category: 'notifications', label: 'Quiet hours end', description: 'Push notifications resume at this time.' },
  { key: 'notifications.sms_enabled', type: 'boolean', def: false, category: 'notifications', label: 'SMS alerts', description: 'Text messages for urgent alerts.', deprecated: { daysAgo: 60, sunsetInDays: -30, replacedBy: 'notifications.push_enabled' } },
  { key: 'appearance.theme', type: 'enum', def: 'system', allowed: ['system', 'light', 'dark'], category: 'appearance', label: 'Theme', description: 'Follow the operating system, or pick one.' },
  { key: 'appearance.density', type: 'enum', def: 'comfortable', allowed: ['comfortable', 'compact'], category: 'appearance', label: 'Density', description: 'How much space lists and rows use.' },
  { key: 'appearance.font_scale', type: 'integer', def: 100, min: 80, max: 150, category: 'appearance', label: 'Text size (%)', description: 'Scales all text in the app.' },
  { key: 'appearance.reduce_motion', type: 'boolean', def: false, category: 'appearance', label: 'Reduce motion', description: 'Turn off animations and transitions.' },
  { key: 'appearance.compact_mode', type: 'boolean', def: false, category: 'appearance', label: 'Compact mode', description: 'Older on/off version of Density.', deprecated: { daysAgo: 10, sunsetInDays: 20, replacedBy: 'appearance.density' } },
  { key: 'privacy.show_online_status', type: 'boolean', def: true, category: 'privacy', label: 'Show when I am online', description: 'Others see a green dot next to my name.' },
  { key: 'privacy.read_receipts', type: 'boolean', def: true, category: 'privacy', label: 'Read receipts', description: 'Let senders see when I have read their message.' },
  { key: 'privacy.profile_visibility', type: 'enum', def: 'organization', allowed: ['everyone', 'organization', 'nobody'], category: 'privacy', label: 'Profile visibility', description: 'Who can see my profile details.' },
  { key: 'privacy.data_retention_days', type: 'integer', scope: 'org', def: 365, min: 30, max: 3650, category: 'privacy', label: 'Message retention (days)', description: 'How long messages are kept. Set by your organization.' },
  { key: 'regional.language', type: 'enum', def: 'en-US', allowed: ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'ja-JP'], category: 'regional', label: 'Language', description: 'Language for menus and emails.' },
  { key: 'regional.time_zone', type: 'string', def: 'UTC', format: 'timezone', category: 'regional', label: 'Time zone', description: 'Used for quiet hours, digests and timestamps.' },
  { key: 'regional.date_format', type: 'enum', def: 'system', allowed: ['system', 'mdy', 'dmy', 'ymd'], category: 'regional', label: 'Date format', description: 'How dates are written.' },
  { key: 'regional.week_start', type: 'enum', def: 'sunday', allowed: ['sunday', 'monday'], category: 'regional', label: 'Week starts on', description: 'First day of the week in calendars.' },
  { key: 'profile.status_message', type: 'string', def: '', maxLength: 80, category: 'profile', label: 'Status message', description: 'Shown next to your name. Up to 80 characters.' },
  { key: 'security.session_timeout_minutes', type: 'integer', scope: 'org', def: 480, min: 15, max: 1440, category: 'security', label: 'Sign-out after inactivity (minutes)', description: 'Set by your organization.' },
]

const ORGS = [
  { id: 'acme', name: 'Acme Corp' },
  { id: 'globex', name: 'Globex' },
]

/** In order; each row gets the next org policy revision. */
const POLICY: Record<string, Array<{ key: string; value: SettingValue; enforced?: boolean }>> = {
  acme: [
    { key: 'notifications.email_digest', value: 'weekly' },
    { key: 'regional.time_zone', value: 'America/New_York' },
    { key: 'privacy.read_receipts', value: true, enforced: true },
    { key: 'notifications.email_enabled', value: true, enforced: true },
    { key: 'privacy.data_retention_days', value: 90 },
    { key: 'security.session_timeout_minutes', value: 60 },
  ],
  globex: [
    { key: 'regional.language', value: 'de-DE' },
    { key: 'regional.time_zone', value: 'Europe/Berlin' },
    { key: 'regional.week_start', value: 'monday' },
    { key: 'regional.date_format', value: 'dmy' },
    { key: 'privacy.show_online_status', value: false, enforced: true },
    { key: 'appearance.theme', value: 'light' },
  ],
}

const USERS: Array<{ username: string; name: string; org: string; role: 'member' | 'org_admin' | 'platform_admin'; values: Array<[string, SettingValue, string]> }> = [
  { username: 'admin', name: 'Ada Admin', org: 'acme', role: 'platform_admin', values: [['appearance.theme', 'light', 'Laptop (web)']] },
  {
    username: 'alice',
    name: 'Alice Chen',
    org: 'acme',
    role: 'member',
    values: [
      ['appearance.theme', 'light', 'Laptop (web)'],
      ['regional.language', 'en-GB', 'Phone (iOS app)'],
      ['privacy.read_receipts', false, 'Laptop (web)'],
      ['notifications.quiet_hours_start', '23:00', 'Phone (iOS app)'],
      ['privacy.profile_visibility', 'everyone', 'Laptop (web)'],
      ['appearance.compact_mode', true, 'Phone (iOS app) v2.3'],
    ],
  },
  {
    username: 'bob',
    name: 'Bob Martinez',
    org: 'acme',
    role: 'member',
    values: [
      ['appearance.theme', 'dark', 'Phone (Android app)'],
      ['notifications.email_digest', 'off', 'Laptop (web)'],
      ['privacy.read_receipts', false, 'Laptop (web)'],
    ],
  },
  {
    username: 'carol',
    name: 'Carol Davis',
    org: 'acme',
    role: 'member',
    values: [
      ['regional.time_zone', 'America/Los_Angeles', 'Laptop (web)'],
      ['appearance.font_scale', 115, 'Laptop (web)'],
    ],
  },
  { username: 'grace', name: 'Grace Kim', org: 'globex', role: 'org_admin', values: [] },
  {
    username: 'dave',
    name: 'Dave Müller',
    org: 'globex',
    role: 'member',
    values: [
      ['appearance.theme', 'dark', 'Laptop (web)'],
      ['privacy.show_online_status', true, 'Phone (iOS app)'],
      ['notifications.push_enabled', false, 'Phone (iOS app)'],
    ],
  },
  { username: 'erin', name: 'Erin Schmidt', org: 'globex', role: 'member', values: [['regional.language', 'fr-FR', 'Laptop (web)']] },
]

const DAY = 24 * 60 * 60 * 1000

async function clearValkey(): Promise<void> {
  // SCAN + DEL per batch: DEL does not expand patterns.
  let cursor = '0'
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', keys.pattern, 'COUNT', 500)
    cursor = next
    if (found.length > 0) await redis.del(...found)
  } while (cursor !== '0')
}

async function seed(): Promise<void> {
  const hash = await bcrypt.hash('password123', 10)
  const now = Date.now()

  await withTransaction(async (c) => {
    await c.query('TRUNCATE setting_changes, user_settings, org_settings, users, organizations, setting_definitions RESTART IDENTITY CASCADE')
    await c.query('UPDATE catalog_state SET revision = 1 WHERE id')

    // Two passes: replaced_by references another definition.
    let order = 0
    for (const d of DEFS) {
      order += 10
      await c.query(
        `INSERT INTO setting_definitions (key, type, scope, default_value, allowed_values, min_value, max_value, max_length, format,
                                          category, label, description, display_order, catalog_rev, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, 1, $14)`,
        [d.key, d.type, d.scope ?? 'user', JSON.stringify(d.def), d.allowed ? JSON.stringify(d.allowed) : null, d.min ?? null, d.max ?? null,
          d.maxLength ?? null, d.format ?? null, d.category, d.label, d.description, order, new Date(now - 120 * DAY)],
      )
    }
    for (const d of DEFS) {
      if (!d.deprecated) continue
      await c.query('UPDATE setting_definitions SET deprecated_at = $2, sunset_at = $3, replaced_by = $4 WHERE key = $1', [
        d.key,
        new Date(now - d.deprecated.daysAgo * DAY),
        new Date(now + d.deprecated.sunsetInDays * DAY),
        d.deprecated.replacedBy,
      ])
    }

    for (const o of ORGS) {
      const policy = POLICY[o.id] ?? []
      await c.query('INSERT INTO organizations (id, name, policy_revision) VALUES ($1, $2, $3)', [o.id, o.name, policy.length])
    }

    const ids = new Map<string, string>()
    for (const u of USERS) {
      const id = randomUUID()
      ids.set(u.username, id)
      await c.query(
        `INSERT INTO users (id, org_id, username, display_name, role, password_hash, settings_revision) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, u.org, u.username, u.name, u.role, hash, u.values.length],
      )
      let rev = 0
      for (const [key, value, label] of u.values) {
        rev += 1
        const at = new Date(now - (u.values.length - rev + 1) * 3 * DAY)
        await c.query(
          'INSERT INTO user_settings (user_id, key, value, rev, updated_at, updated_by) VALUES ($1, $2, $3::jsonb, $4, $5, $6)',
          [id, key, JSON.stringify(value), rev, at, label],
        )
        await c.query(
          `INSERT INTO setting_changes (scope, org_id, user_id, key, new_value, revision, actor_id, client_label, created_at)
           VALUES ('user', $1, $2, $3, $4::jsonb, $5, $2, $6, $7)`,
          [u.org, id, key, JSON.stringify(value), rev, label, at],
        )
      }
    }

    for (const o of ORGS) {
      const admin = USERS.find((u) => u.org === o.id && u.role !== 'member')
      const adminId = admin ? ids.get(admin.username) : null
      let rev = 0
      for (const p of POLICY[o.id] ?? []) {
        rev += 1
        const at = new Date(now - (8 - rev) * DAY)
        await c.query(
          'INSERT INTO org_settings (org_id, key, value, enforced, rev, updated_at, updated_by) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)',
          [o.id, p.key, JSON.stringify(p.value), p.enforced ?? false, rev, at, adminId],
        )
        await c.query(
          `INSERT INTO setting_changes (scope, org_id, key, new_value, enforced, revision, actor_id, client_label, created_at)
           VALUES ('org', $1, $2, $3::jsonb, $4, $5, $6, 'admin console', $7)`,
          [o.id, p.key, JSON.stringify(p.value), p.enforced ?? false, rev, adminId, at],
        )
      }
    }
  })

  await clearValkey()
  console.log(`Seeded ${DEFS.length} definitions, ${ORGS.length} orgs, ${USERS.length} users (password: password123)`)
}

try {
  await seed()
} catch (err) {
  console.error('Seed failed:', err)
  process.exitCode = 1
} finally {
  await pool.end()
  redis.disconnect()
}
