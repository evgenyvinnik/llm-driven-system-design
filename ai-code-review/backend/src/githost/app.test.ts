import request from 'supertest'
import { describe, expect, inject, it } from 'vitest'
import { createHostApp } from './app.js'

const app = createHostApp(['http://localhost:9/none'])
const READER = 'Bearer dev-reader-token'
const POSTER = 'Bearer dev-poster-token'
const ADMIN = 'Bearer dev-fixture-admin-token'

describe('token scopes at the host', () => {
  it('no token, no reads', async () => {
    expect((await request(app).get('/repos/a/b/pulls')).status).toBe(401)
  })
  it('the read-only token cannot post a review, enforced here rather than in the worker', async () => {
    const res = await request(app).post('/repos/a/b/pulls/1/reviews').set('Authorization', READER).send({ event: 'APPROVE', commit_id: 'x' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE')
  })
  it('the read-only token cannot dismiss a review', async () => {
    expect((await request(app).put('/repos/a/b/pulls/1/reviews/1/dismissals').set('Authorization', READER).send({})).status).toBe(403)
  })
  it('the read-only token cannot use the fixture admin', async () => {
    expect((await request(app).get('/admin/settings').set('Authorization', READER)).status).toBe(403)
  })
  it('the poster token cannot use the fixture admin', async () => {
    expect((await request(app).get('/admin/settings').set('Authorization', POSTER)).status).toBe(403)
  })
  it('the admin token cannot post as the bot', async () => {
    expect((await request(app).post('/repos/a/b/pulls/1/reviews').set('Authorization', ADMIN).send({ event: 'APPROVE' })).status).toBe(403)
  })
})

describe.skipIf(!inject('dbReady'))('reviews over HTTP', () => {
  it('a stale commit id gets 409 with the current head', async () => {
    const t = await import('../test-support/world.js')
    const host = await import('./store.js')
    await t.freshWorld()
    const opened = await host.openPull(t.OWNER, t.NAME, { title: 'T', author: 'dave', files: [{ path: 'docs/a.md', add: ['x'] }] })
    const pushed = await host.pushCommit(t.OWNER, t.NAME, opened.number, { files: [{ path: 'docs/b.md', add: ['y'] }] })
    const path = `/repos/${t.REPO}/pulls/${opened.number}/reviews`
    const stale = await request(app).post(path).set('Authorization', POSTER).send({ event: 'APPROVE', commit_id: opened.headSha })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatchObject({ code: 'STALE_COMMIT', current_head: pushed.headSha })
    const fresh = await request(app).post(path).set('Authorization', POSTER).set('Idempotency-Key', 'k').send({ event: 'APPROVE', commit_id: pushed.headSha })
    expect(fresh.status).toBe(201)
    const replay = await request(app).post(path).set('Authorization', POSTER).set('Idempotency-Key', 'k').send({ event: 'APPROVE', commit_id: pushed.headSha })
    expect(replay.status).toBe(200)
    expect(replay.body.id).toBe(fresh.body.id)
  })
  it('a content read needs a commit', async () => {
    const t = await import('../test-support/world.js')
    await t.freshWorld()
    expect((await request(app).get(`/repos/${t.REPO}/contents?path=README.md`).set('Authorization', READER)).status).toBe(422)
  })
})
