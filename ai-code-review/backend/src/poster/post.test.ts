/**
 * The poster: re-checks the gate immediately before posting, handles a stale post,
 * survives a crash after the host accepted, and takes back an approval whose
 * decision was withdrawn while it was in flight.
 */
import { beforeEach, describe, expect, inject, it } from 'vitest'
import type { HostWriter } from '../shared/host-types.js'

describe.skipIf(!inject('dbReady'))('poster', () => {
  let t: typeof import('../test-support/world.js')
  let host: typeof import('../githost/store.js')
  let poster: typeof import('./post.js')
  let world: Awaited<ReturnType<typeof import('../test-support/world.js')['freshWorld']>>

  beforeEach(async () => {
    t = await import('../test-support/world.js')
    host = await import('../githost/store.js')
    poster = await import('./post.js')
    world = await t.freshWorld()
  })

  /** Runs everything except the poster, leaving an approve intent pending. */
  async function decidedButNotPosted(overrides: Partial<import('../githost/store.js').PullSpec> = {}) {
    const { fixtureSpec } = await import('../githost/fixtures.js')
    const opened = await host.openPull(t.OWNER, t.NAME, { ...fixtureSpec('docs-safe'), ...overrides })
    await world.drainWebhooks()
    await world.drainRuns()
    expect(await t.activeDecision(opened.number)).toMatchObject({ outcome: 'auto_approved', posted_review_id: null })
    return opened
  }

  it('a head that moved after the decision: no post at all', async () => {
    const opened = await decidedButNotPosted()
    await host.pushCommit(t.OWNER, t.NAME, opened.number, { files: [{ path: 'docs/b.md', add: ['y'] }] })
    // The webhook has not arrived, so only the poster's own re-check can see this.
    await world.drainIntents()
    const intent = (await t.intentsOf(opened.number)).find((i) => i.kind === 'approve')
    expect(intent).toMatchObject({ status: 'cancelled' })
    expect((await host.listReviews(t.OWNER, t.NAME, opened.number)).filter((r) => r.commit_id === opened.headSha && r.state === 'APPROVED')).toEqual([])
    await world.settle()
    expect((await t.activeDecision(opened.number))?.head_sha).not.toBe(opened.headSha)
  })

  it('CI going red between the decision and the post: the re-check refuses', async () => {
    const opened = await decidedButNotPosted()
    await host.setChecks(t.OWNER, t.NAME, opened.number, 'failure')
    await world.drainIntents()
    expect(await t.liveApprovals(opened.number)).toEqual([])
    expect((await t.intentsOf(opened.number)).find((i) => i.kind === 'approve')).toMatchObject({ status: 'cancelled', outcome: 'recheck_failed' })
    expect(await t.activeDecision(opened.number)).toMatchObject({ outcome: 'escalated', reason_code: 'gate_failed' })
  })

  it('the kill switch flipped between the decision and the post: nothing lands', async () => {
    const { pool } = await import('../shared/db.js')
    const opened = await decidedButNotPosted()
    await pool.query(`UPDATE repositories SET kill_switch = TRUE WHERE id = $1`, [t.REPO_ID])
    await world.settle()
    expect(await t.liveApprovals(opened.number)).toEqual([])
    expect(await t.activeDecision(opened.number)).toMatchObject({ outcome: 'escalated', reason_code: 'kill_switch' })
  })

  it('a demotion between the decision and the post: nothing lands', async () => {
    const { pool } = await import('../shared/db.js')
    const opened = await decidedButNotPosted()
    await pool.query(`UPDATE repositories SET mode = 'observe' WHERE id = $1`, [t.REPO_ID])
    await world.settle()
    expect(await t.liveApprovals(opened.number)).toEqual([])
    expect(await t.activeDecision(opened.number)).toMatchObject({ outcome: 'shadow' })
  })

  it('the host refuses a stale post: the last line of defense, reached by a push in the final window', async () => {
    const opened = await decidedButNotPosted()
    // The push lands after the re-check and before the write.
    const racing: HostWriter = {
      ...world.writer,
      postReview: async (f, n, args) => {
        await host.pushCommit(t.OWNER, t.NAME, opened.number, { files: [{ path: 'docs/b.md', add: ['y'] }] })
        return world.writer.postReview(f, n, args)
      },
    }
    const intent = (await poster.claimNextIntent('p1'))!
    expect(intent.kind).toBe('approve')
    await poster.processIntent({ reader: world.reader, writer: racing }, intent)
    expect((await t.intentsOf(opened.number)).find((i) => i.kind === 'approve')).toMatchObject({ status: 'cancelled', outcome: 'stale_rejected' })
    expect(await t.liveApprovals(opened.number)).toEqual([])
    await world.settle()
    expect((await t.activeDecision(opened.number))?.head_sha).not.toBe(opened.headSha)
    expect(await t.liveApprovals(opened.number)).toHaveLength(1)
  })

  it('a crash after the host accepted: the retry gets the same review back', async () => {
    const { pool } = await import('../shared/db.js')
    const opened = await decidedButNotPosted()
    const crashing: HostWriter = {
      ...world.writer,
      postReview: async (f, n, args) => {
        await world.writer.postReview(f, n, args)
        throw new Error('poster died before recording this')
      },
    }
    const intent = (await poster.claimNextIntent('p1'))!
    await poster.processIntent({ reader: world.reader, writer: crashing }, intent)
    expect((await t.intentsOf(opened.number)).find((i) => i.kind === 'approve')?.status).toBe('pending')
    await pool.query(`UPDATE post_intents SET next_attempt_at = now() WHERE kind = 'approve' AND pr_number = $1`, [opened.number])
    await world.settle()
    const reviews = (await host.listReviews(t.OWNER, t.NAME, opened.number)).filter((r) => r.state === 'APPROVED')
    expect(reviews).toHaveLength(1)
    expect((await t.activeDecision(opened.number))?.posted_review_id).toBe(reviews[0].id)
  })

  it('a push while the approval is being posted: if it landed first, it gets dismissed', async () => {
    const opened = await decidedButNotPosted()
    const intent = (await poster.claimNextIntent('p1'))!
    let racedSha = ''
    const racing: HostWriter = {
      ...world.writer,
      postReview: async (f, n, args) => {
        const out = await world.writer.postReview(f, n, args)
        racedSha = (await host.pushCommit(t.OWNER, t.NAME, opened.number, { files: [{ path: 'docs/b.md', add: ['y'] }] })).headSha
        await world.drainWebhooks()
        return out
      },
    }
    await poster.processIntent({ reader: world.reader, writer: racing }, intent)
    // The dismissal waits out the in-flight post's lease; don't make the test wait for it too.
    const { pool } = await import('../shared/db.js')
    await pool.query(`UPDATE post_intents SET next_attempt_at = now() WHERE kind = 'dismiss' AND pr_number = $1`, [opened.number])
    await world.settle()
    const approvals = (await host.listReviews(t.OWNER, t.NAME, opened.number)).filter((r) => r.state === 'APPROVED')
    expect(approvals.find((r) => r.commit_id === opened.headSha)?.dismissed).toBe(true)
    expect(approvals.find((r) => r.commit_id === racedSha)?.dismissed).toBe(false)
  })

  it('a host that keeps failing: the approval goes to a person', async () => {
    const { pool } = await import('../shared/db.js')
    const opened = await decidedButNotPosted()
    const failing: HostWriter = { ...world.writer, postReview: async () => { throw new Error('host down') } }
    for (let i = 0; i < 6; i++) {
      await pool.query(`UPDATE post_intents SET next_attempt_at = now() WHERE kind = 'approve' AND status = 'pending'`)
      const intent = await poster.claimNextIntent('p1')
      if (intent?.kind === 'approve') await poster.processIntent({ reader: world.reader, writer: failing }, intent)
      else if (intent) await poster.processIntent(world.poster, intent)
    }
    expect((await t.intentsOf(opened.number)).find((i) => i.kind === 'approve')).toMatchObject({ status: 'failed' })
    expect(await t.activeDecision(opened.number)).toMatchObject({ outcome: 'escalated', reason_code: 'post_failed' })
  })

  it('a dismissal finds an approval even if its post was never recorded', async () => {
    const { pool } = await import('../shared/db.js')
    const opened = await decidedButNotPosted()
    await host.postReview(t.OWNER, t.NAME, opened.number, { user: 'review-bot', event: 'APPROVE', commitId: opened.headSha, idempotencyKey: 'unrecorded' })
    await pool.query(`UPDATE post_intents SET status = 'cancelled', lease_token = NULL WHERE kind = 'approve' AND pr_number = $1`, [opened.number])
    await host.pushCommit(t.OWNER, t.NAME, opened.number, { files: [{ path: 'docs/b.md', add: ['y'] }] })
    await world.settle()
    expect((await host.listReviews(t.OWNER, t.NAME, opened.number)).find((r) => r.commit_id === opened.headSha && r.state === 'APPROVED')?.dismissed).toBe(true)
  })
})
