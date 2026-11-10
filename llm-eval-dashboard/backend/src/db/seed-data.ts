/**
 * Seed fixtures: workspaces, users, datasets (with versions), prompts,
 * model configs, scorers and the runs the seed materializes.
 *
 * References are written by hand. `seed-data.test.ts` checks them against the
 * mock's oracles, so the only "wrong" references are the two deliberate
 * mislabels in support-triage v1 that v2 corrects.
 * @module db/seed-data
 */
import { statusReference } from '../model/skills/explain.js'

export const WORKSPACES = [
  { id: 'ws_acme', name: 'Acme AI' },
  { id: 'ws_globex', name: 'Globex Labs' },
]

export const USERS = [
  { id: 'usr_alice', username: 'alice', displayName: 'Alice Moreau', workspaceId: 'ws_acme' },
  { id: 'usr_carol', username: 'carol', displayName: 'Carol Diaz', workspaceId: 'ws_acme' },
  { id: 'usr_bob', username: 'bob', displayName: 'Bob Okafor', workspaceId: 'ws_globex' },
]

export interface SeedCase {
  caseKey: string
  input: Record<string, string>
  reference: string
  tags: string[]
}

const t = (n: number, ticket: string, reference: string, ...tags: string[]): SeedCase => ({
  caseKey: `t-${String(n).padStart(3, '0')}`,
  input: { ticket },
  reference,
  tags: [...tags, reference],
})

const LONG_LOG = [
  'The nightly export job fails. Full log below:',
  ...Array.from({ length: 60 }, (_, i) => `2026-11-0${(i % 6) + 1}T02:${String(i % 60).padStart(2, '0')}:13Z worker-${i % 4} export batch ${1000 + i} retry=${i % 3} status=error code=E_EXPORT_TIMEOUT rows=${(i * 7919) % 50000}`),
].join('\n')

/** support-triage v1: 20 tickets. t-010 and t-017 are mislabeled (fixed in v2). */
export const TRIAGE_V1: SeedCase[] = [
  t(1, 'I was charged twice for my subscription this month.', 'billing', 'easy'),
  t(2, 'The app crashes every time I open the settings page.', 'technical', 'easy'),
  t(3, 'My package was marked as delivered but nothing arrived.', 'shipping', 'easy'),
  t(4, 'I forgot my password and the reset link never comes.', 'account', 'easy'),
  t(5, 'Can I get a refund for the annual plan I bought yesterday?', 'billing', 'easy'),
  t(6, 'The dashboard is very slow and sometimes shows a blank screen.', 'technical', 'easy'),
  t(7, 'Tracking says my parcel is stuck at the courier depot.', 'shipping', 'easy'),
  t(8, 'How do I change the username on my profile?', 'account', 'easy'),
  t(9, 'I was charged after the app crashed during checkout.', 'billing', 'hard'),
  { ...t(10, "I can't log in since the last update, it shows an error.", 'technical', 'hard'), tags: ['hard', 'account'] },
  t(11, 'My invoice shows the wrong price for the business tier.', 'billing', 'easy'),
  t(12, 'The package came damaged and I want a refund.', 'billing', 'hard'),
  t(13, 'Sync between my phone and laptop stopped working.', 'technical', 'easy'),
  t(14, 'Please delete my account and all my data.', 'account', 'easy'),
  t(15, 'Do you ship to Canada and how long does delivery take?', 'shipping', 'easy'),
  t(16, 'I love the new design, great job team!', 'other', 'easy'),
  { ...t(17, "Where can I find your company's office address for a visit?", 'account', 'easy'), tags: ['easy', 'other'] },
  t(18, 'The API returns a timeout error when I upload large files.', 'technical', 'easy'),
  t(19, "I enabled two-factor and now I'm locked out of my account.", 'account', 'easy'),
  t(20, 'My card was billed but the order was never shipped.', 'billing', 'hard'),
]

