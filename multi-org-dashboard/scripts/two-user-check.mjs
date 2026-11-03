#!/usr/bin/env node
/**
 * Scripted end-to-end check against the running stack (API + worker +
 * frontend, freshly seeded). Two or three users in separate browser
 * contexts, two orgs:
 *
 *   1. Switch orgs while a request for the old org is in flight.
 *   2. Change access while the affected user has the page open:
 *      flag turned off, role demoted, member removed (with another org
 *      left, and with none left).
 *   3. Deep links to pages and resources the user may not see.
 *   4. A background export with progress and a completion notification.
 *
 * It mutates data, so reseed afterwards: npm run db:seed -- --reset
 *
 * Usage: node multi-org-dashboard/scripts/two-user-check.mjs [baseUrl]
 *   (from the repo root, after `npm install` there for Playwright)
 */
import { chromium, request as playwrightRequest } from 'playwright'

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:5173'
const PASSWORD = 'password123'
const LUMEN_SUBJECTS = ['Where is my order?', 'Return a tent', 'hiking boots', 'Promo code', 'camp stove', 'sleeping bag', 'Gift card']
const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function api(email) {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE })
  const res = await ctx.post('/api/v1/auth/login', { data: { email, password: PASSWORD } })
  if (!res.ok()) throw new Error(`login ${email}: ${res.status()}`)
  return ctx
}

async function signIn(browser, email, path) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('console', (msg) => {
    if (msg.text().startsWith('[org-scope]')) page.__orgScope = [...(page.__orgScope ?? []), msg.text()]
  })
  await page.goto(`${BASE}/login?redirect=${encodeURIComponent(path)}`)
  await page.fill('input[name=email]', email)
  await page.fill('input[name=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
  return page
}

async function visible(page, selector, timeout = 8000) {
  return page
    .locator(selector)
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false)
}

async function rowSubjects(page) {
  return page.locator('[data-conversation]').allInnerTexts()
}

