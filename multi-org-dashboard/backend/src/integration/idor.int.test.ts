/**
 * Cross-org access attempts against the real PostgreSQL and Valkey: every
 * request goes through the real middleware and the real SQL. The test builds
 * its own two orgs and five users, and deletes them afterwards, so it runs on
 * a seeded database without disturbing the demo data.
 *
 * Run with: npm run test:integration (after docker-compose up and db:migrate)
 */
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../api/app.js'
import { redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import { hashToken } from '../shared/ids.js'

const app = createApp()
const run = randomBytes(4).toString('hex')
const A = `org_ita${run}`
const B = `org_itb${run}`
const PASSWORD = 'integration-pass'

type Agent = ReturnType<typeof request.agent>
const ids: Record<string, string> = {}
const agents: Record<string, Agent> = {}
const linkToken = `itest-link-${run}-0123456789`

async function insert(sql: string, params: unknown[]): Promise<string> {
  const { rows } = await pool.query(sql, params)
  return rows[0].id
}

async function signIn(name: string): Promise<Agent> {
  const agent = request.agent(app)
  await agent.post('/api/v1/auth/login').send({ email: `${name}-${run}@itest.example`, password: PASSWORD }).expect(200)
  return agent
}

beforeAll(async () => {
  const hash = await bcrypt.hash(PASSWORD, 4)
  // dual: admin in A, viewer in B. alone: editor in A only. bea: admin in B. vic: viewer in A. cal: editor in A, to be removed.
  for (const name of ['dual', 'alone', 'bea', 'vic', 'cal']) {
    ids[name] = await insert('INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id', [
      `${name}-${run}@itest.example`,
      name,
      hash,
    ])
  }
  await pool.query(`INSERT INTO orgs (id, name, plan) VALUES ($1, 'Itest A', 'pro'), ($2, 'Itest B', 'starter')`, [A, B])
  const members: Array<[string, string, string]> = [
    [A, 'dual', 'admin'],
    [A, 'alone', 'editor'],
    [A, 'vic', 'viewer'],
    [A, 'cal', 'editor'],
    [B, 'bea', 'admin'],
    [B, 'dual', 'viewer'],
  ]
  for (const [org, user, role] of members) {
    await pool.query('INSERT INTO org_memberships (org_id, user_id, role) VALUES ($1, $2, $3)', [org, ids[user], role])
  }
  ids.projA = await insert(`INSERT INTO projects (org_id, name) VALUES ($1, 'Open A') RETURNING id`, [A])
  ids.projSecret = await insert(`INSERT INTO projects (org_id, name, restricted) VALUES ($1, 'Secret A', true) RETURNING id`, [A])
  ids.projB = await insert(`INSERT INTO projects (org_id, name) VALUES ($1, 'Open B') RETURNING id`, [B])
  await pool.query('INSERT INTO project_memberships (project_id, user_id) VALUES ($1, $2)', [ids.projSecret, ids.alone])

  const agent = (org: string, project: string, name: string) =>
    insert(`INSERT INTO agents (org_id, project_id, name, model) VALUES ($1, $2, $3, 'relay-small') RETURNING id`, [org, project, name])
  ids.agentA = await agent(A, ids.projA, 'Agent A')
  ids.agentSecret = await agent(A, ids.projSecret, 'Agent Secret')
  ids.agentB = await agent(B, ids.projB, 'Agent B')
  const conversation = (org: string, project: string, agentId: string, subject: string) =>
    insert(
      `INSERT INTO conversations (org_id, project_id, agent_id, channel, status, customer_name, subject, started_at)
       VALUES ($1, $2, $3, 'chat', 'open', 'Test Customer', $4, now()) RETURNING id`,
      [org, project, agentId, subject],
    )
  ids.convA = await conversation(A, ids.projA, ids.agentA, 'Visible in A')
  ids.convSecret = await conversation(A, ids.projSecret, ids.agentSecret, 'Secret in A')
  ids.convB = await conversation(B, ids.projB, ids.agentB, 'Only in B')

  ids.promptPrivate = await insert(
    `INSERT INTO prompts (org_id, project_id, owner_id, title, body) VALUES ($1, $2, $3, 'Private', 'x') RETURNING id`,
    [A, ids.projA, ids.cal],
  )
  ids.promptEditors = await insert(
    `INSERT INTO prompts (org_id, project_id, owner_id, title, body, shared_roles) VALUES ($1, $2, $3, 'Editors', 'x', '{editor}') RETURNING id`,
    [A, ids.projA, ids.cal],
  )
  await pool.query(`INSERT INTO feature_flags (key, description) VALUES ('prompt_library', 'Prompt library') ON CONFLICT DO NOTHING`)
  await pool.query(`INSERT INTO feature_flag_rules (flag_key, org_id, enabled, roles) VALUES ('prompt_library', $1, true, '{}')`, [A])
  await pool.query(
    `INSERT INTO share_links (org_id, resource_type, resource_id, token_hash, token_hint, created_by)
     VALUES ($1, 'prompt', $2, $3, 'test', $4)`,
    [A, ids.promptEditors, hashToken(linkToken), ids.cal],
  )
  await pool.query(
    `INSERT INTO invitations (org_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, 'friend-${run}@itest.example', 'viewer', $2, $3, now() + interval '1 day')`,
    [A, hashToken(`itest-invite-${run}-0123456789`), ids.cal],
  )
  await pool.query(
    `INSERT INTO export_jobs (org_id, created_by, kind, query, idempotency_key) VALUES ($1, $2, 'conversations', '{}', 'itest-key')`,
    [A, ids.cal],
  )

  for (const name of ['dual', 'alone', 'bea', 'vic', 'cal']) agents[name] = await signIn(name)
})

afterAll(async () => {
  await pool.query('DELETE FROM orgs WHERE id = ANY($1)', [[A, B]])
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(ids).filter((_, i) => i < 5)])
  await Promise.allSettled([pool.end(), redis.quit()])
})

