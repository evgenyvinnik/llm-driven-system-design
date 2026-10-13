/**
 * Seeds demo users, prompts with version history, presets, and a few days of
 * run history (outputs come from the mock model's generator, so they match
 * what a live run would produce). Skips if users already exist; pass --reset
 * to wipe and reseed.
 *
 * Users (password `password123`): alice (admin), bob — both in "Acme AI";
 * carol — alone in "Solo Labs", to show workspace isolation.
 */
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type pg from 'pg'
import { findModel, type ModelConfig } from '../shared/catalog.js'
import { pool, withTransaction } from '../shared/db.js'
import { contentHash, extractVariables, renderTemplate, requestHash } from '../shared/template.js'
import { planGeneration } from '../model/generator.js'

export const DEMO_SHARE_TOKEN = 'demo-support-triage-share'

interface VersionSeed {
  system: string
  template: string
  message: string
  by: string
}

interface PromptSeed {
  title: string
  description: string
  owner: string
  versions: VersionSeed[]
  inputs: Record<string, string>[]
}

const PROMPTS: PromptSeed[] = [
  {
    title: 'Support ticket triage',
    description: 'Classifies inbound tickets by urgency and routes them to a team.',
    owner: 'alice',
    versions: [
      {
        system: 'You are a support triage assistant for {{product}}. Classify each ticket by urgency.',
        template: 'Ticket:\n\n{{ticket}}\n\nReturn the urgency and the team that should handle it.',
        message: 'Initial version',
        by: 'alice',
      },
      {
        system: 'You are a support triage assistant for {{product}}. Classify each ticket by urgency and route it.',
        template: 'Ticket from a {{customer_tier}} customer:\n\n{{ticket}}\n\nReturn the urgency and the team that should handle it.',
        message: 'Add customer tier',
        by: 'bob',
      },
      {
        system:
          'You are a support triage assistant for {{product}}. Classify each ticket by urgency and route it to the right team. Be concise.',
        template:
          'Ticket from a {{customer_tier}} customer:\n\n{{ticket}}\n\nReturn the urgency, the team, and a one-line summary.',
        message: 'Ask for a one-line summary',
        by: 'alice',
      },
    ],
    inputs: [
      {
        product: 'Acme Billing',
        customer_tier: 'enterprise',
        ticket: 'Our invoices for September show double charges for every seat. Finance is blocked on month-end close.',
      },
      {
        product: 'Acme Billing',
        customer_tier: 'free',
        ticket: 'How do I change the currency shown on my dashboard?',
      },
      {
        product: 'Acme Billing',
        customer_tier: 'pro',
        ticket: 'Webhook deliveries to our endpoint started failing with timeouts after yesterday’s update.',
      },
    ],
  },
  {
    title: 'Release notes writer',
    description: 'Turns merged pull request titles into customer-facing release notes.',
    owner: 'bob',
    versions: [
      {
        system: 'You write release notes for {{audience}}.',
        template: 'Write release notes for version {{version}} from these changes:\n{{changes}}',
        message: 'Initial version',
        by: 'bob',
      },
      {
        system: 'You write release notes for {{audience}}. Group changes into features, fixes, and breaking changes.',
        template: 'Write release notes for version {{version}} from these changes:\n{{changes}}\n\nKeep each item to one line.',
        message: 'Group by change type',
        by: 'bob',
      },
    ],
    inputs: [
      {
        audience: 'developers using the public API',
        version: '2.14.0',
        changes: '- Add cursor pagination to list endpoints\n- Fix rounding in usage reports\n- Remove deprecated v1 auth header',
      },
      {
        audience: 'admins of self-hosted installs',
        version: '2.13.2',
        changes: '- Patch session fixation on SSO login\n- Speed up backup restore',
      },
    ],
  },
  {
    title: 'SQL query explainer',
    description: 'Explains a SQL query step by step for analysts new to SQL.',
    owner: 'alice',
    versions: [
      {
        system: 'You explain SQL queries to analysts who are new to SQL. Avoid jargon.',
        template: 'Explain what this query does, step by step:\n\n{{query}}',
        message: 'Initial version',
        by: 'alice',
      },
    ],
    inputs: [
      {
        query:
          'SELECT region, count(DISTINCT customer_id) FROM orders WHERE created_at > now() - interval \'30 days\' GROUP BY region ORDER BY 2 DESC;',
      },
    ],
  },
  {
    title: 'Product description',
    description: 'Short e-commerce product descriptions from a feature list.',
    owner: 'bob',
    versions: [
      {
        system: 'You write concise, friendly e-commerce product descriptions.',
        template: 'Write a three-sentence description for {{product_name}}. Key features: {{features}}.',
        message: 'Initial version',
        by: 'bob',
      },
    ],
    inputs: [
      { product_name: 'Trailhead 40L backpack', features: 'waterproof zippers, ventilated back panel, laptop sleeve' },
      { product_name: 'Ember pour-over kettle', features: 'gooseneck spout, temperature hold, 1 litre' },
    ],
  },
  {
    title: 'Meeting summary',
    description: 'Summarizes meeting notes into decisions and action items.',
    owner: 'bob',
    versions: [
      {
        system: 'You summarize meeting notes for people who missed the meeting.',
        template: 'Summarize these notes into decisions, action items with owners, and open questions:\n\n{{notes}}',
        message: 'Initial version',
        by: 'bob',
      },
    ],
    inputs: [
      {
        notes:
          'Agreed to ship the pricing page redesign on the 20th. Dana owns the launch checklist. Still unclear whether annual discounts apply to existing customers.',
      },
    ],
  },
]

