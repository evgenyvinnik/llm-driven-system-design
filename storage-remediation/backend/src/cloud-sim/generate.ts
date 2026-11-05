/**
 * Deterministic fleet generator. The same seed always produces the same
 * subscriptions, accounts, configs and callers, so `npm run db:seed` and a
 * fresh simulator agree without sharing a file.
 *
 * The mix is chosen to exercise the design: most accounts have at least one
 * insecure setting, a share of them have callers that depend on it, some have
 * no diagnostic logs (no evidence), some started logging recently (short
 * window), and a handful hide a quarterly job whose last run is older than the
 * 30-day evidence window.
 * @module cloud-sim/generate
 */
import { WORKSPACE_ID } from '../domain/controls.js'
import { accountResourceId, type AccountProperties, type TlsVersion } from '../domain/types.js'
import { DEFAULT_FAULTS, type FleetState, type SimAccount, type SimClient, type SimSubscription } from './model.js'

export const TEAMS = [
  'payments',
  'checkout',
  'data-platform',
  'analytics',
  'identity',
  'web-frontend',
  'mobile',
  'ml-research',
  'finance-apps',
  'hr-systems',
  'logistics',
  'marketing-tech',
]

const APPS = ['orders', 'ledger', 'events', 'media', 'exports', 'reports', 'backups', 'ingest', 'catalog', 'invoices', 'telemetry', 'archive']
const LOCATIONS = ['eastus', 'eastus2', 'westeurope', 'northeurope', 'westus2', 'centralus']
const DAY = 86_400_000

export type Rng = () => number

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)]
const chance = (rng: Rng, p: number) => rng() < p
const hex = (rng: Rng, n: number) => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join('')
const alnum = (rng: Rng, n: number) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rng() * 36)]).join('')

function uuid(rng: Rng): string {
  return `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-${pick(rng, ['8', '9', 'a', 'b'])}${hex(rng, 3)}-${hex(rng, 12)}`
}

export function etagFor(version: number, rng: Rng = Math.random): string {
  return `"${version.toString(16).padStart(4, '0')}${hex(rng, 12)}"`
}

function publicIp(rng: Rng): string {
  return `${pick(rng, [20, 40, 52, 104, 131, 168])}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.${1 + Math.floor(rng() * 253)}`
}

function privateIp(rng: Rng): string {
  return `10.${Math.floor(rng() * 64)}.${Math.floor(rng() * 255)}.${1 + Math.floor(rng() * 253)}`
}

function generateSubscriptions(rng: Rng, count: number): SimSubscription[] {
  return Array.from({ length: count }, (_, i) => {
    const env = i < Math.round(count * 0.36) ? 'prod' : i < Math.round(count * 0.8) ? (i % 2 ? 'dev' : 'test') : 'sandbox'
    const team = TEAMS[i % TEAMS.length]
    return {
      subscriptionId: uuid(rng),
      displayName: `${team}-${env}-${String(i + 1).padStart(2, '0')}`,
      managementGroup: env === 'prod' ? 'mg-corp-prod' : env === 'sandbox' ? 'mg-sandbox' : 'mg-corp-nonprod',
      tags: { env, owner: team },
    }
  })
}

/** Insecure settings are more common outside production; nothing is fully clean by default. */
function generateProperties(rng: Rng, env: string): AccountProperties {
  const lax = env === 'prod' ? 0 : env === 'sandbox' ? 0.15 : 0.08
  const tls: TlsVersion = chance(rng, 0.1 + lax) ? 'TLS1_0' : chance(rng, 0.08) ? 'TLS1_1' : 'TLS1_2'
  const networkOpen = chance(rng, 0.5 + lax)
  return {
    allowBlobPublicAccess: chance(rng, 0.3 + lax),
    allowSharedKeyAccess: chance(rng, 0.68 + lax),
    minimumTlsVersion: tls,
    supportsHttpsTrafficOnly: !chance(rng, 0.05 + lax / 2),
    publicNetworkAccess: networkOpen || chance(rng, 0.6) ? 'Enabled' : 'Disabled',
    networkAcls: { defaultAction: networkOpen ? 'Allow' : 'Deny', bypass: 'AzureServices', ipRules: [] },
  }
}

