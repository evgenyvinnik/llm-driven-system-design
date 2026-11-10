import { describe, expect, it } from 'vitest'
import { normalizeEvent, type NormalizedEvent } from './events.js'

const repo = { full_name: 'acme/web-app' }
const push = (over: object = {}) => ({ ref: 'refs/heads/main', after: 'a'.repeat(40), repository: repo, sender: { login: 'alice' }, ...over })
const pr = (head: object, action = 'opened') => ({
  action,
  repository: repo,
  sender: { login: 'mallory' },
  pull_request: { number: 7, head: { sha: 'b'.repeat(40), ref: 'patch-1', ...head }, base: { ref: 'main' } },
})

describe('normalizeEvent', () => {
  it('reads a push', () => {
    const e = normalizeEvent('push', push()) as NormalizedEvent
    expect(e).toMatchObject({ eventType: 'push', branch: 'main', filterBranch: 'main', isFork: false, sender: 'alice' })
  })

  it('ignores tags and branch deletions', () => {
    expect(normalizeEvent('push', push({ ref: 'refs/tags/v1' }))).toHaveProperty('ignored')
    expect(normalizeEvent('push', push({ after: '0'.repeat(40) }))).toHaveProperty('ignored')
  })

  it('ignores events it does not handle', () => {
    expect(normalizeEvent('issues', {})).toHaveProperty('ignored')
  })

  it('a pull request from the same repository is not a fork', () => {
    const e = normalizeEvent('pull_request', pr({ repo: { full_name: 'acme/web-app', fork: false } })) as NormalizedEvent
    expect(e.isFork).toBe(false)
    expect(e.prNumber).toBe(7)
  })

  it('a pull request from another repository is a fork', () => {
    expect((normalizeEvent('pull_request', pr({ repo: { full_name: 'mallory/web-app', fork: true } })) as NormalizedEvent).isFork).toBe(true)
  })

  it('believes either signal: a differing head repository counts even when fork is false', () => {
    expect((normalizeEvent('pull_request', pr({ repo: { full_name: 'mallory/web-app', fork: false } })) as NormalizedEvent).isFork).toBe(true)
  })

  it('fails closed when the head repository is gone (a deleted fork)', () => {
    expect((normalizeEvent('pull_request', pr({ repo: null })) as NormalizedEvent).isFork).toBe(true)
    expect((normalizeEvent('pull_request', pr({})) as NormalizedEvent).isFork).toBe(true)
  })

  it('a fork naming its branch main does not get the branch "main"', () => {
    const e = normalizeEvent('pull_request', pr({ ref: 'main', repo: { full_name: 'mallory/web-app', fork: true } })) as NormalizedEvent
    expect(e.branch).toBe('pull/7/merge')
    expect(e.filterBranch).toBe('main')
  })

  it('ignores pull request actions that do not change code', () => {
    expect(normalizeEvent('pull_request', pr({ repo: { full_name: 'acme/web-app' } }, 'labeled'))).toHaveProperty('ignored')
  })
})