const PRESETS: { name: string; config: ModelConfig }[] = [
  { name: 'Deterministic', config: { model: 'sim-fast', temperature: 0, maxTokens: 256, topP: 1 } },
  { name: 'Creative drafts', config: { model: 'sim-quality', temperature: 1.1, maxTokens: 1024, topP: 0.95 } },
  { name: 'Error testing', config: { model: 'sim-flaky', temperature: 0.7, maxTokens: 512, topP: 1 } },
]

const CONFIGS: ModelConfig[] = [
  { model: 'sim-fast', temperature: 0.7, maxTokens: 512, topP: 1 },
  { model: 'sim-fast', temperature: 0, maxTokens: 256, topP: 1 },
  { model: 'sim-quality', temperature: 0.9, maxTokens: 1024, topP: 0.95 },
  { model: 'sim-flaky', temperature: 0.7, maxTokens: 512, topP: 1 },
]

let rngState = 42
function rand(): number {
  rngState = (rngState * 1664525 + 1013904223) % 4294967296
  return rngState / 4294967296
}
const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)]

async function insertSnapshot(client: pg.PoolClient, promptId: string, v: { system: string; template: string }, userId: string) {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO prompt_snapshots (prompt_id, content_hash, system_text, template_text, variables, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (prompt_id, content_hash) DO UPDATE SET prompt_id = EXCLUDED.prompt_id
     RETURNING id`,
    [promptId, contentHash(v.system, v.template), v.system, v.template, extractVariables(v.system, v.template), userId],
  )
  return rows[0].id
}

interface RunSeed {
  workspaceId: string
  promptId: string
  snapshotId: string
  version: number | null
  system: string
  template: string
  inputs: Record<string, string>
  config: ModelConfig
  userId: string
  createdAt: Date
  status: 'completed' | 'failed' | 'cancelled'
  comparisonId?: string
}

async function insertRun(client: pg.PoolClient, run: RunSeed) {
  const spec = findModel(run.config.model)!
  const system = renderTemplate(run.system, run.inputs).text
  const input = renderTemplate(run.template, run.inputs).text
  const plan = planGeneration({ ...run.config, system, input }, spec, randomUUID(), 0)
  let tokens = plan.tokens
  let finishReason: string | null = plan.finishReason
  let errorCode: string | null = null
  let errorMessage: string | null = null
  if (run.status === 'failed') {
    tokens = tokens.slice(0, Math.max(3, Math.floor(tokens.length * 0.4)))
    finishReason = null
    errorCode = 'MODEL_ERROR'
    errorMessage = 'Simulated failure partway through generation'
  } else if (run.status === 'cancelled') {
    tokens = tokens.slice(0, Math.max(3, Math.floor(tokens.length * 0.3)))
    finishReason = 'cancelled'
  }
  const queueMs = 15 + Math.floor(rand() * 180)
  const ttftMs = Math.round(spec.ttftMs * (0.8 + rand() * 0.6))
  const genMs = Math.round((tokens.length * 1000) / spec.tokensPerSecond)
  const started = new Date(run.createdAt.getTime() + queueMs)
  const firstToken = new Date(started.getTime() + ttftMs)
  const finished = new Date(firstToken.getTime() + genMs)
  const key = `seed-${randomUUID()}`
  await client.query(
    `INSERT INTO runs (workspace_id, prompt_id, snapshot_id, version, comparison_id, model, config, variables,
                       rendered_system, rendered_input, status, output, output_truncated, finish_reason, error_code,
                       error_message, input_tokens, output_tokens, attempt, created_by, idempotency_key, request_hash,
                       created_at, enqueued_at, started_at, first_token_at, finished_at, cancel_requested_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,1,$19,$20,$21,$22,$22,$23,$24,$25,$26)`,
    [
      run.workspaceId,
      run.promptId,
      run.snapshotId,
      run.version,
      run.comparisonId ?? null,
      run.config.model,
      JSON.stringify(run.config),
      JSON.stringify(run.inputs),
      system,
      input,
      run.status,
      tokens.join(''),
      run.status !== 'completed',
      finishReason,
      errorCode,
      errorMessage,
      Math.ceil((system.length + input.length) / 4),
      tokens.length,
      run.userId,
      key,
      requestHash(key),
      run.createdAt,
      started,
      firstToken,
      finished,
      run.status === 'cancelled' ? finished : null,
    ],
  )
}

async function seed(): Promise<void> {
  const reset = process.argv.includes('--reset')
  const existing = await pool.query('SELECT count(*)::int AS n FROM users')
  if (existing.rows[0].n > 0 && !reset) {
    console.log('Database already seeded (pass --reset to wipe and reseed)')
    return
  }

  await withTransaction(async (client) => {
    if (reset) {
      await client.query('TRUNCATE shares, runs, prompt_versions, prompt_snapshots, prompts, model_presets, workspace_members, workspaces, users CASCADE')
    }
    const hash = await bcrypt.hash('password123', 10)
    const users: Record<string, string> = {}
    for (const [username, name, role] of [
      ['alice', 'Alice Chen', 'admin'],
      ['bob', 'Bob Martinez', 'user'],
      ['carol', 'Carol Davis', 'user'],
    ]) {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
        [username, name, hash, role],
      )
      users[username] = rows[0].id
    }

    const acme = (await client.query<{ id: string }>("INSERT INTO workspaces (name) VALUES ('Acme AI') RETURNING id")).rows[0].id
    const solo = (await client.query<{ id: string }>("INSERT INTO workspaces (name) VALUES ('Solo Labs') RETURNING id")).rows[0].id
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($4, $5, 'owner')`,
      [acme, users.alice, users.bob, solo, users.carol],
    )

    for (const preset of PRESETS) {
      await client.query(
        'INSERT INTO model_presets (workspace_id, name, config, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)',
        [acme, preset.name, JSON.stringify(preset.config), users.alice],
      )
    }

    const now = Date.now()
    const hour = 3_600_000
    let triage: { promptId: string; snapshotId: string; version: number } | null = null

    for (const [index, p] of PROMPTS.entries()) {
      const created = new Date(now - (6 - index) * 24 * hour)
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO prompts (workspace_id, title, description, head_version, created_by, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          acme,
          p.title,
          p.description,
          p.versions.length,
          users[p.owner],
          users[p.versions[p.versions.length - 1].by],
          created,
          new Date(now - index * 5 * hour - 2 * hour),
        ],
      )
      const promptId = rows[0].id
      const snapshots: string[] = []
      for (const [vi, v] of p.versions.entries()) {
        const snapshotId = await insertSnapshot(client, promptId, v, users[v.by])
        snapshots.push(snapshotId)
        await client.query(
          `INSERT INTO prompt_versions (prompt_id, version, snapshot_id, message, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [promptId, vi + 1, snapshotId, v.message, users[v.by], new Date(created.getTime() + vi * 20 * hour)],
        )
      }

      // Run history: mostly the latest version, some earlier ones, spread over the last two days.
      const runCount = index === 0 ? 14 : 6
      for (let i = 0; i < runCount; i++) {
        const vi = rand() < 0.7 ? p.versions.length - 1 : Math.floor(rand() * p.versions.length)
        const config = pick(CONFIGS)
        const status = config.model === 'sim-flaky' && rand() < 0.5 ? 'failed' : rand() < 0.06 ? 'cancelled' : 'completed'
        await insertRun(client, {
          workspaceId: acme,
          promptId,
          snapshotId: snapshots[vi],
          version: vi + 1,
          system: p.versions[vi].system,
          template: p.versions[vi].template,
          inputs: pick(p.inputs),
          config,
          userId: pick([users.alice, users.bob]),
          createdAt: new Date(now - Math.floor(rand() * 46 * hour) - 10 * 60_000),
          status,
        })
      }
      if (index === 0) triage = { promptId, snapshotId: snapshots[snapshots.length - 1], version: p.versions.length }
    }

    // A side-by-side comparison and a shared run on the triage prompt.
    if (triage) {
      const p = PROMPTS[0]
      const v = p.versions[p.versions.length - 1]
      const comparisonId = randomUUID()
      const at = new Date(now - 40 * 60_000)
      for (const [i, config] of [CONFIGS[0], CONFIGS[2]].entries()) {
        await insertRun(client, {
          workspaceId: acme,
          ...triage,
          system: v.system,
          template: v.template,
          inputs: p.inputs[0],
          config,
          userId: users.alice,
          createdAt: new Date(at.getTime() + i),
          status: 'completed',
          comparisonId,
        })
      }
      const shared = await client.query<{ id: string }>(
        `SELECT id FROM runs WHERE prompt_id = $1 AND status = 'completed' AND model = 'sim-quality' ORDER BY created_at DESC LIMIT 1`,
        [triage.promptId],
      )
      if (shared.rows[0]) {
        await client.query(
          `INSERT INTO shares (token, workspace_id, prompt_id, snapshot_id, version, run_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [DEMO_SHARE_TOKEN, acme, triage.promptId, triage.snapshotId, triage.version, shared.rows[0].id, users.alice],
        )
      }
    }

    const journal = (
      await client.query<{ id: string }>(
        `INSERT INTO prompts (workspace_id, title, description, head_version, created_by, updated_by)
         VALUES ($1, 'Journal reflection', 'Private prompt in another workspace.', 1, $2, $2) RETURNING id`,
        [solo, users.carol],
      )
    ).rows[0].id
    const journalSnapshot = await insertSnapshot(
      client,
      journal,
      { system: 'You help people reflect on their day.', template: 'Ask me three questions about: {{topic}}' },
      users.carol,
    )
    await client.query(
      `INSERT INTO prompt_versions (prompt_id, version, snapshot_id, message, created_by) VALUES ($1, 1, $2, 'Initial version', $3)`,
      [journal, journalSnapshot, users.carol],
    )
  })
  console.log('Seeded users alice, bob, carol (password: password123)')
}

try {
  await seed()
} catch (err) {
  console.error('Seed failed:', err)
  process.exitCode = 1
} finally {
  await pool.end()
}