/** support-triage v2: fixes t-010 and t-017, drops t-016 (not a ticket), adds four cases. */
export const TRIAGE_V2: SeedCase[] = [
  ...TRIAGE_V1.filter((c) => c.caseKey !== 't-016').map((c) => {
    if (c.caseKey === 't-010') return t(10, "I can't log in since the last update, it shows an error.", 'account', 'hard')
    if (c.caseKey === 't-017') return t(17, "Where can I find your company's office address for a visit?", 'other', 'easy')
    return c
  }),
  t(21, 'Your courier left my parcel in the rain, and the tracking page has a bug.', 'shipping', 'hard'),
  t(22, 'Is there a student discount?', 'other', 'easy'),
  t(23, LONG_LOG, 'technical', 'hard', 'long-context'),
  t(24, 'I changed my email address and now the receipt goes to the old one.', 'billing', 'hard'),
]

const o = (n: number, email: string, ref: { product: string; quantity: number; city: string; priority: string }, ...tags: string[]): SeedCase => ({
  caseKey: `o-${String(n).padStart(3, '0')}`,
  input: { email },
  reference: JSON.stringify(ref),
  tags,
})

export const ORDERS_V1: SeedCase[] = [
  o(1, 'Hi team, please send 3 ceramic mugs to Berlin.', { product: 'ceramic mug', quantity: 3, city: 'Berlin', priority: 'normal' }, 'digits'),
  o(2, 'Could you ship a dozen notebooks to Lisbon? It is urgent.', { product: 'notebook', quantity: 12, city: 'Lisbon', priority: 'high' }, 'number-words'),
  o(3, 'We need two standing desks delivered to Austin asap.', { product: 'standing desk', quantity: 2, city: 'Austin', priority: 'high' }, 'number-words'),
  o(4, 'Order: 25 blue pens shipped to Toronto, whenever convenient.', { product: 'pen', quantity: 25, city: 'Toronto', priority: 'normal' }, 'digits'),
  o(5, 'Please arrange a pair of headphones sent to Madrid today.', { product: 'headphone', quantity: 2, city: 'Madrid', priority: 'high' }, 'number-words', 'today'),
  o(6, 'Hello, I would like 40 paper cups delivered to Oslo.', { product: 'paper cup', quantity: 40, city: 'Oslo', priority: 'normal' }, 'digits'),
  o(7, 'Send half a dozen walnut chairs to Kyoto when you can.', { product: 'chair', quantity: 6, city: 'Kyoto', priority: 'normal' }, 'number-words'),
  o(8, 'Could we get 8 monitor arms shipped to Denver urgently?', { product: 'monitor arm', quantity: 8, city: 'Denver', priority: 'high' }, 'digits'),
  o(9, 'Please send five whiteboards to Dublin before Friday.', { product: 'whiteboard', quantity: 5, city: 'Dublin', priority: 'normal' }, 'number-words'),
  o(10, 'We want 120 stickers sent to Seoul for the conference today.', { product: 'sticker', quantity: 120, city: 'Seoul', priority: 'high' }, 'digits', 'today'),
  o(11, 'Ship ten laptop stands to Nairobi please.', { product: 'laptop stand', quantity: 10, city: 'Nairobi', priority: 'normal' }, 'number-words'),
  o(12, 'Need 2 green lamps delivered to Porto, asap please.', { product: 'lamp', quantity: 2, city: 'Porto', priority: 'high' }, 'digits'),
]

const CODES = [200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504]
const CONFUSABLE = new Set([301, 302, 400, 401, 403, 404, 422, 500, 502, 503, 504])
export const STATUS_V1: SeedCase[] = CODES.map((code, i) => ({
  caseKey: `h-${String(i + 1).padStart(3, '0')}`,
  input: { code: String(code) },
  reference: statusReference(code),
  tags: [CONFUSABLE.has(code) ? 'confusable' : 'distinct', `${String(code)[0]}xx`],
}))

/** Globex's own small dataset, to show workspace isolation. */
export const ROUTING_V1: SeedCase[] = TRIAGE_V2.filter((c) => ['t-001', 't-002', 't-003', 't-004', 't-007', 't-013', 't-019', 't-021'].includes(c.caseKey)).map((c, i) => ({
  ...c,
  caseKey: `r-${String(i + 1).padStart(3, '0')}`,
}))

