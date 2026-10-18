// Static product catalog: models with their prices, and the usage tiers that set rate limits.
// Money is kept in cents. Per-request costs are fractions of a cent, so balances can carry
// four decimal places; roundCents() keeps float drift out of them.

export const MODELS = [
  {
    id: 'nova-large',
    name: 'Nova Large',
    description: 'Most capable, for complex reasoning and agents',
    inputPerMTokCents: 1500,
    outputPerMTokCents: 7500,
  },
  {
    id: 'nova-medium',
    name: 'Nova Medium',
    description: 'Balanced speed and intelligence',
    inputPerMTokCents: 300,
    outputPerMTokCents: 1500,
  },
  {
    id: 'nova-small',
    name: 'Nova Small',
    description: 'Fastest and cheapest, for high-volume tasks',
    inputPerMTokCents: 80,
    outputPerMTokCents: 400,
  },
];

// A tier is reached once the org's cumulative credit purchases meet the minimum and enough
// days have passed since its first purchase. Limits apply per model.
export const TIERS = [
  { tier: 0, name: 'Evaluation', minPurchasedCents: 0, waitDays: 0, monthlySpendLimitCents: 1_000, rpm: 5, itpm: 10_000, otpm: 2_000 },
  { tier: 1, name: 'Tier 1', minPurchasedCents: 500, waitDays: 0, monthlySpendLimitCents: 10_000, rpm: 50, itpm: 40_000, otpm: 8_000 },
  { tier: 2, name: 'Tier 2', minPurchasedCents: 4_000, waitDays: 7, monthlySpendLimitCents: 50_000, rpm: 1_000, itpm: 80_000, otpm: 16_000 },
  { tier: 3, name: 'Tier 3', minPurchasedCents: 20_000, waitDays: 7, monthlySpendLimitCents: 100_000, rpm: 2_000, itpm: 160_000, otpm: 32_000 },
  { tier: 4, name: 'Tier 4', minPurchasedCents: 40_000, waitDays: 14, monthlySpendLimitCents: 500_000, rpm: 4_000, itpm: 400_000, otpm: 80_000 },
];

export const PLANS = [
  {
    id: 'build',
    name: 'Build',
    summary: 'Prepaid credits. Pay as you go, limits grow with usage tiers.',
    features: ['Prepaid credits, no commitment', 'Usage tiers 1–4', 'Workbench and API keys', 'Email support'],
  },
  {
    id: 'scale',
    name: 'Scale',
    summary: 'Monthly invoicing with custom rate limits.',
    features: ['Invoiced monthly', 'Custom rate limits', 'SSO and audit logs', 'Dedicated support'],
  },
];

export function getModel(id) {
  return MODELS.find((model) => model.id === id) ?? null;
}

export function roundCents(value) {
  return Math.round(value * 10_000) / 10_000;
}

export function costCents(model, inputTokens, outputTokens) {
  return roundCents((inputTokens * model.inputPerMTokCents + outputTokens * model.outputPerMTokCents) / 1_000_000);
}
