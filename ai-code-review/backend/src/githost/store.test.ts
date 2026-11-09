import { beforeEach, describe, expect, inject, it } from 'vitest'
import type { HostError } from './store.js'

describe.skipIf(!inject('dbReady'))('fixture host', () => {
  let host: typeof import('./store.js')
  let t: typeof import('../test-support/world.js')

  beforeEach(async () => {
    host = await import('./store.js')
    t = await import('../test-support/world.js')
    await t.freshWorld()
  })

  const open = () => host.openPull(t.OWNER, t.NAME, { title: 'T', author: 'dave', files: [{ path: 'docs/a.md', add: ['x'] }] })

  it('gives each commit a new SHA and increments head_seq', async () => {
    const { number, headSha } = await open()
    const pushed = await host.pushCommit(t.OWNER, t.NAME, number, { files: [{ path: 'docs/b.md', add: ['y'] }] })
    expect(pushed.headSha).not.toBe(headSha)
    expect(pushed.headSeq).toBe(2)
    expect((await host.listFiles(t.OWNER, t.NAME, number)).files.map((f) => f.filename)).toEqual(['docs/a.md', 'docs/b.md'])
  })

  describe('compare-and-swap on reviews', () => {
    it('accepts a review at the head', async () => {
      const { number, headSha } = await open()
      const r = await host.postReview(t.OWNER, t.NAME, number, { user: 'review-bot', event: 'APPROVE', commitId: headSha })
      expect(r).toMatchObject({ commit_id: headSha, state: 'APPROVED', replayed: false })
    })

    it('rejects a review for a commit that is no longer the head', async () => {
      const { number, headSha } = await open()
      const pushed = await host.pushCommit(t.OWNER, t.NAME, number, { files: [{ path: 'docs/b.md', add: ['y'] }] })
      const err = (await host.postReview(t.OWNER, t.NAME, number, { user: 'review-bot', event: 'APPROVE', commitId: headSha }).catch((e) => e)) as HostError
      expect(err.status).toBe(409)
      expect(err.code).toBe('STALE_COMMIT')
      expect(err.details?.current_head).toBe(pushed.headSha)
      expect(await host.listReviews(t.OWNER, t.NAME, number)).toEqual([])
    })

    it('requires a commit id: there is no default to the latest', async () => {
      const { number } = await open()
      const err = (await host.postReview(t.OWNER, t.NAME, number, { user: 'review-bot', event: 'APPROVE' }).catch((e) => e)) as HostError
      expect(err.code).toBe('COMMIT_ID_REQUIRED')
    })

    it('a racing push and review are strictly ordered, and an approval never lands on a stale head', async () => {
      for (let i = 0; i < 15; i++) {
        const { number, headSha } = await open()
        const [push, review] = await Promise.allSettled([
          host.pushCommit(t.OWNER, t.NAME, number, { files: [{ path: 'docs/b.md', add: ['y'] }] }),
          host.postReview(t.OWNER, t.NAME, number, { user: 'review-bot', event: 'APPROVE', commitId: headSha }),
        ])
        expect(push.status).toBe('fulfilled')
        const reviews = await host.listReviews(t.OWNER, t.NAME, number)
        const pr = await host.getPull(t.OWNER, t.NAME, number)
        if (review.status === 'fulfilled') {
          // The review won the lock: it exists, for the old head, and the push moved past it.
          expect(reviews.map((r) => r.commit_id)).toEqual([headSha])
          expect(pr.head.sha).not.toBe(headSha)
        } else {
          expect((review.reason as HostError).code).toBe('STALE_COMMIT')
          expect(reviews).toEqual([])
        }
      }
    })

    it('a retry with the same idempotency key returns the same review, even after the head moved', async () => {
      const { number, headSha } = await open()
      const first = await host.postReview(t.OWNER, t.NAME, number, { user: 'review-bot', event: 'APPROVE', commitId: headSha, idempotencyKey: 'k1' })
      await host.pushCommit(t.OWNER, t.NAME, number, { files: [{ path: 'docs/b.md', add: ['y'] }] })
      const again = await host.postReview(t.OWNER, t.NAME, number, { user: 'review-bot', event: 'APPROVE', commitId: headSha, idempotencyKey: 'k1' })
      expect(again.id).toBe(first.id)
      expect(again.replayed).toBe(true)
      expect(await host.listReviews(t.OWNER, t.NAME, number)).toHaveLength(1)
    })

    it('refuses self-review', async () => {
      const { number, headSha } = await open()
      const err = (await host.postReview(t.OWNER, t.NAME, number, { user: 'dave', event: 'APPROVE', commitId: headSha }).catch((e) => e)) as HostError
      expect(err.code).toBe('SELF_REVIEW')
    })
  })

  describe('branch protection, with GitHub-like defaults', () => {
    it('an undismissed approval survives a push, which is why the system has to dismiss it', async () => {
      const { number, headSha } = await open()
      await host.setChecks(t.OWNER, t.NAME, number, 'success')
      const review = await host.postReview(t.OWNER, t.NAME, number, { user: 'review-bot', event: 'APPROVE', commitId: headSha })
      await host.pushCommit(t.OWNER, t.NAME, number, { files: [{ path: 'src/evil.ts', add: ['x'] }], ci: 'success' })
      expect(await host.mergeBlockers(t.OWNER, t.NAME, number)).toEqual([])
      await host.dismissReview(t.OWNER, t.NAME, number, review.id, 'review-bot', 'stale')
      expect((await host.mergeBlockers(t.OWNER, t.NAME, number)).join()).toMatch(/0 approval/)
    })
    it('blocks on checks at the new head', async () => {
      const { number, headSha } = await open()
      await host.postReview(t.OWNER, t.NAME, number, { user: 'review-bot', event: 'APPROVE', commitId: headSha })
      await host.pushCommit(t.OWNER, t.NAME, number, { files: [{ path: 'docs/c.md', add: ['z'] }], ci: 'failure' })
      expect((await host.mergeBlockers(t.OWNER, t.NAME, number)).join()).toMatch(/ci\/build/)
    })
  })

  it('reads are always at a named commit', async () => {
    const { number, headSha } = await open()
    await host.pushCommit(t.OWNER, t.NAME, number, { files: [{ path: 'docs/a.md', add: ['later'] }] })
    expect(await host.readContent(t.OWNER, t.NAME, 'docs/a.md', headSha)).not.toContain('later')
  })

  it('caps the file list, while changed_files still tells the truth', async () => {
    const { number } = await host.openPull(t.OWNER, t.NAME, { title: 'T', author: 'dave', files: Array.from({ length: host.MAX_FILES_LISTED + 5 }, (_, i) => ({ path: `docs/${i}.md`, add: ['x'] })) })
    const page = await host.listFiles(t.OWNER, t.NAME, number)
    expect(page.truncated).toBe(true)
    expect(page.files).toHaveLength(host.MAX_FILES_LISTED)
    expect((await host.getPull(t.OWNER, t.NAME, number)).changed_files).toBe(host.MAX_FILES_LISTED + 5)
  })
})
