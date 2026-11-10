/**
 * Seed identities and configuration. The webhook keys and secret values are development
 * fixtures, committed on purpose: the load script and the demo sign with them, and a
 * reader can check that a value like NPM_TOKEN really is masked in the logs.
 * @module db/seed-data
 */

export const ORGS = [
  { id: 'org_acme', name: 'Acme' },
  { id: 'org_globex', name: 'Globex' },
  { id: 'org_platform', name: 'Platform team' },
]

export const USERS = [
  { id: 'usr_alice', org: 'org_acme', username: 'alice', displayName: 'Alice Chen', isAdmin: false },
  { id: 'usr_carol', org: 'org_acme', username: 'carol', displayName: 'Carol Davis', isAdmin: false },
  { id: 'usr_bob', org: 'org_globex', username: 'bob', displayName: 'Bob Martin', isAdmin: false },
  { id: 'usr_admin', org: 'org_platform', username: 'admin', displayName: 'Platform Admin', isAdmin: true },
]

export const REPOS = [
  { id: 'repo_webapp', org: 'org_acme', fullName: 'acme/web-app', limit: 3, webhookSecret: 'whsec_dev_acme_web_app' },
  { id: 'repo_payments', org: 'org_acme', fullName: 'acme/payments-api', limit: 2, webhookSecret: 'whsec_dev_acme_payments' },
  { id: 'repo_portal', org: 'org_globex', fullName: 'globex/portal', limit: 2, webhookSecret: 'whsec_dev_globex_portal' },
]

export const MEMBERS = [
  { repo: 'repo_webapp', user: 'usr_alice', role: 'maintainer' },
  { repo: 'repo_payments', user: 'usr_alice', role: 'maintainer' },
  { repo: 'repo_webapp', user: 'usr_carol', role: 'read' },
  { repo: 'repo_payments', user: 'usr_carol', role: 'read' },
  { repo: 'repo_portal', user: 'usr_bob', role: 'maintainer' },
]

export const ENVIRONMENTS = [
  { id: 'env_web_prod', repo: 'repo_webapp', name: 'production', requiredApproval: true, allowedBranches: ['main'] },
  { id: 'env_web_staging', repo: 'repo_webapp', name: 'staging', requiredApproval: false, allowedBranches: [] },
  { id: 'env_pay_prod', repo: 'repo_payments', name: 'production', requiredApproval: true, allowedBranches: ['main'] },
  { id: 'env_portal_prod', repo: 'repo_portal', name: 'production', requiredApproval: true, allowedBranches: ['main'] },
]

export const SECRET_VALUES = {
  NPM_TOKEN: 'npm_tok_3f9a7c21e8d4b6a05c17',
  DEPLOY_TOKEN: 'prod_deploy_9d2e41c7aa6f83b5e0d2',
  STAGING_KEY: 'staging_key_51bc07e2f4a98d36',
  PAYMENTS_DEPLOY_TOKEN: 'pay_deploy_77ad10fe52c4e9b168aa',
  PORTAL_DEPLOY_TOKEN: 'portal_deploy_c08f33d16ea2b7745d90',
}

export const SECRETS = [
  { repo: 'repo_webapp', environment: null, name: 'NPM_TOKEN', value: SECRET_VALUES.NPM_TOKEN, by: 'alice' },
  { repo: 'repo_webapp', environment: 'production', name: 'DEPLOY_TOKEN', value: SECRET_VALUES.DEPLOY_TOKEN, by: 'alice' },
  { repo: 'repo_webapp', environment: 'staging', name: 'STAGING_KEY', value: SECRET_VALUES.STAGING_KEY, by: 'alice' },
  { repo: 'repo_payments', environment: null, name: 'NPM_TOKEN', value: SECRET_VALUES.NPM_TOKEN, by: 'alice' },
  { repo: 'repo_payments', environment: 'production', name: 'DEPLOY_TOKEN', value: SECRET_VALUES.PAYMENTS_DEPLOY_TOKEN, by: 'alice' },
  { repo: 'repo_portal', environment: null, name: 'NPM_TOKEN', value: SECRET_VALUES.NPM_TOKEN, by: 'bob' },
  { repo: 'repo_portal', environment: 'production', name: 'DEPLOY_TOKEN', value: SECRET_VALUES.PORTAL_DEPLOY_TOKEN, by: 'bob' },
]
