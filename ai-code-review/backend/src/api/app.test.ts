/**
 * HTTP-level checks with supertest: the session wall, the webhook front door, and
 * human decisions against real PostgreSQL when it's available.
 */
import { describe, expect, inject, it, vi } from 'vitest'
import request from 'supertest'
import { signPayload } from '../shared/webhook-signature.js'

vi.mock('../shared/cache.js', () => {
  const store = new Map<string, string>()
  return {
    redis: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => void store.set(k, v),
      del: async (k: string) => void store.delete(k),
      incr: async () => 1,
      expire: async () => 1,
      ping: async () => 'PONG',
    },
    keys: { session: (id: string) => `s:${id}`, rate: (b: string) => `r:${b}` },
  }
})

const { createApp } = await import('./app.js')
const app = createApp()

describe('the webhook front door', () => {
  const body = JSON.stringify({ action: 'opened', repository: { full_name: 'nobody/none' } })
  const post = (sig?: string) => {
    const r = request(app).post('/webhooks/git-host').set('Content-Type', 'application/json').set('X-Hook-Event', 'pull_request').set('X-Hook-Delivery', `d-${Math.random()}`)
    return (sig ? r.set('X-Hook-Signature', sig) : r).send(body)
  }

  it('refuses a missing signature', async () => {
    expect((await post()).status).toBe(401)
  })
  it('refuses a forged one', async () => {
    const res = await post(`t=${Math.floor(Date.now() / 1000)},v1=${'a'.repeat(64)}`)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('BAD_SIGNATURE')
  })
  it('refuses a correctly signed replay', async () => {
    const res = await post(signPayload('dev-webhook-secret', Math.floor(Date.now() / 1000) - 3600, body))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('REPLAY')
  })
})

describe('the session wall', () => {
  it.each(['/api/v1/prs', '/api/v1/escalations', '/api/v1/audit', '/api/v1/evaluations', '/api/v1/repos', '/api/v1/fixtures/catalog', '/api/v1/system', '/api/v1/auth/me'])('%s needs a session', async (path) => {
    expect((await request(app).get(path)).status).toBe(401)
  })
  it('health is public', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' })
  })
  it('an unknown route is a clean 404', async () => {
    expect((await request(app).get('/nope')).status).toBe(404)
  })
})