export const DATASETS = [
  {
    id: 'ds_triage',
    workspaceId: 'ws_acme',
    name: 'support-triage',
    description: 'Customer support tickets labeled with one of five queues. Hard cases mention two categories.',
    versions: [
      { id: 'dsv_triage_1', version: 1, message: 'Initial 20 tickets', cases: TRIAGE_V1, by: 'usr_alice', daysAgo: 6 },
      { id: 'dsv_triage_2', version: 2, message: 'Fix t-010 and t-017 labels, drop t-016, add 4 hard cases incl. a long log', cases: TRIAGE_V2, by: 'usr_carol', daysAgo: 4 },
    ],
  },
  {
    id: 'ds_orders',
    workspaceId: 'ws_acme',
    name: 'order-extraction',
    description: 'Order emails with the expected JSON (product, quantity, city, priority).',
    versions: [{ id: 'dsv_orders_1', version: 1, message: '12 order emails', cases: ORDERS_V1, by: 'usr_alice', daysAgo: 5 }],
  },
  {
    id: 'ds_status',
    workspaceId: 'ws_acme',
    name: 'http-status-qa',
    description: 'Explain an HTTP status code. Graded by the model judge against a one-line reference.',
    versions: [{ id: 'dsv_status_1', version: 1, message: '17 status codes', cases: STATUS_V1, by: 'usr_carol', daysAgo: 5 }],
  },
  {
    id: 'ds_routing',
    workspaceId: 'ws_globex',
    name: 'ticket-routing',
    description: "Globex's routing set (8 tickets).",
    versions: [{ id: 'dsv_routing_1', version: 1, message: 'Initial set', cases: ROUTING_V1, by: 'usr_bob', daysAgo: 3 }],
  },
]

const TRIAGE_V2_TEMPLATE = `Classify the support ticket into one category.
Categories: billing, account, shipping, technical, other
If a ticket mentions money (a charge, refund, invoice or card), choose billing. Otherwise the priority order is account, then shipping, then technical.
Respond with only the category name.

Ticket: {{ticket}}`

const TRIAGE_V3_TEMPLATE = `Classify the support ticket into one category.
Categories: billing, account, shipping, technical, other
If a ticket mentions money (a charge, refund, invoice or card), choose billing. Otherwise the priority order is account, then shipping, then technical.
Respond with only the category name.

Example: "I was double charged this month" -> billing
Example: "The page shows an error after the update" -> technical
Example: "My parcel never showed up" -> shipping
Example: "Please refund my last invoice" -> billing
Example: "Thanks for the quick fix!" -> other

Ticket: {{ticket}}`

export const PROMPTS = [
  {
    id: 'pr_triage',
    workspaceId: 'ws_acme',
    name: 'Ticket triage',
    description: 'Routes a support ticket to a queue.',
    versions: [
      { id: 'pv_triage_1', version: 1, system: 'You are a helpful support assistant.', template: 'Classify this support ticket.\n\nTicket: {{ticket}}', message: 'First draft', by: 'usr_alice', daysAgo: 6 },
      { id: 'pv_triage_2', version: 2, system: 'You are a support triage assistant.', template: TRIAGE_V2_TEMPLATE, message: 'List categories, add a tie-break rule, ask for the bare label', by: 'usr_alice', daysAgo: 5 },
      { id: 'pv_triage_3', version: 3, system: 'You are a support triage assistant.', template: TRIAGE_V3_TEMPLATE, message: 'Add five few-shot examples', by: 'usr_carol', daysAgo: 3 },
    ],
  },
  {
    id: 'pr_orders',
    workspaceId: 'ws_acme',
    name: 'Order extractor',
    description: 'Turns an order email into JSON.',
    versions: [
      { id: 'pv_orders_1', version: 1, system: 'You extract structured data from order emails.', template: 'Extract the order as JSON with the fields product, quantity, city and priority.\n\nEmail: {{email}}', message: 'First draft', by: 'usr_alice', daysAgo: 5 },
      {
        id: 'pv_orders_2',
        version: 2,
        system: 'You extract structured data from order emails.',
        template:
          'Extract the order as JSON with the fields product, quantity, city and priority.\nWrite quantities as digits: convert number words such as "a dozen" to 12.\nPriority is "high" when the email says urgent, asap or today, otherwise "normal".\nReturn only the JSON object, no markdown.\n\nEmail: {{email}}',
        message: 'Digits rule, priority rule, bare JSON',
        by: 'usr_alice',
        daysAgo: 4,
      },
    ],
  },
  {
    id: 'pr_status',
    workspaceId: 'ws_acme',
    name: 'Status explainer',
    description: 'Explains an HTTP status code to a developer.',
    versions: [
      { id: 'pv_status_1', version: 1, system: 'You are a senior web developer.', template: 'Explain HTTP status code {{code}}.', message: 'First draft', by: 'usr_carol', daysAgo: 5 },
      { id: 'pv_status_2', version: 2, system: 'You are a senior web developer.', template: 'In one sentence, give the official name of HTTP status code {{code}} and when a server returns it.', message: 'One sentence, official name', by: 'usr_carol', daysAgo: 4 },
    ],
  },
  {
    id: 'pr_router',
    workspaceId: 'ws_globex',
    name: 'Router',
    description: "Globex's ticket router.",
    versions: [{ id: 'pv_router_1', version: 1, system: 'You are a support triage assistant.', template: TRIAGE_V2_TEMPLATE, message: 'Copied from a blog post', by: 'usr_bob', daysAgo: 3 }],
  },
]