function client(rng: Rng, accountName: string, i: number, partial: Partial<SimClient> & Pick<SimClient, 'app' | 'authType'>, networkOpen: boolean): SimClient {
  return {
    id: `${accountName}-c${i}`,
    callerIp: networkOpen && chance(rng, 0.55) ? publicIp(rng) : privateIp(rng),
    userAgent: pick(rng, ['azsdk-net-Storage.Blobs/12.19.1', 'azsdk-python-storage-blob/12.19.0', 'AzCopy/10.24.0', 'azsdk-java-azure-storage-blob/12.25.1', 'Microsoft Azure Storage Explorer, 1.33.0']),
    tlsVersion: 'TLS 1.2',
    protocol: 'HTTPS',
    perMinute: Math.max(1, Math.round(Math.exp(rng() * 5.2))),
    schedule: 'continuous',
    lastRunDaysAgo: 0,
    brokenIntervals: [],
    ...partial,
  }
}

/** Callers consistent with the account's current config: nothing is broken at generation time. */
function generateClients(rng: Rng, name: string, app: string, p: AccountProperties): SimClient[] {
  const networkOpen = p.publicNetworkAccess === 'Enabled' && p.networkAcls.defaultAction === 'Allow'
  const clients: SimClient[] = []
  const add = (partial: Partial<SimClient> & Pick<SimClient, 'app' | 'authType'>) => clients.push(client(rng, name, clients.length, partial, networkOpen))
  if (chance(rng, 0.85)) add({ app: `${app}-service`, authType: 'OAuth' })
  if (p.allowSharedKeyAccess && chance(rng, 0.32)) add({ app: `${app}-batch`, authType: 'AccountKey', userAgent: 'AzCopy/10.24.0' })
  if (p.allowSharedKeyAccess && chance(rng, 0.14)) add({ app: `${app}-partner-share`, authType: 'SAS' })
  if (p.allowBlobPublicAccess && chance(rng, 0.25)) add({ app: `${app}-public-assets`, authType: 'Anonymous', userAgent: 'Mozilla/5.0', perMinute: 20 + Math.round(rng() * 200) })
  if (p.minimumTlsVersion !== 'TLS1_2' && chance(rng, 0.3)) add({ app: `${app}-legacy-client`, authType: 'OAuth', tlsVersion: p.minimumTlsVersion === 'TLS1_0' ? 'TLS 1.0' : 'TLS 1.1' })
  // Bearer tokens require HTTPS, so a plain-HTTP caller authenticates with SAS (or reads anonymously).
  if (!p.supportsHttpsTrafficOnly && (p.allowSharedKeyAccess || p.allowBlobPublicAccess) && chance(rng, 0.4)) {
    add({ app: `${app}-http-uploader`, authType: p.allowSharedKeyAccess ? 'SAS' : 'Anonymous', protocol: 'HTTP' })
  }
  if (clients.length === 0) add({ app: `${app}-service`, authType: 'OAuth' })
  return clients
}

function generateAccount(rng: Rng, sub: SimSubscription, index: number, now: number): SimAccount {
  const env = sub.tags.env
  const team = sub.tags.owner
  const app = pick(rng, APPS)
  const name = `st${team.replace(/[^a-z]/g, '').slice(0, 6)}${app.slice(0, 4)}${alnum(rng, 6)}`.slice(0, 24)
  const resourceGroup = `rg-${team}-${app}`
  const id = accountResourceId(sub.subscriptionId, resourceGroup, name)
  const properties = generateProperties(rng, env)
  const classification = pick(rng, ['public', 'internal', 'internal', 'internal', 'confidential', 'confidential', 'restricted'])
  const tags: Record<string, string> = { env, app, dataClassification: classification, costCenter: `cc-${1000 + (index % 40)}` }
  // ~4% of accounts lost their owner tag: the subscription owner becomes the fallback.
  if (!chance(rng, 0.04)) tags.owner = team
  const diagEnabled = chance(rng, env === 'prod' ? 0.8 : 0.65)
  const recentDiag = diagEnabled && chance(rng, 0.06)
  const createdAt = new Date(now - (60 + Math.floor(rng() * 900)) * DAY).toISOString()
  const modified = new Date(now - Math.floor(rng() * 60) * DAY).toISOString()
  const softDeleteOn = chance(rng, env === 'prod' ? 0.65 : 0.45)
  return {
    id,
    subscriptionId: sub.subscriptionId,
    resourceGroup,
    name,
    location: pick(rng, LOCATIONS),
    tags,
    createdAt,
    account: { props: properties, etag: etagFor(1, rng), version: 1, lastModifiedAt: modified },
    blobService: {
      props: { deleteRetentionPolicy: softDeleteOn ? { enabled: true, days: pick(rng, [7, 14, 30]) } : chance(rng, 0.2) ? { enabled: true, days: 3 } : { enabled: false } },
      etag: etagFor(1, rng),
      version: 1,
      lastModifiedAt: modified,
    },
    diagnostics: {
      props: diagEnabled
        ? { enabled: true, workspaceId: WORKSPACE_ID, categories: ['StorageRead', 'StorageWrite', 'StorageDelete'], createdAt: new Date(now - (recentDiag ? 3 + Math.floor(rng() * 7) : 60 + Math.floor(rng() * 300)) * DAY).toISOString() }
        : { enabled: false, workspaceId: null, categories: [], createdAt: null },
      etag: etagFor(1, rng),
      version: 1,
      lastModifiedAt: modified,
    },
    graph: { current: { props: properties, tags, lastModifiedAt: modified }, pending: [] },
    clients: generateClients(rng, name, app, properties),
  }
}

