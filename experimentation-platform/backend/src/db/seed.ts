/**
 * Seeds users, environments and the demo flags and experiments. Flags are
 * created through the same service functions the console uses, so the audit
 * log, version history and snapshot sequence look like real usage (including
 * a 90/10 → 80/20 → 50/50 ramp and a kill switch). Re-running is safe: users
 * and environments are upserted, flags are only created on an empty database.
 */
import bcrypt from 'bcryptjs'
import { redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import { clearEnvironmentCache } from '../services/environment-service.js'
import { createFlag, killSwitch, transitionStatus, updateConfig, type Actor } from '../services/flag-service.js'

const USERS = [
  { username: 'alice', displayName: 'Alice Romero', role: 'admin', country: null, plan: null, orgId: null },
  { username: 'bob', displayName: 'Bob Tanaka', role: 'viewer', country: null, plan: null, orgId: null },
  { username: 'maya', displayName: 'Maya Chen', role: 'admin', country: null, plan: null, orgId: null },
  { username: 'carol', displayName: 'Carol Davis', role: 'shopper', country: 'US', plan: 'free', orgId: 'org_brewhouse' },
  { username: 'dave', displayName: 'Dave Okafor', role: 'shopper', country: 'CA', plan: 'pro', orgId: 'org_brewhouse' },
  { username: 'erin', displayName: 'Erin Müller', role: 'shopper', country: 'DE', plan: 'free', orgId: 'org_kaffee' },
] as const

/** Local-only keys, printed in the README. Client keys are public by design; server keys are not. */
export const ENVIRONMENTS = [
  { key: 'dev', name: 'Development', clientKey: 'cli_dev_7d2e91c4a5b3f608', serverKey: 'srv_dev_1c8b5e3a9f2d4e70' },
  { key: 'prod', name: 'Production', clientKey: 'cli_prod_4f9a2c7e1b3d5a60', serverKey: 'srv_prod_9e4a7c2f5b1d3e86' },
]

async function seedUsers(): Promise<Record<string, Actor>> {
  const hash = await bcrypt.hash('password123', 10)
  const actors: Record<string, Actor> = {}
  for (const u of USERS) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, country, plan, org_id) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name, password_hash = EXCLUDED.password_hash, role = EXCLUDED.role,
         country = EXCLUDED.country, plan = EXCLUDED.plan, org_id = EXCLUDED.org_id
       RETURNING id`,
      [u.username, u.displayName, hash, u.role, u.country, u.plan, u.orgId],
    )
    actors[u.username] = { id: rows[0].id, username: u.username }
  }
  return actors
}

async function seedEnvironments(): Promise<void> {
  for (const e of ENVIRONMENTS) {
    await pool.query(
      `INSERT INTO environments (key, name, client_key, server_key) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, client_key = EXCLUDED.client_key, server_key = EXCLUDED.server_key`,
      [e.key, e.name, e.clientKey, e.serverKey],
    )
  }
  clearEnvironmentCache()
}

const qaRule = { id: 'qa-force', description: 'QA accounts always see the treatment', conditions: [{ attribute: 'id', operator: 'in' as const, values: ['qa-tester-1', 'qa-tester-2'] }], action: { type: 'force' as const, variant: 'treatment' } }
const noEmployees = { id: 'no-employees', description: 'Employees never enter the experiment', conditions: [{ attribute: 'plan', operator: 'in' as const, values: ['employee'] }], action: { type: 'exclude' as const } }

async function seedFlags(a: Record<string, Actor>): Promise<void> {
  const alice = a.alice
  const maya = a.maya
  const version = async (key: string, env: string) => {
    const { rows } = await pool.query<{ version: number }>('SELECT c.version FROM flag_configs c JOIN flags f ON f.id = c.flag_id WHERE f.key = $1 AND c.environment = $2', [key, env])
    return rows[0].version
  }

  // 1. A plain feature flag on a 25% rollout in prod, everyone in dev.
  await createFlag(alice, { key: 'new_search', kind: 'flag', name: 'New search bar', description: 'Typeahead search bar on the storefront header.', unitType: 'user', primaryMetric: 'purchase', attributionWindowHours: 72, surface: 'Storefront header' })
  await updateConfig(alice, 'new_search', 'prod', await version('new_search', 'prod'), {
    weights: { on: 2500 },
    rules: [{ id: 'staff-on', description: 'Staff always get the new search', conditions: [{ attribute: 'plan', operator: 'in', values: ['employee'] }], action: { type: 'force', variant: 'on' } }],
  })
  await transitionStatus(alice, 'new_search', 'prod', 'running')
  await updateConfig(alice, 'new_search', 'dev', await version('new_search', 'dev'), { weights: { on: 10_000 } })
  await transitionStatus(alice, 'new_search', 'dev', 'running')

  // 2. The experiment with a real effect, ramped 10% → 20% → 50% treatment.
  await createFlag(maya, {
    key: 'checkout_cta',
    kind: 'experiment',
    name: 'Buy-button copy',
    description: '"Buy now · free shipping" instead of "Add to cart" on the product page.',
    unitType: 'user',
    variants: [
      { key: 'control', name: 'Add to cart', value: 'Add to cart' },
      { key: 'treatment', name: 'Buy now · free shipping', value: 'Buy now · free shipping' },
    ],
    primaryMetric: 'purchase',
    attributionWindowHours: 72,
    surface: 'Product page buy button (most visitors open a product)',
  })
  await updateConfig(maya, 'checkout_cta', 'prod', await version('checkout_cta', 'prod'), { weights: { control: 9000, treatment: 1000 }, rules: [qaRule, noEmployees] })
  await transitionStatus(maya, 'checkout_cta', 'prod', 'running')
  await updateConfig(maya, 'checkout_cta', 'prod', await version('checkout_cta', 'prod'), { weights: { control: 8000, treatment: 2000 } })
  await updateConfig(alice, 'checkout_cta', 'prod', await version('checkout_cta', 'prod'), { weights: { control: 5000, treatment: 5000 } })
  await updateConfig(maya, 'checkout_cta', 'dev', await version('checkout_cta', 'dev'), { rules: [qaRule] })
  await transitionStatus(maya, 'checkout_cta', 'dev', 'running')

  // 3. No real effect, and on a tab most visitors never open: assigned ≫ exposed.
  await createFlag(maya, {
    key: 'rewards_teaser',
    kind: 'experiment',
    name: 'Rewards tab: double-points banner',
    description: 'A "double points this week" banner at the top of the Rewards tab.',
    unitType: 'user',
    variants: [
      { key: 'control', name: 'No banner', value: false },
      { key: 'treatment', name: 'Double-points banner', value: true },
    ],
    primaryMetric: 'purchase',
    attributionWindowHours: 72,
    surface: 'Rewards tab (most visitors never open it)',
  })
  await updateConfig(maya, 'rewards_teaser', 'prod', await version('rewards_teaser', 'prod'), { rules: [noEmployees] })
  await transitionStatus(maya, 'rewards_teaser', 'prod', 'running')

  // 4. Deliberately broken: the treatment logs exposure from an image onLoad, so some treatment exposures never fire.
  await createFlag(alice, {
    key: 'shipping_banner',
    kind: 'experiment',
    name: 'Cart: free-shipping banner',
    description: 'Free-shipping threshold banner on the cart page. Its treatment logs exposure only after a slow image loads (the bug the SRM check catches).',
    unitType: 'user',
    variants: [
      { key: 'control', name: 'Plain notice', value: 'plain' },
      { key: 'treatment', name: 'Illustrated banner', value: 'illustrated' },
    ],
    primaryMetric: 'purchase',
    attributionWindowHours: 72,
    surface: 'Cart page banner',
  })
  await transitionStatus(alice, 'shipping_banner', 'prod', 'running')

  // 5. A draft, bucketed by organization.
  await createFlag(maya, {
    key: 'team_dashboard',
    kind: 'experiment',
    name: 'Team dashboard layout',
    description: 'Card layout vs table layout for team accounts. Bucketed by organization so colleagues see the same layout.',
    unitType: 'org',
    variants: [
      { key: 'table', name: 'Table layout' },
      { key: 'cards', name: 'Card layout' },
    ],
    primaryMetric: 'team_invite',
    attributionWindowHours: 168,
    surface: 'Team dashboard',
  })

  // 6. A flag that was killed in prod.
  await createFlag(alice, { key: 'promo_ribbon', kind: 'flag', name: 'Autumn promo ribbon', description: 'Sitewide ribbon for the autumn sale.', unitType: 'anonymous', primaryMetric: 'purchase', attributionWindowHours: 72, surface: 'Every page' })
  for (const env of ['dev', 'prod']) {
    await updateConfig(alice, 'promo_ribbon', env, await version('promo_ribbon', env), { weights: { on: 10_000 } })
    await transitionStatus(alice, 'promo_ribbon', env, 'running')
  }
  await killSwitch(maya, 'promo_ribbon', 'prod', 'ribbon covers the checkout button on Safari')
}

async function seed(): Promise<void> {
  try {
    const actors = await seedUsers()
    await seedEnvironments()
    const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM flags')
    if (Number(rows[0].n) > 0) {
      console.log('Flags already present; users and environments refreshed, flags left as they are')
    } else {
      await seedFlags(actors)
      console.log('Seeded 6 flags and experiments')
    }
    console.log('Users (password123): alice (admin), bob (viewer), maya (admin); shoppers carol, dave, erin')
  } catch (err) {
    console.error('Seed failed:', err)
    process.exitCode = 1
  } finally {
    await pool.end()
    redis.disconnect()
  }
}

await seed()
