/**
 * Fixed local identities shared by the seed and the demo scripts. Production
 * API keys are random and shown once; these are deliberately public.
 */
export const SEED_API_KEYS = {
  org_acme: 'whk_test_acme_local_0000000000000000',
  org_globex: 'whk_test_globex_local_000000000000000',
} as const

export const SEED_ENDPOINTS = [
  { id: 'ep_acme_orders', org: 'org_acme', path: 'acme-orders', description: 'Orders service', types: ['order.*'], concurrency: 4, secret: 'whsec_acme_orders_local_secret_v1' },
  { id: 'ep_acme_billing', org: 'org_acme', path: 'acme-billing', description: 'Billing (invoices)', types: ['invoice.paid', 'invoice.failed'], concurrency: 4, secret: 'whsec_acme_billing_local_secret_v1' },
  { id: 'ep_acme_audit', org: 'org_acme', path: 'acme-audit', description: 'Audit log (everything)', types: ['*'], concurrency: 2, secret: 'whsec_acme_audit_local_secret_v1' },
  { id: 'ep_globex_main', org: 'org_globex', path: 'globex-main', description: 'Main integration', types: ['*'], concurrency: 4, secret: 'whsec_globex_main_local_secret_v1' },
  { id: 'ep_globex_crm', org: 'org_globex', path: 'globex-crm', description: 'Legacy CRM sync', types: ['customer.updated'], concurrency: 2, secret: 'whsec_globex_crm_local_secret_v1' },
] as const