describe.skipIf(!inject('dbReady'))('human decisions', () => {
  async function setup() {
    const bcrypt = (await import('bcryptjs')).default
    const t = await import('../test-support/world.js')
    const world = await t.freshWorld()
    const { pool } = await import('../shared/db.js')
    const hash = await bcrypt.hash('password123', 4)
    await pool.query(`UPDATE users SET password_hash = $1`, [hash])
    const agent = async (username: string) => {
      const a = request.agent(app)
      const res = await a.post('/api/v1/auth/login').send({ username, password: 'password123' })
      expect(res.status).toBe(200)
      return a
    }
    return { t, world, agent, carol: await agent('carol'), alice: await agent('alice'), bob: await agent('bob') }
  }

  it('claim, decide against the SHA, and a push invalidates it', async () => {
    const { t, world, carol, alice } = await setup()
    const host = await import('../githost/store.js')
    const { number, headSha } = await t.openFixture(world, 'auth-risky')
    const queue = await carol.get('/api/v1/escalations')
    expect(queue.status).toBe(200)
    const item = queue.body.escalations.find((e: { prNumber: number }) => e.prNumber === number)
    expect(item.headSha).toBe(headSha)

    expect((await carol.post(`/api/v1/escalations/${item.id}/decide`).send({ decision: 'approve', headSha })).body.error.code).toBe('NOT_CLAIMED')
    expect((await carol.post(`/api/v1/escalations/${item.id}/claim`)).status).toBe(200)
    expect((await alice.post(`/api/v1/escalations/${item.id}/claim`)).status).toBe(409)
    expect((await alice.post(`/api/v1/escalations/${item.id}/decide`).send({ decision: 'approve', headSha })).status).toBe(409)
    expect((await carol.post(`/api/v1/escalations/${item.id}/decide`).send({ decision: 'approve', headSha: 'f'.repeat(40) })).body.error.code).toBe('STALE_SHA')

    expect((await carol.post(`/api/v1/escalations/${item.id}/decide`).send({ decision: 'approve', headSha, note: 'Read it.' })).status).toBe(200)
    await world.settle()
    expect(await t.liveApprovals(number)).toMatchObject([{ commit_id: headSha, user: { login: 'review-bot' } }])
    expect(await t.activeDecision(number)).toMatchObject({ outcome: 'human_approved', actor: 'carol', head_sha: headSha })

    await host.pushCommit(t.OWNER, t.NAME, number, { files: [{ path: 'src/api/login.ts', add: ['// more'] }] })
    await world.settle()
    expect(await t.liveApprovals(number)).toEqual([])
    const decisions = await t.allDecisions(number)
    expect(decisions.find((d) => d.outcome === 'human_approved')).toMatchObject({ state: 'invalidated', head_sha: headSha })
  })

  it('a decision for an outdated SHA is refused', async () => {
    const { t, world, carol } = await setup()
    const host = await import('../githost/store.js')
    const { number, headSha } = await t.openFixture(world, 'auth-risky')
    const item = (await carol.get('/api/v1/escalations')).body.escalations.find((e: { prNumber: number }) => e.prNumber === number)
    await carol.post(`/api/v1/escalations/${item.id}/claim`)
    await host.pushCommit(t.OWNER, t.NAME, number, { files: [{ path: 'src/api/login.ts', add: ['// more'] }] })
    await world.drainWebhooks()
    const res = await carol.post(`/api/v1/escalations/${item.id}/decide`).send({ decision: 'approve', headSha })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('STALE_SHA')
  })

  it('an author cannot approve their own pull request', async () => {
    const { t, world, alice } = await setup()
    const { number, headSha } = await t.openFixture(world, 'feature-small', { author: 'alice' })
    const item = (await alice.get('/api/v1/escalations')).body.escalations.find((e: { prNumber: number }) => e.prNumber === number)
    await alice.post(`/api/v1/escalations/${item.id}/claim`)
    const res = await alice.post(`/api/v1/escalations/${item.id}/decide`).send({ decision: 'approve', headSha })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('SELF_APPROVAL')
  })

  it('another org sees nothing', async () => {
    const { t, world, bob } = await setup()
    const { number } = await t.openFixture(world, 'auth-risky')
    expect((await bob.get('/api/v1/prs')).body.prs).toEqual([])
    expect((await bob.get('/api/v1/escalations')).body.escalations).toEqual([])
    expect((await bob.get(`/api/v1/prs/${t.REPO}/${number}`)).status).toBe(404)
    expect((await bob.get(`/api/v1/repos/${t.REPO_ID}`)).status).toBe(404)
    expect((await bob.get(`/api/v1/audit?repo=${t.REPO}`)).body.entries).toEqual([])
  })

  it('reviewers cannot change policy or modes', async () => {
    const { t, alice } = await setup()
    expect((await alice.patch(`/api/v1/repos/${t.REPO_ID}`).send({ maxFiles: 1000 })).status).toBe(403)
    expect((await alice.post(`/api/v1/repos/${t.REPO_ID}/promote`)).status).toBe(403)
    expect((await alice.post(`/api/v1/repos/${t.REPO_ID}/kill-switch`).send({ on: false })).status).toBe(403)
  })

  it('reporting a dangerous false approval demotes the repository and takes the approval back', async () => {
    const { t, world, carol } = await setup()
    const { number } = await t.openFixture(world, 'docs-safe')
    const d = await t.activeDecision(number)
    expect((await carol.post(`/api/v1/decisions/${d?.id}/report-false-approval`).send({ note: 'Should not have merged' })).body).toEqual({ demoted: true })
    await world.settle()
    expect((await t.repoRow()).mode).toBe('observe')
    expect(await t.liveApprovals(number)).toEqual([])
    expect((await t.escalationsOf(number))[0]).toMatchObject({ status: 'open', reason_code: 'false_approval_reported' })
    const again = await t.openFixture(world, 'docs-safe')
    expect(await t.activeDecision(again.number)).toMatchObject({ outcome: 'shadow' })
  })

  it('only automatic approvals can be reported', async () => {
    const { t, world, carol } = await setup()
    const { number } = await t.openFixture(world, 'auth-risky')
    const d = await t.activeDecision(number)
    expect((await carol.post(`/api/v1/decisions/${d?.id}/report-false-approval`).send({})).status).toBe(422)
  })

  it('promotion is refused below threshold, recorded, then allowed with evidence', async () => {
    const { t, world, carol } = await setup()
    const { pool } = await import('../shared/db.js')
    await pool.query(`UPDATE repositories SET mode = 'observe' WHERE id = $1`, [t.REPO_ID])
    const refused = await carol.post(`/api/v1/repos/${t.REPO_ID}/promote`)
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('PROMOTION_REFUSED')
    expect(refused.body.error.details.checks.find((c: { id: string }) => c.id === 'evaluation_exists').passed).toBe(false)

    for (let i = 0; i < 5; i++) await t.openFixture(world, 'docs-safe')
    expect((await carol.post('/api/v1/evaluations').send({ modelVersion: 'mock-reviewer-1' })).status).toBe(201)
    const allowed = await carol.post(`/api/v1/repos/${t.REPO_ID}/promote`)
    expect(allowed.status).toBe(200)
    expect(allowed.body.repo.mode).toBe('narrow_auto')
    const history = await carol.get(`/api/v1/repos/${t.REPO_ID}`)
    expect(history.body.modeChanges.map((m: { kind: string }) => m.kind)).toEqual(['promote', 'promote_refused'])
  })

  it('changing the model drops back to observe, and the old evidence no longer counts', async () => {
    const { t, world, carol } = await setup()
    for (let i = 0; i < 2; i++) await t.openFixture(world, 'docs-safe')
    expect((await carol.patch(`/api/v1/repos/${t.REPO_ID}`).send({ modelVersion: 'mock-reviewer-2' })).body.repo.mode).toBe('observe')
    const preview = await carol.get(`/api/v1/repos/${t.REPO_ID}`)
    expect(preview.body.promotion.allowed).toBe(false)
  })

  it('settings changes are audited and bump the version', async () => {
    const { t, carol } = await setup()
    const { pool } = await import('../shared/db.js')
    const res = await carol.patch(`/api/v1/repos/${t.REPO_ID}`).send({ maxFiles: 3, protectedPaths: ['src/**'] })
    expect(res.body.repo).toMatchObject({ maxFiles: 3, settingsVersion: 2, protectedPaths: ['src/**'] })
    const audit = await pool.query(`SELECT payload FROM audit_log WHERE repo_id = $1 AND kind = 'settings_changed'`, [t.REPO_ID])
    expect(audit.rows[0].payload.changes.maxFiles).toBe(3)
  })

  it('the tamper check runs through the API', async () => {
    const { t, world, carol } = await setup()
    await t.openFixture(world, 'docs-safe')
    const out = await carol.post('/api/v1/audit/verify').send({ repoId: t.REPO_ID })
    expect(out.body.ok).toBe(true)
    expect(out.body.chains[0].checked).toBeGreaterThan(3)
  })
})
