// The seeded account: Ahmad at Northwind Labs, a small team three weeks into building on the API.
//
// The story the data tells:
// - Build plan (prepaid credits), Tier 1. $25 purchased in three top-ups since the first one 41 days ago.
// - Spend has nearly tripled in three weeks ($3.85 → $6.30 → $10.15 a week), so the $3.84 balance
//   lasts about 2.8 days at the last 7 complete days' rate ($1.37/day). Auto-reload is off.
// - Traffic now bursts past Tier 1's 50 requests/minute: 412 requests were rate-limited (429) in
//   the last 7 days, up from 31 the week before.
// - Three API keys, one of them unused for a month. Two members.
//
// Dates are relative to "now", so the account always looks current.
import { MODELS, costCents } from './lib/catalog.js';

const DAY_MS = 86_400_000;

// Total spend per day in cents, oldest first; the last entry is today.
const DAILY_SPEND_CENTS = [
  48, 61, 55, 52, 63, 50, 56, // 20–14 days ago: $3.85
  78, 92, 85, 96, 88, 99, 92, // 13–7 days ago:  $6.30
  128, 141, 152, 139, 160, 148, 147, // last 7 days: $10.15
];

// Requests rejected with 429 per day, same order.
const DAILY_RATE_LIMITED = [
  0, 0, 0, 0, 0, 0, 0,
  0, 0, 4, 0, 9, 12, 6,
  38, 61, 85, 47, 112, 42, 27,
];

const MODEL_MIX = { 'nova-medium': 0.7, 'nova-small': 0.18, 'nova-large': 0.12 };
const AVG_INPUT_TOKENS_PER_REQUEST = { 'nova-medium': 260, 'nova-small': 180, 'nova-large': 650 };
const INPUT_TO_OUTPUT_RATIO = 5;

export function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

// A timestamp `days` before now at the given UTC hour, never later than now.
function daysAgo(now, days, hour = 15) {
  const date = new Date(now.getTime() - days * DAY_MS);
  date.setUTCHours(hour, 0, 0, 0);
  return date > now ? new Date(now.getTime() - 60_000) : date;
}

function buildUsage(now) {
  const records = [];
  const lastIndex = DAILY_SPEND_CENTS.length - 1;
  DAILY_SPEND_CENTS.forEach((dayCents, index) => {
    const date = isoDate(daysAgo(now, lastIndex - index));
    for (const model of MODELS) {
      const targetCents = dayCents * MODEL_MIX[model.id];
      const centsPerOutputToken = (INPUT_TO_OUTPUT_RATIO * model.inputPerMTokCents + model.outputPerMTokCents) / 1_000_000;
      const outputTokens = Math.round(targetCents / centsPerOutputToken);
      const inputTokens = outputTokens * INPUT_TO_OUTPUT_RATIO;
      const requests = Math.max(1, Math.round(inputTokens / AVG_INPUT_TOKENS_PER_REQUEST[model.id]));
      records.push({
        date,
        model: model.id,
        requests,
        inputTokens,
        outputTokens,
        costCents: costCents(model, inputTokens, outputTokens),
        // 429s land on the busiest model; the others stay under their limits.
        rateLimited: model.id === 'nova-medium' ? DAILY_RATE_LIMITED[index] : 0,
        errors: Math.round(requests * 0.002),
      });
    }
  });
  return records;
}

export function buildSeed(now = new Date()) {
  const firstPurchaseAt = daysAgo(now, 41, 10);
  return {
    currentUserId: 'user_ahmad',
    org: {
      id: 'org_northwind',
      name: 'Northwind Labs',
      plan: 'build',
      billingEmail: 'billing@northwindlabs.dev',
      createdAt: daysAgo(now, 44, 9).toISOString(),
    },
    users: [
      {
        id: 'user_ahmad',
        name: 'Ahmad Karimi',
        email: 'ahmad@northwindlabs.dev',
        role: 'admin',
        joinedAt: daysAgo(now, 44, 9).toISOString(),
      },
      {
        id: 'user_jordan',
        name: 'Jordan Lee',
        email: 'jordan@northwindlabs.dev',
        role: 'developer',
        joinedAt: daysAgo(now, 23, 16).toISOString(),
      },
    ],
    invites: [],
    keys: [
      {
        id: 'key_prod',
        name: 'prod-backend',
        hint: 'sk-nw-…Fq3a',
        status: 'active',
        createdBy: 'user_ahmad',
        createdAt: daysAgo(now, 33, 11).toISOString(),
        lastUsedAt: daysAgo(now, 0, 9).toISOString(),
      },
      {
        id: 'key_staging',
        name: 'staging',
        hint: 'sk-nw-…k81Z',
        status: 'active',
        createdBy: 'user_jordan',
        createdAt: daysAgo(now, 21, 14).toISOString(),
        lastUsedAt: daysAgo(now, 1, 18).toISOString(),
      },
      {
        id: 'key_laptop',
        name: 'ahmad-laptop',
        hint: 'sk-nw-…02Pm',
        status: 'active',
        createdBy: 'user_ahmad',
        createdAt: daysAgo(now, 40, 12).toISOString(),
        lastUsedAt: daysAgo(now, 29, 20).toISOString(),
      },
    ],
    usage: buildUsage(now),
    billing: {
      balanceCents: 384,
      autoReload: { enabled: false, thresholdCents: 500, amountCents: 2_000 },
      paymentMethod: { brand: 'Visa', last4: '4242', expires: '08/28' },
      cumulativePurchasedCents: 2_500,
      firstPurchaseAt: firstPurchaseAt.toISOString(),
      transactions: [
        { id: 'txn_3', type: 'purchase', amountCents: 1_000, createdAt: daysAgo(now, 12, 17).toISOString(), status: 'paid' },
        { id: 'txn_2', type: 'purchase', amountCents: 1_000, createdAt: daysAgo(now, 26, 13).toISOString(), status: 'paid' },
        { id: 'txn_1', type: 'purchase', amountCents: 500, createdAt: firstPurchaseAt.toISOString(), status: 'paid' },
      ],
    },
  };
}
