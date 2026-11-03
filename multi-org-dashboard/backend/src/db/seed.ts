/**
 * Seeds two fictitious orgs, three roles, one feature flag, and enough
 * conversation history (about 8,500 conversations) to need pagination and a
 * virtualized table. Deterministic: the same seed produces the same data.
 * Skips if users already exist; pass --reset to wipe and reseed.
 *
 * Users (password `password123`):
 *   alice@example.com  admin in Lumen Outfitters, viewer in Harbor Health Co-op
 *   ben@example.com    editor in Lumen (member of the restricted VIP project)
 *   dev@example.com    viewer in Lumen
 *   chloe@example.com  admin in Harbor
 *   erin@example.com   editor in Harbor
 */
import bcrypt from 'bcryptjs'
import type pg from 'pg'
import { pool, withTransaction } from '../shared/db.js'
import { hashToken } from '../shared/ids.js'

export const DEMO_SHARE_TOKEN = 'demo-lumen-return-policy-link'
export const DEMO_INVITE_TOKEN = 'demo-lumen-invite-for-farah'

/** mulberry32: a small seeded PRNG so reseeding reproduces the same history. */
function rng(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = rng(20261102)
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1))

const USERS = [
  { key: 'alice', email: 'alice@example.com', name: 'Alice Park' },
  { key: 'ben', email: 'ben@example.com', name: 'Ben Okafor' },
  { key: 'dev', email: 'dev@example.com', name: 'Dev Mehta' },
  { key: 'chloe', email: 'chloe@example.com', name: 'Chloe Ramirez' },
  { key: 'erin', email: 'erin@example.com', name: 'Erin Walsh' },
] as const
type UserKey = (typeof USERS)[number]['key']

interface OrgSeed {
  id: string
  name: string
  plan: 'starter' | 'pro'
  branding: { accent: string; initials: string }
  members: Array<[UserKey, 'admin' | 'editor' | 'viewer']>
  projects: Array<{ name: string; restricted?: boolean; members?: UserKey[]; agents: Array<[string, string, string]> }>
  docs: Array<[string, 'upload' | 'url' | 'helpdesk']>
  conversations: number
  subjects: string[]
  replies: string[]
}

const ORGS: OrgSeed[] = [
  {
    id: 'org_lumen',
    name: 'Lumen Outfitters',
    plan: 'pro',
    branding: { accent: 'teal', initials: 'LO' },
    members: [
      ['alice', 'admin'],
      ['ben', 'editor'],
      ['dev', 'viewer'],
    ],
    projects: [
      {
        name: 'Storefront assistant',
        agents: [
          ['Order tracker', 'relay-small', 'live'],
          ['Gear advisor', 'relay-large', 'live'],
        ],
      },
      {
        name: 'Returns desk',
        agents: [
          ['Returns helper', 'relay-medium', 'live'],
          ['Warranty triage', 'relay-medium', 'paused'],
        ],
      },
      { name: 'VIP concierge', restricted: true, members: ['ben'], agents: [['Concierge', 'relay-large', 'live']] },
    ],
    docs: [
      ['Return and exchange policy', 'url'],
      ['Shipping times by region', 'helpdesk'],
      ['Tent and shelter care guide', 'upload'],
      ['Warranty terms 2026', 'upload'],
      ['Size charts: footwear', 'url'],
    ],
    conversations: 6200,
    subjects: [
      'Where is my order?',
      'Return a tent that arrived damaged',
      'Size exchange for hiking boots',
      'Promo code not applying at checkout',
      'Warranty claim for a camp stove',
      'Change the delivery address',
      'Is this jacket waterproof or water resistant?',
      'Refund has not arrived yet',
      'Missing tent poles in package',
      'Recommend a sleeping bag for 0°C',
      'Cancel an order placed by mistake',
      'Gift card balance question',
    ],
    replies: [
      'I found your order. It left our warehouse yesterday and should arrive in two business days.',
      'Sorry about that. I have started a return and emailed you a prepaid label.',
      'Exchanges are free within 60 days. Which size would you like instead?',
      'That code expired last week, but I have applied a 10% courtesy discount to your cart.',
      'I can open a warranty claim. Could you share a photo of the issue?',
      'For temperatures around 0°C, a bag rated to -5°C keeps most people comfortable.',
    ],
  },
  {
    id: 'org_harbor',
    name: 'Harbor Health Co-op',
    plan: 'starter',
    branding: { accent: 'violet', initials: 'HH' },
    members: [
      ['chloe', 'admin'],
      ['erin', 'editor'],
      ['alice', 'viewer'],
    ],
    projects: [
      {
        name: 'Appointment line',
        agents: [
          ['Scheduling assistant', 'relay-medium', 'live'],
          ['Reminder bot', 'relay-small', 'live'],
        ],
      },
      { name: 'Billing questions', agents: [['Billing helper', 'relay-medium', 'draft']] },
    ],
    docs: [
      ['Clinic locations and hours', 'url'],
      ['Holiday schedule', 'helpdesk'],
      ['How to read your statement', 'upload'],
    ],
    conversations: 2300,
    subjects: [
      'Reschedule my appointment',
      'Question about a statement',
      'Clinic hours on public holidays',
      'Update my phone number',
      'Book a first visit',
      'Parking at the downtown clinic',
      'Request a copy of a receipt',
      'Cancel a reminder text',
    ],
    replies: [
      'I can help with that. The next available slot is Thursday at 10:30. Shall I book it?',
      'Your statement shows one visit and a co-op discount. Nothing is outstanding.',
      'All clinics close on public holidays. The downtown clinic reopens at 8:00 the next day.',
      'Done. Your contact details are updated.',
      'Parking is free for the first two hours in the garage on Pier Street.',
    ],
  },
]

