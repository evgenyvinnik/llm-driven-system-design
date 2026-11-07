/**
 * Seed fixtures shared by the seed script and the load generator: tiers, orgs
 * and the local-only API key secrets (documented in the README).
 * @module db/fixtures
 */

export const TIERS = [
  { name: 'free', tpm: 6_000, rpm: 20, qi: 4, qb: 10, weight: 1 },
  { name: 'build', tpm: 40_000, rpm: 120, qi: 12, qb: 40, weight: 2 },
  { name: 'scale', tpm: 200_000, rpm: 600, qi: 24, qb: 150, weight: 4 },
]

export const ORGS = [
  { slug: 'acme', name: 'Acme Robotics', tier: 'scale' },
  { slug: 'globex', name: 'Globex Labs', tier: 'build' },
  { slug: 'initech', name: 'Initech', tier: 'free' },
  { slug: 'umbrella', name: 'Umbrella Data', tier: 'scale' },
]

/** Local-only secrets, so curl, the load generator and the e2e checks can call the API. */
export const KEYS = [
  { org: 'acme', name: 'production', secret: 'sk-inf-local-acme-production' },
  { org: 'acme', name: 'staging', secret: 'sk-inf-local-acme-staging' },
  { org: 'globex', name: 'default', secret: 'sk-inf-local-globex-default' },
  { org: 'initech', name: 'hack-day', secret: 'sk-inf-local-initech-hackday' },
  { org: 'umbrella', name: 'bulk-ingest', secret: 'sk-inf-local-umbrella-bulk' },
]