export const MODEL_CONFIGS = [
  { id: 'mc_small_t07', workspaceId: 'ws_acme', name: 'small · t0.7', model: 'mock-small', temperature: 0.7, maxTokens: 160, seed: 29 },
  { id: 'mc_small_t0', workspaceId: 'ws_acme', name: 'small · t0', model: 'mock-small', temperature: 0, maxTokens: 160, seed: 29 },
  { id: 'mc_large_t07', workspaceId: 'ws_acme', name: 'large · t0.7', model: 'mock-large', temperature: 0.7, maxTokens: 160, seed: 29 },
  { id: 'mc_tiny', workspaceId: 'ws_acme', name: 'tiny · t0.7 (64-token window)', model: 'mock-tiny', temperature: 0.7, maxTokens: 64, seed: 29 },
  { id: 'mc_globex_small', workspaceId: 'ws_globex', name: 'small · t0.7', model: 'mock-small', temperature: 0.7, maxTokens: 160, seed: 3 },
]

export const SCORERS = [
  {
    id: 'sc_exact',
    workspaceId: 'ws_acme',
    name: 'Exact label',
    kind: 'exact_match' as const,
    description: 'The output is exactly the reference label.',
    versions: [
      { id: 'scv_exact_1', version: 1, config: { caseSensitive: true, trim: true }, message: 'Case-sensitive' },
      { id: 'scv_exact_2', version: 2, config: { caseSensitive: false, trim: true }, message: 'Ignore case' },
    ],
  },
  {
    id: 'sc_regex',
    workspaceId: 'ws_acme',
    name: 'Label regex',
    kind: 'regex' as const,
    description: 'The label appears as the whole answer or after "Category:".',
    versions: [
      { id: 'scv_regex_1', version: 1, config: { pattern: '^{{reference}}$', flags: '' }, message: 'Whole output only' },
      { id: 'scv_regex_2', version: 2, config: { pattern: '(?:^|category:\\s*){{reference}}\\b', flags: 'im' }, message: 'Fix: accept "Category: X" and any case' },
    ],
  },
  {
    id: 'sc_contains',
    workspaceId: 'ws_acme',
    name: 'Label contains',
    kind: 'contains' as const,
    description: 'The reference label appears anywhere in the output (case-insensitive).',
    versions: [{ id: 'scv_contains_1', version: 1, config: { caseSensitive: false }, message: 'Case-insensitive' }],
  },
  {
    id: 'sc_json',
    workspaceId: 'ws_acme',
    name: 'Order JSON shape',
    kind: 'json_shape' as const,
    description: 'Fraction of the four fields present with the reference value.',
    versions: [
      { id: 'scv_json_1', version: 1, config: { requiredKeys: ['product', 'quantity', 'city', 'priority'], compareValues: true, stripFences: false }, message: 'Strict JSON.parse' },
      { id: 'scv_json_2', version: 2, config: { requiredKeys: ['product', 'quantity', 'city', 'priority'], compareValues: true, stripFences: true }, message: 'Fix: strip ```json fences and leading prose' },
    ],
  },
  {
    id: 'sc_judge',
    workspaceId: 'ws_acme',
    name: 'Answer quality (judge)',
    kind: 'model_graded' as const,
    description: 'The mock judge grades the answer 1-5 against the reference.',
    versions: [
      { id: 'scv_judge_1', version: 1, config: { rubric: "The answer must give the status code's official name and what it means. Ignore style and length.", strictness: 'lenient', passGrade: 4 }, message: 'Lenient rubric' },
      { id: 'scv_judge_2', version: 2, config: { rubric: 'The answer must give the official name and meaning in one sentence. Penalize padding and generic advice.', strictness: 'strict', passGrade: 4 }, message: 'Tighten: penalize padding' },
    ],
  },
  {
    id: 'sc_human',
    workspaceId: 'ws_acme',
    name: 'Human review',
    kind: 'human' as const,
    description: 'Pass if a reviewer agrees the answer is correct and usable.',
    versions: [{ id: 'scv_human_1', version: 1, config: { instructions: 'Pass when the answer names the right status and explains it correctly; style does not matter.' }, message: 'Initial guidelines' }],
  },
  {
    id: 'sc_globex_exact',
    workspaceId: 'ws_globex',
    name: 'Exact label',
    kind: 'exact_match' as const,
    description: 'Exact label match.',
    versions: [{ id: 'scv_globex_exact_1', version: 1, config: { caseSensitive: false, trim: true }, message: 'Ignore case' }],
  },
]