const FIRST = ['Sam', 'Priya', 'Jonas', 'Mei', 'Omar', 'Lucia', 'Tariq', 'Hana', 'Felix', 'Ama', 'Noah', 'Ines', 'Kenji', 'Zara']
const LAST = ['Lindqvist', 'Nakamura', 'Osei', 'Fischer', 'Duarte', 'Haddad', 'Kowalski', 'Byrne', 'Sato', 'Mensah']

async function insertConversations(
  client: pg.PoolClient,
  org: OrgSeed,
  agents: Array<{ id: string; projectId: string }>,
): Promise<number> {
  const now = Date.now()
  const conv = { id: [] as string[], project: [] as string[], agent: [] as string[], channel: [] as string[], status: [] as string[], customer: [] as string[], subject: [] as string[], count: [] as number[], csat: [] as (number | null)[], cost: [] as number[], started: [] as string[], ended: [] as (string | null)[] }
  const msg = { conversation: [] as string[], author: [] as string[], body: [] as string[], at: [] as string[] }
  const { rows: ids } = await client.query('SELECT gen_random_uuid() AS id FROM generate_series(1, $1)', [org.conversations])

  for (let i = 0; i < org.conversations; i++) {
    const agent = pick(agents)
    // Skewed toward recent days, spread over the last 60.
    const ageMs = Math.floor(Math.pow(random(), 1.6) * 60 * 24 * 60 * 60 * 1000)
    const started = new Date(now - ageMs - between(0, 59) * 1000)
    const roll = random()
    const status = roll < 0.7 ? 'resolved' : roll < 0.82 ? 'escalated' : 'open'
    const channelRoll = random()
    const channel = channelRoll < 0.6 ? 'chat' : channelRoll < 0.9 ? 'email' : 'voice'
    const subject = pick(org.subjects)
    const messages = between(3, 8)
    const id = ids[i].id as string
    conv.id.push(id)
    conv.project.push(agent.projectId)
    conv.agent.push(agent.id)
    conv.channel.push(channel)
    conv.status.push(status)
    conv.customer.push(`${pick(FIRST)} ${pick(LAST)}`)
    conv.subject.push(subject)
    conv.count.push(messages)
    conv.csat.push(status === 'resolved' ? between(3, 5) : status === 'escalated' ? between(1, 3) : null)
    conv.cost.push(between(2, 9) * messages)
    conv.started.push(started.toISOString())
    conv.ended.push(status === 'open' ? null : new Date(started.getTime() + messages * 70_000).toISOString())
    for (let m = 0; m < messages; m++) {
      const author = m % 2 === 0 ? 'customer' : status === 'escalated' && m === messages - 1 ? 'human' : 'agent'
      const body =
        author === 'customer'
          ? m === 0
            ? subject
            : pick(['Thanks, that helps.', 'Could you check again?', 'How long will that take?', 'Great, one more question.'])
          : author === 'human'
            ? 'Hi, this is Sam from the support team. I have taken over and will follow up by email today.'
            : pick(org.replies)
      msg.conversation.push(id)
      msg.author.push(author)
      msg.body.push(body)
      msg.at.push(new Date(started.getTime() + m * 70_000).toISOString())
    }
  }

  await client.query(
    `INSERT INTO conversations (id, org_id, project_id, agent_id, channel, status, customer_name, subject, message_count, csat, cost_cents, started_at, ended_at)
     SELECT u.id, $1, u.project, u.agent, u.channel, u.status, u.customer, u.subject, u.count, u.csat, u.cost, u.started, u.ended
       FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::text[], $8::text[], $9::int[], $10::smallint[], $11::int[], $12::timestamptz[], $13::timestamptz[])
         AS u(id, project, agent, channel, status, customer, subject, count, csat, cost, started, ended)`,
    [org.id, conv.id, conv.project, conv.agent, conv.channel, conv.status, conv.customer, conv.subject, conv.count, conv.csat, conv.cost, conv.started, conv.ended],
  )
  const BATCH = 10_000
  for (let start = 0; start < msg.conversation.length; start += BATCH) {
    const end = start + BATCH
    await client.query(
      `INSERT INTO conversation_messages (conversation_id, org_id, author, body, created_at)
       SELECT u.c, $1, u.a, u.b, u.t FROM unnest($2::uuid[], $3::text[], $4::text[], $5::timestamptz[]) AS u(c, a, b, t)`,
      [org.id, msg.conversation.slice(start, end), msg.author.slice(start, end), msg.body.slice(start, end), msg.at.slice(start, end)],
    )
  }
  return org.conversations
}