/**
 * Plants periodic jobs whose last run is older than the default 30-day window:
 * shared-key jobs on quiet accounts (so they land in early waves) and one
 * anonymous partner sync. Impact analysis cannot see them; bake-time
 * verification has to catch them.
 */
function plantHiddenJobs(rng: Rng, accounts: SimAccount[], subs: Map<string, SimSubscription>, now: number): void {
  const quiet = (a: SimAccount) => a.clients.every((c) => c.authType === 'OAuth' && c.callerIp.startsWith('10.'))
  const logsLongEnough = (a: SimAccount) => a.diagnostics.props.enabled && Date.parse(a.diagnostics.props.createdAt ?? '') < now - 60 * DAY
  const candidates = accounts.filter((a) => a.account.props.allowSharedKeyAccess && quiet(a) && logsLongEnough(a))
  const nonprod = candidates.filter((a) => subs.get(a.subscriptionId)?.tags.env !== 'prod')
  const prod = candidates.filter((a) => subs.get(a.subscriptionId)?.tags.env === 'prod')
  const chosen = [...nonprod.slice(0, 3), ...prod.slice(0, 1)]
  for (const a of chosen) {
    for (const c of a.clients) c.perMinute = 1 + Math.floor(rng() * 3)
    a.clients.push({
      ...client(rng, a.name, a.clients.length, { app: 'quarter-end-close', authType: 'AccountKey', userAgent: 'AzCopy/10.21.2' }, false),
      perMinute: 40,
      schedule: 'periodic',
      lastRunDaysAgo: 45,
    })
  }
  const publicCandidate = accounts.find((a) => a.account.props.allowBlobPublicAccess && quiet(a) && logsLongEnough(a) && !chosen.includes(a))
  if (publicCandidate) {
    publicCandidate.clients.push({
      ...client(rng, publicCandidate.name, publicCandidate.clients.length, { app: 'partner-catalog-sync', authType: 'Anonymous', userAgent: 'curl/8.4.0' }, false),
      perMinute: 25,
      schedule: 'periodic',
      lastRunDaysAgo: 38,
    })
  }
}

export function generateFleet(seed: number, subscriptionCount: number, accountCount: number, now = Date.now()): FleetState {
  const rng = mulberry32(seed)
  const subscriptions = generateSubscriptions(rng, subscriptionCount)
  const weights = subscriptions.map(() => 0.4 + rng())
  const total = weights.reduce((a, b) => a + b, 0)
  const accounts: SimAccount[] = []
  let assigned = 0
  subscriptions.forEach((sub, i) => {
    const n = i === subscriptions.length - 1 ? accountCount - assigned : Math.round((weights[i] / total) * accountCount)
    for (let k = 0; k < n; k++) accounts.push(generateAccount(rng, sub, accounts.length, now))
    assigned += n
  })
  plantHiddenJobs(rng, accounts, new Map(subscriptions.map((s) => [s.subscriptionId, s])), now)
  return {
    seed,
    generatedAt: new Date(now).toISOString(),
    subscriptions,
    accounts,
    changes: [],
    nextSeq: 1,
    policies: {},
    writeCounts: {},
    faults: { ...DEFAULT_FAULTS },
  }
}