const browser = await chromium.launch()
try {
  const alice = await api('alice@example.com')
  const chloe = await api('chloe@example.com')
  const lumenMembers = (await (await alice.get('/api/v1/orgs/org_lumen/members')).json()).members
  const ben = lumenMembers.find((m) => m.displayName === 'Ben Okafor')
  const dev = lumenMembers.find((m) => m.displayName === 'Dev Mehta')

  // ── 1. Switch orgs mid-request ──────────────────────────────────────────
  {
    const page = await signIn(browser, 'alice@example.com', '/orgs/org_lumen')
    let aborted = 0
    page.on('requestfailed', (req) => {
      if (req.url().includes('/orgs/org_lumen/conversations')) aborted += 1
    })
    // Hold Lumen's conversation list for 2.5 s, as a slow query would.
    await page.route('**/api/v1/orgs/org_lumen/conversations?**', async (route) => {
      await new Promise((r) => setTimeout(r, 2500))
      await route.continue().catch(() => undefined)
    })
    await page.goto(`${BASE}/orgs/org_lumen/conversations?status=open`)
    await page.waitForTimeout(300) // the Lumen request is now in flight
    await page.click('[data-testid=org-switcher]')
    await page.click('[data-org=org_harbor]')
    await visible(page, '[data-conversation]')
    await page.waitForTimeout(3000) // well past the moment the held Lumen response would land
    const subjects = await rowSubjects(page)
    const leaked = subjects.filter((s) => LUMEN_SUBJECTS.some((l) => s.includes(l)))
    check('switch mid-request: URL and data belong to the new org', page.url().includes('/orgs/org_harbor/conversations') && subjects.length > 0)
    check('switch mid-request: no row from the old org is shown', leaked.length === 0, `${subjects.length} rows, ${leaked.length} from Lumen`)
    check('switch mid-request: the old org request was aborted', aborted > 0, `${aborted} aborted`)
    check('switch mid-request: filters from the old org were dropped', !page.url().includes('status=open'))
    await page.context().close()
  }

  // ── 2a. Flag turned off while the page is open ─────────────────────────
  const benPage = await signIn(browser, 'ben@example.com', '/orgs/org_lumen/prompts')
  check('editor sees the flagged prompt library', await visible(benPage, 'text=Prompt library'))
  await alice.put('/api/v1/orgs/org_lumen/features/prompt_library', { data: { enabled: true, roles: ['admin'] } })
  check('flag off: open page closes with an explanation', await visible(benPage, '[data-testid=access-changed]'))
  check('flag off: sidebar entry disappears', (await benPage.locator('[data-module=prompts]').count()) === 0)
  await alice.put('/api/v1/orgs/org_lumen/features/prompt_library', { data: { enabled: true, roles: ['admin', 'editor'] } })
  check('flag back on: module returns without a reload', await visible(benPage, '[data-module=prompts]'))

  // ── 2b. Role demoted while an edit form is open ────────────────────────
  await benPage.goto(`${BASE}/orgs/org_lumen/agents`)
  await benPage.click('td button:has-text("Order tracker")')
  await benPage.fill('#editor-instructions', 'Draft text Ben has not saved yet')
  await alice.patch(`/api/v1/orgs/org_lumen/members/${ben.id}`, { data: { role: 'viewer' } })
  check('demotion: open editor turns read-only and keeps the draft', await visible(benPage, '[data-testid=lost-write]'))
  check('demotion: draft text is still on screen', (await benPage.inputValue('#editor-instructions')) === 'Draft text Ben has not saved yet')
  check('demotion: "New agent" button is gone', (await benPage.locator('button:has-text("New agent")').count()) === 0)
  await benPage.goto(`${BASE}/orgs/org_lumen/exports`)
  check('demotion: exports (editor-only) now explains instead of loading', await visible(benPage, '[data-testid=forbidden]'))
  const forced = await benPage.evaluate(async () => (await fetch('/api/v1/orgs/org_lumen/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', model: 'relay-small', projectId: '00000000-0000-4000-8000-000000000000' }) })).status)
  check('demotion: the API refuses a write the UI no longer offers', forced === 403, `status ${forced}`)

  // ── 2c. Removed from one org, still a member of another ────────────────
  const invite = await (await chloe.post('/api/v1/orgs/org_harbor/invitations', { data: { email: 'ben@example.com', role: 'viewer' } })).json()
  const benApi = await api('ben@example.com')
  await benApi.post(`/api/v1/invitations/${invite.invitation.acceptUrl.split('/').pop()}/accept`)
  await benPage.goto(`${BASE}/orgs/org_lumen/conversations`)
  await visible(benPage, '[data-conversation]')
  const removal = await (await alice.delete(`/api/v1/orgs/org_lumen/members/${ben.id}`)).json()
  check('removal: open page is replaced by "no longer have access"', await visible(benPage, '[data-testid=org-revoked]'))
  check('removal: the user can switch to the org they still belong to', await visible(benPage, 'a:has-text("Harbor Health Co-op")'))
  check('removal: links they created were revoked', removal.linksRevoked >= 1, `linksRevoked=${removal.linksRevoked}`)
  const link = await (await playwrightRequest.newContext({ baseURL: BASE })).get('/api/v1/shared/demo-lumen-gear-sizing-link')
  check('removal: their share link now answers 410', link.status() === 410)
  check('removal: the Lumen manifest is 404 for them', (await benApi.get('/api/v1/orgs/org_lumen/manifest')).status() === 404)
  await benPage.context().close()

  // ── 2d. Removed from the only org: session ends ────────────────────────
  const devPage = await signIn(browser, 'dev@example.com', '/orgs/org_lumen/conversations')
  await visible(devPage, '[data-conversation]')
  await alice.delete(`/api/v1/orgs/org_lumen/members/${dev.id}`)
  await devPage.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 10_000 }).catch(() => undefined)
  check('last org removed: sent to sign-in', devPage.url().includes('/login'))
  check('last org removed: told why', await visible(devPage, 'text=Your access was removed'))
  await devPage.context().close()

  // ── 3. Deep links ──────────────────────────────────────────────────────
  const alicePage = await signIn(browser, 'alice@example.com', '/orgs/org_harbor/billing')
  check('deep link, role lacks it: 403 page explains the role', await visible(alicePage, 'text=You don\'t have access to Billing'))
  await alicePage.click('button:has-text("Request access")')
  check('deep link: request access is recorded', await visible(alicePage, 'text=Request sent to admins'))
  check('deep link: offers switching org', await visible(alicePage, 'a:has-text("Lumen Outfitters")'))
  await alicePage.goto(`${BASE}/orgs/org_harbor/prompts`)
  check('deep link, flag off: says it is not turned on', await visible(alicePage, 'text=isn\'t turned on here'))
  const harborConv = (await (await alice.get('/api/v1/orgs/org_harbor/conversations?limit=1')).json()).items[0].id
  await alicePage.goto(`${BASE}/orgs/org_lumen/conversations/${harborConv}`)
  check('deep link, other org\'s resource under this org: not found', await visible(alicePage, 'text=in a project you can\'t access'))
  await alicePage.goto(`${BASE}/orgs/org_doesnotexist/agents`)
  check('deep link, unknown org: neutral not-found page', await visible(alicePage, '[data-testid=org-not-found]'))

  // ── 4. Export with progress and notification ───────────────────────────
  await alicePage.goto(`${BASE}/orgs/org_lumen/conversations`)
  await alicePage.click('[data-testid=export-button]')
  check('export: progress indicator appears', await visible(alicePage, '[data-testid=exports-indicator]', 10_000))
  check('export: completion notification with download', await visible(alicePage, '[data-testid=toast]:has-text("Export ready")', 30_000))
  const href = await alicePage.locator('[data-testid=toast] a:has-text("Download")').first().getAttribute('href')
  const csv = await alicePage.evaluate(async (url) => {
    const r = await fetch(url)
    return { status: r.status, head: (await r.text()).split('\n')[0] }
  }, href)
  check('export: the file downloads as CSV', csv.status === 200 && csv.head.startsWith('id,started_at'), `status ${csv.status}`)
  await alicePage.context().close()
} catch (err) {
  check('script ran to completion', false, err.message)
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