export interface SeedRun {
  id: string
  workspaceId: string
  name: string
  datasetVersionId: string
  promptVersionId: string
  modelConfigId: string
  samples: number
  scorers: string[]
  /** Scorer versions added after completion (re-scoring), with how long after. */
  rescore?: string[]
  by: string
  hoursAgo: number
  /** Simulate a transient failure rate (429/overload/disconnect) that was retried. */
  transientRate?: number
  /** Stop after this fraction of tasks: the run is cancelled. */
  cancelAfter?: number
}

export const SEED_RUNS: SeedRun[] = [
  { id: 'run_triage_v1', workspaceId: 'ws_acme', name: 'Triage v1 baseline', datasetVersionId: 'dsv_triage_2', promptVersionId: 'pv_triage_1', modelConfigId: 'mc_small_t07', samples: 5, scorers: ['scv_exact_1', 'scv_contains_1', 'scv_regex_1'], rescore: ['scv_regex_2'], by: 'usr_alice', hoursAgo: 70, transientRate: 0.06 },
  { id: 'run_triage_v2', workspaceId: 'ws_acme', name: 'Triage v2: categories + tie rule', datasetVersionId: 'dsv_triage_2', promptVersionId: 'pv_triage_2', modelConfigId: 'mc_small_t07', samples: 5, scorers: ['scv_exact_1', 'scv_contains_1', 'scv_regex_1'], by: 'usr_alice', hoursAgo: 66, transientRate: 0.04 },
  { id: 'run_triage_v3', workspaceId: 'ws_acme', name: 'Triage v3: few-shot examples', datasetVersionId: 'dsv_triage_2', promptVersionId: 'pv_triage_3', modelConfigId: 'mc_small_t07', samples: 5, scorers: ['scv_exact_1', 'scv_contains_1', 'scv_regex_2'], by: 'usr_carol', hoursAgo: 48, transientRate: 0.05 },
  { id: 'run_triage_v3_large', workspaceId: 'ws_acme', name: 'Triage v3 on large', datasetVersionId: 'dsv_triage_2', promptVersionId: 'pv_triage_3', modelConfigId: 'mc_large_t07', samples: 5, scorers: ['scv_exact_1', 'scv_contains_1'], by: 'usr_carol', hoursAgo: 44 },
  { id: 'run_triage_v2_ds1', workspaceId: 'ws_acme', name: 'Triage v2 on dataset v1', datasetVersionId: 'dsv_triage_1', promptVersionId: 'pv_triage_2', modelConfigId: 'mc_small_t07', samples: 5, scorers: ['scv_exact_1', 'scv_contains_1'], by: 'usr_alice', hoursAgo: 90 },
  { id: 'run_triage_v2_x1', workspaceId: 'ws_acme', name: 'Triage v2, 1 sample', datasetVersionId: 'dsv_triage_2', promptVersionId: 'pv_triage_2', modelConfigId: 'mc_small_t07', samples: 1, scorers: ['scv_exact_1', 'scv_contains_1'], by: 'usr_alice', hoursAgo: 65 },
  { id: 'run_triage_v2_x10', workspaceId: 'ws_acme', name: 'Triage v2, 10 samples', datasetVersionId: 'dsv_triage_2', promptVersionId: 'pv_triage_2', modelConfigId: 'mc_small_t07', samples: 10, scorers: ['scv_exact_1', 'scv_contains_1'], by: 'usr_alice', hoursAgo: 64 },
  { id: 'run_triage_v2_t0', workspaceId: 'ws_acme', name: 'Triage v2 at temperature 0', datasetVersionId: 'dsv_triage_2', promptVersionId: 'pv_triage_2', modelConfigId: 'mc_small_t0', samples: 3, scorers: ['scv_exact_1', 'scv_contains_1'], by: 'usr_carol', hoursAgo: 40 },
  { id: 'run_triage_tiny', workspaceId: 'ws_acme', name: 'Triage v2 on tiny model', datasetVersionId: 'dsv_triage_2', promptVersionId: 'pv_triage_2', modelConfigId: 'mc_tiny', samples: 1, scorers: ['scv_exact_1'], by: 'usr_carol', hoursAgo: 38 },
  { id: 'run_triage_cancelled', workspaceId: 'ws_acme', name: 'Triage v3 (cancelled)', datasetVersionId: 'dsv_triage_2', promptVersionId: 'pv_triage_3', modelConfigId: 'mc_large_t07', samples: 5, scorers: ['scv_exact_1'], by: 'usr_alice', hoursAgo: 30, cancelAfter: 0.4 },
  { id: 'run_orders_v1', workspaceId: 'ws_acme', name: 'Orders v1', datasetVersionId: 'dsv_orders_1', promptVersionId: 'pv_orders_1', modelConfigId: 'mc_small_t07', samples: 3, scorers: ['scv_json_1'], rescore: ['scv_json_2'], by: 'usr_alice', hoursAgo: 60 },
  { id: 'run_orders_v2', workspaceId: 'ws_acme', name: 'Orders v2: digits + bare JSON', datasetVersionId: 'dsv_orders_1', promptVersionId: 'pv_orders_2', modelConfigId: 'mc_small_t07', samples: 3, scorers: ['scv_json_1', 'scv_json_2'], by: 'usr_alice', hoursAgo: 58 },
  { id: 'run_status_v1', workspaceId: 'ws_acme', name: 'Status v1 (judge + human)', datasetVersionId: 'dsv_status_1', promptVersionId: 'pv_status_1', modelConfigId: 'mc_small_t07', samples: 3, scorers: ['scv_judge_1', 'scv_human_1'], rescore: ['scv_judge_2'], by: 'usr_carol', hoursAgo: 52 },
  { id: 'run_status_v2', workspaceId: 'ws_acme', name: 'Status v2: one sentence', datasetVersionId: 'dsv_status_1', promptVersionId: 'pv_status_2', modelConfigId: 'mc_small_t07', samples: 3, scorers: ['scv_judge_1', 'scv_judge_2'], by: 'usr_carol', hoursAgo: 50 },
  { id: 'run_routing_v1', workspaceId: 'ws_globex', name: 'Router v1', datasetVersionId: 'dsv_routing_1', promptVersionId: 'pv_router_1', modelConfigId: 'mc_globex_small', samples: 3, scorers: ['scv_globex_exact_1'], by: 'usr_bob', hoursAgo: 20 },
]
