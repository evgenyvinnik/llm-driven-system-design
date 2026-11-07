/**
 * Screenshots of the demo storefront (the repo's screenshot harness drives one
 * frontend per project, and this is the second one). Uses the repo root's
 * Playwright WebKit and the SDK's own evaluation core to pick a visitor who is
 * in treatment for all three experiments, so every treatment is on camera.
 *
 *   cd experimentation-platform/backend
 *   npx tsx ../tests/demo-screenshots.mts            # DEMO_URL defaults to http://localhost:5180
 *
 * Writes screenshots/11-… to screenshots/16-…: product page with the exposure logged, the
 * rarely opened Rewards tab, the deliberately broken cart banner (assigned, never exposed),
 * signed in with the stable id kept, an offline reload from the cached snapshot, and an
 * offline cold start on coded defaults.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { evaluate, type Snapshot } from '../sdk/src/core/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const require = createRequire(new URL('../../package.json', import.meta.url))
const { webkit } = require('playwright') as typeof import('playwright')

const BASE = process.env.DEMO_URL ?? 'http://localhost:5180'
const CLIENT_KEY = process.env.CLIENT_KEY ?? 'cli_prod_4f9a2c7e1b3d5a60'
const OUT = `${here}../screenshots`

async function pickVisitor(): Promise<string> {
  const snapshot = (await (await fetch(`${BASE}/sdk/v1/snapshot`, { headers: { 'X-Client-Key': CLIENT_KEY } })).json()) as Snapshot
  for (let i = 0; i < 10_000; i++) {
    const id = `anon_demo-visitor-${i}`
    const ctx = { anonymousId: id, stableId: id, attributes: { country: 'US', plan: 'guest', platform: 'web' } }
    if (['checkout_cta', 'rewards_teaser', 'shipping_banner'].every((k) => evaluate(snapshot, k, ctx).variant === 'treatment')) return id
  }
  throw new Error('no all-treatment visitor found')
}

const browser = await webkit.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const page = await context.newPage()
page.on('pageerror', (e) => console.log('page error:', e.message))
const visitor = await pickVisitor()
await context.addInitScript((id) => {
  if (!localStorage.getItem('exp:anonymous-id')) localStorage.setItem('exp:anonymous-id', id)
}, visitor)

async function shot(name: string, path: string | null, waitFor: string, extraMs = 1200) {
  if (path) await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(waitFor, { timeout: 15_000 })
  await page.waitForTimeout(extraMs)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`saved ${name}.png`)
}

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector("[aria-label='Products']")
await page.waitForTimeout(1500)
await shot('11-demo-product', '/product/kettle', "button[data-variant='treatment']", 2500)
await shot('12-demo-rewards-tab', '/rewards', "[data-page='rewards'] [data-variant='treatment']", 2000)
await page.click("button[data-variant='treatment']").catch(() => undefined)
await page.goto(`${BASE}/product/grinder`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector("button[data-variant='treatment']")
await page.click("button[data-variant='treatment']")
await shot('13-demo-cart-broken-exposure', null, "[data-page='cart'] [data-variant='treatment']", 2000)
await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector("[data-page='signin']")
await page.fill("input[name='username']", 'carol')
await page.fill("input[name='password']", 'password123')
await page.click("button[type='submit']")
await page.waitForURL((u) => u.pathname === '/')
await shot('14-demo-signed-in', '/product/kettle', "button[data-variant='treatment']", 2000)
// Offline: every SDK request fails; the reload starts from the last known good snapshot.
await page.click('text=Reload offline')
await page.waitForLoadState('domcontentloaded')
await shot('15-demo-offline-cached', null, "[data-testid='snapshot']", 2500)
// Offline with the cache cleared: a cold start on the coded defaults.
await page.click('text=Clear SDK cache (reload)')
await page.waitForLoadState('domcontentloaded')
await shot('16-demo-offline-defaults', '/product/kettle', "button[data-variant]", 2500)
await page.click('text=Go back online (reload)')
await page.waitForTimeout(1500)
await browser.close()