async function seed(): Promise<void> {
  const reset = process.argv.includes('--reset')
  const existing = await pool.query('SELECT count(*)::int AS n FROM users')
  if (existing.rows[0].n > 0 && !reset) {
    console.log('Seed skipped: users already exist (pass --reset to wipe and reseed)')
    return
  }

  await withTransaction(async (client) => {
    if (reset) {
      await client.query(
        `TRUNCATE audit_events, export_jobs, share_links, prompts, conversation_messages, conversations, knowledge_docs,
                  agents, feature_flag_rules, feature_flags, invitations, project_memberships, org_memberships, projects, orgs, users
         RESTART IDENTITY CASCADE`,
      )
    }
    const hash = await bcrypt.hash('password123', 10)
    const userIds = {} as Record<UserKey, string>
    for (const u of USERS) {
      const { rows } = await client.query(
        'INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [u.email, u.name, hash],
      )
      userIds[u.key] = rows[0].id
    }

    await client.query(
      `INSERT INTO feature_flags (key, description, default_enabled)
       VALUES ('prompt_library', 'Prompt library: save, share and link reusable prompts across the team', false)`,
    )

    const promptProjects: Record<string, string[]> = {}
    for (const org of ORGS) {
      await client.query('INSERT INTO orgs (id, name, plan, branding) VALUES ($1, $2, $3, $4)', [
        org.id,
        org.name,
        org.plan,
        JSON.stringify(org.branding),
      ])
      for (const [user, role] of org.members) {
        await client.query('INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES ($1, $2, $3, now() - interval \'90 days\')', [
          org.id,
          userIds[user],
          role,
        ])
      }
      const agents: Array<{ id: string; projectId: string }> = []
      promptProjects[org.id] = []
      for (const project of org.projects) {
        const { rows } = await client.query(
          'INSERT INTO projects (org_id, name, restricted) VALUES ($1, $2, $3) RETURNING id',
          [org.id, project.name, project.restricted ?? false],
        )
        const projectId = rows[0].id
        if (!project.restricted) promptProjects[org.id].push(projectId)
        for (const member of project.members ?? []) {
          await client.query('INSERT INTO project_memberships (project_id, user_id) VALUES ($1, $2)', [projectId, userIds[member]])
        }
        for (const [name, model, status] of project.agents) {
          const owner = userIds[org.members[0][0]]
          const agent = await client.query(
            `INSERT INTO agents (org_id, project_id, owner_id, name, model, status, instructions, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(hours => $8)) RETURNING id`,
            [org.id, projectId, owner, name, model, status, `You are the ${name.toLowerCase()} for ${org.name}. Be brief and friendly.`, between(1, 200)],
          )
          agents.push({ id: agent.rows[0].id, projectId })
        }
      }
      for (const [title, source] of org.docs) {
        await client.query(
          `INSERT INTO knowledge_docs (org_id, project_id, owner_id, title, source, chunks, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(days => $7))`,
          [org.id, pick(promptProjects[org.id]), userIds[org.members[0][0]], title, source, between(8, 120), between(1, 60)],
        )
      }
      const n = await insertConversations(client, org, agents)
      console.log(`  ${org.name}: ${n} conversations`)
    }

    // The flag: on in Lumen for admins and editors, no rule (default off) in Harbor.
    await client.query(
      `INSERT INTO feature_flag_rules (flag_key, org_id, enabled, roles) VALUES ('prompt_library', 'org_lumen', true, '{admin,editor}')`,
    )

    const prompts: Array<[string, UserKey, string, string, string[]]> = [
      ['org_lumen', 'alice', 'Return policy tone', 'Explain the return policy warmly. Offer an exchange before a refund, and never promise dates the carrier controls.', ['admin', 'editor', 'viewer']],
      ['org_lumen', 'alice', 'Escalation summary', 'Summarize the conversation for a human agent in three bullet points: issue, what was tried, what the customer wants.', ['admin', 'editor']],
      ['org_lumen', 'ben', 'Gear sizing helper', 'Ask for height, weight and intended use before recommending a size. Mention the free exchange window.', ['editor']],
      ['org_lumen', 'ben', 'Draft: holiday promo replies', 'Work in progress. Answer questions about the winter sale without quoting prices.', []],
      ['org_harbor', 'chloe', 'Appointment confirmations', 'Confirm the clinic, date and time, and remind the patient to bring their co-op card.', ['admin', 'editor', 'viewer']],
    ]
    const promptIds: Record<string, string> = {}
    for (const [orgId, owner, title, body, roles] of prompts) {
      const { rows } = await client.query(
        `INSERT INTO prompts (org_id, project_id, owner_id, title, body, shared_roles, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(hours => $7)) RETURNING id`,
        [orgId, promptProjects[orgId][0], userIds[owner], title, body, roles, between(2, 300)],
      )
      promptIds[title] = rows[0].id
    }
    await client.query(
      `INSERT INTO share_links (org_id, resource_type, resource_id, token_hash, token_hint, created_by, expires_at, last_used_at, created_at)
       VALUES ('org_lumen', 'prompt', $1, $2, $3, $4, now() + interval '25 days', now() - interval '3 hours', now() - interval '5 days'),
              ('org_lumen', 'prompt', $5, $6, $7, $8, now() + interval '20 days', NULL, now() - interval '9 days')`,
      [
        promptIds['Return policy tone'], hashToken(DEMO_SHARE_TOKEN), DEMO_SHARE_TOKEN.slice(-4), userIds.alice,
        promptIds['Gear sizing helper'], hashToken('demo-lumen-gear-sizing-link'), 'link', userIds.ben,
      ],
    )

    await client.query(
      `INSERT INTO invitations (org_id, email, role, token_hash, invited_by, expires_at, created_at)
       VALUES ('org_lumen', 'farah@example.com', 'editor', $1, $2, now() + interval '6 days', now() - interval '1 day'),
              ('org_lumen', 'gus@example.com', 'viewer', $3, $2, now() - interval '2 days', now() - interval '9 days')`,
      [hashToken(DEMO_INVITE_TOKEN), userIds.alice, hashToken('demo-lumen-expired-invite-gus')],
    )

    const history: Array<[string, UserKey, string, string, string, unknown, unknown, number]> = [
      ['org_lumen', 'alice', 'member.role_changed', 'user', 'Dev Mehta', { role: 'editor' }, { role: 'viewer' }, 30],
      ['org_lumen', 'alice', 'flag.changed', 'feature_flag', 'prompt_library', null, { enabled: true, roles: ['admin', 'editor'] }, 20],
      ['org_lumen', 'ben', 'link.created', 'prompt', 'Gear sizing helper', null, { expiresInDays: 30 }, 9],
      ['org_lumen', 'alice', 'link.created', 'prompt', 'Return policy tone', null, { expiresInDays: 30 }, 5],
      ['org_lumen', 'alice', 'invitation.created', 'invitation', 'farah@example.com', null, { role: 'editor' }, 1],
      ['org_harbor', 'chloe', 'member.role_changed', 'user', 'Alice Park', { role: 'editor' }, { role: 'viewer' }, 12],
    ]
    for (const [orgId, actor, action, targetType, targetName, before, after, daysAgo] of history) {
      await client.query(
        `INSERT INTO audit_events (org_id, actor_id, actor_name, action, target_type, target_name, before, after, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - make_interval(days => $9))`,
        [orgId, userIds[actor], USERS.find((u) => u.key === actor)!.name, action, targetType, targetName,
          before === null ? null : JSON.stringify(before), JSON.stringify(after), daysAgo],
      )
    }
  })
  await pool.query('ANALYZE')
  console.log('Seed complete. Sign in as alice@example.com / password123')
}

try {
  await seed()
} catch (err) {
  console.error('Seed failed:', err)
  process.exitCode = 1
} finally {
  await pool.end()
}