describe('cross-org IDOR attempts', () => {
  it('a member of A cannot reach B at all: B answers 404 as if it did not exist', async () => {
    const res = await agents.alone.get(`/api/v1/orgs/${B}/manifest`).expect(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
    await agents.alone.get(`/api/v1/orgs/${B}/conversations/${ids.convB}`).expect(404)
  })

  it('swapping a B resource id into an A path is 404, even for a user who belongs to both', async () => {
    await agents.dual.get(`/api/v1/orgs/${A}/conversations/${ids.convB}`).expect(404)
    await agents.dual.get(`/api/v1/orgs/${A}/agents/${ids.agentB}`).expect(404)
    // Through the right org it exists, so the 404 above was scoping, not a bad id.
    await agents.dual.get(`/api/v1/orgs/${B}/conversations/${ids.convB}`).expect(200)
  })

  it('cannot modify or delete a B resource through A, where the user is an admin', async () => {
    await agents.dual.patch(`/api/v1/orgs/${A}/agents/${ids.agentB}`).send({ name: 'hijacked' }).expect(404)
    await agents.dual.delete(`/api/v1/orgs/${A}/agents/${ids.agentB}`).expect(404)
    const { rows } = await pool.query('SELECT name FROM agents WHERE id = $1', [ids.agentB])
    expect(rows[0].name).toBe('Agent B')
  })

  it('in B the same user has B’s role (viewer): reads work, writes are 403', async () => {
    const res = await agents.dual.delete(`/api/v1/orgs/${B}/agents/${ids.agentB}`).expect(403)
    expect(res.body.error.details).toMatchObject({ permission: 'agents.delete', role: 'viewer' })
  })

  it('cannot create a resource in another org’s project', async () => {
    await agents.dual
      .post(`/api/v1/orgs/${A}/agents`)
      .send({ name: 'Planted', model: 'relay-small', projectId: ids.projB })
      .expect(404)
  })

  it('restricted projects are filtered out of lists and 404 on direct access', async () => {
    const list = await agents.vic.get(`/api/v1/orgs/${A}/conversations`).expect(200)
    const subjects = list.body.items.map((c: { subject: string }) => c.subject)
    expect(subjects).toContain('Visible in A')
    expect(subjects).not.toContain('Secret in A')
    await agents.vic.get(`/api/v1/orgs/${A}/conversations/${ids.convSecret}`).expect(404)
    await agents.alone.get(`/api/v1/orgs/${A}/conversations/${ids.convSecret}`).expect(200) // project member
    await agents.dual.get(`/api/v1/orgs/${A}/conversations/${ids.convSecret}`).expect(200) // admin
  })

  it('a filter cannot widen access: asking for the restricted project returns nothing', async () => {
    const res = await agents.vic.get(`/api/v1/orgs/${A}/conversations?projectId=${ids.projSecret}`).expect(200)
    expect(res.body.items).toEqual([])
  })

  it('prompt visibility is part of the query', async () => {
    await agents.alone.get(`/api/v1/orgs/${A}/prompts/${ids.promptPrivate}`).expect(404)
    await agents.alone.get(`/api/v1/orgs/${A}/prompts/${ids.promptEditors}`).expect(200)
    await agents.vic.get(`/api/v1/orgs/${A}/prompts/${ids.promptEditors}`).expect(404)
  })

  it('a role check and a plan check are different answers', async () => {
    const viewer = await agents.vic
      .post(`/api/v1/orgs/${A}/exports`)
      .set('Idempotency-Key', `itest-${run}-v`)
      .send({ kind: 'conversations', filters: {} })
      .expect(403)
    expect(viewer.body.error.code).toBe('FORBIDDEN')
    const starter = await agents.bea
      .post(`/api/v1/orgs/${B}/exports`)
      .set('Idempotency-Key', `itest-${run}-b`)
      .send({ kind: 'conversations', filters: {} })
      .expect(403)
    expect(starter.body.error.code).toBe('ENTITLEMENT_REQUIRED')
  })
})

describe('access changes take effect on the next request', () => {
  it('a demotion is enforced at once for writes and, via the version, for cached reads', async () => {
    await agents.dual.get(`/api/v1/orgs/${A}/billing`).expect(200) // warms the cache as admin
    const before = await agents.dual.get(`/api/v1/orgs/${A}/manifest`).expect(200)
    // Promote "alone" directly in the database: the PATCH below is a write, so it re-reads PostgreSQL anyway.
    await pool.query(`UPDATE org_memberships SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [A, ids.alone])
    await agents.alone.patch(`/api/v1/orgs/${A}/members/${ids.dual}`).send({ role: 'viewer' }).expect(200)

    const after = await agents.dual.get(`/api/v1/orgs/${A}/manifest`).expect(200)
    expect(after.body.manifest.version).toBeGreaterThan(before.body.manifest.version)
    expect(after.body.manifest.role).toBe('viewer')
    await agents.dual.get(`/api/v1/orgs/${A}/billing`).expect(403)
    await agents.dual.post(`/api/v1/orgs/${A}/agents`).send({ name: 'x', model: 'relay-small', projectId: ids.projA }).expect(403)
  })

  it('removing a member revokes their links, invitations and exports, and ends their sessions', async () => {
    const res = await agents.alone.delete(`/api/v1/orgs/${A}/members/${ids.cal}`).expect(200)
    expect(res.body).toMatchObject({ removed: true, invitationsRevoked: 1, linksRevoked: 1, exportsCancelled: 1, sessionsEnded: 1 })

    await agents.cal.get(`/api/v1/orgs/${A}/manifest`).expect(401) // last org: session is gone
    const link = await request(app).get(`/api/v1/shared/${linkToken}`).expect(410)
    expect(link.body.error.code).toBe('LINK_REVOKED')
    const { rows } = await pool.query('SELECT status FROM export_jobs WHERE org_id = $1 AND created_by = $2', [A, ids.cal])
    expect(rows[0].status).toBe('cancelled')
    const audit = await pool.query(`SELECT action, after FROM audit_events WHERE org_id = $1 AND action = 'member.removed'`, [A])
    expect(audit.rows[0].after).toMatchObject({ linksRevoked: 1 })
  })

  it('the last admin cannot be removed or demoted', async () => {
    await agents.bea.delete(`/api/v1/orgs/${B}/members/${ids.bea}`).expect(409)
    await agents.bea.patch(`/api/v1/orgs/${B}/members/${ids.bea}`).send({ role: 'editor' }).expect(409)
  })

  it('an invitation only works for the address it was sent to', async () => {
    const created = await agents.bea.post(`/api/v1/orgs/${B}/invitations`).send({ email: `vic-${run}@itest.example`, role: 'viewer' }).expect(201)
    const token = created.body.invitation.acceptUrl.split('/').pop()
    await agents.alone.post(`/api/v1/invitations/${token}/accept`).expect(403)
    const accepted = await agents.vic.post(`/api/v1/invitations/${token}/accept`).expect(200)
    expect(accepted.body).toMatchObject({ orgId: B, role: 'viewer' })
    await agents.vic.get(`/api/v1/orgs/${B}/manifest`).expect(200)
    await agents.vic.post(`/api/v1/invitations/${token}/accept`).expect(410) // single use
  })
})
