/**
 * The demo storefront's own tiny backend: shopper sign-in and a product list.
 *
 * Sign-in is where the anonymous → signed-in identity policy runs: the shop
 * (a trusted server holding the server key) links the visitor's anonymous id
 * to the user and returns the stable id the SDK must bucket `user`
 * experiments by from now on.
 * @module api/routes/shop
 */
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { Router } from 'express'
import { z } from 'zod'
import { keys, redis } from '../../shared/cache.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { linkIdentity, resolveStableId } from '../../services/identity-service.js'
import { limitLogins } from './auth.js'

export const shopRouter = Router()

/** The environment the storefront runs against. */
const SHOP_ENV = process.env.SHOP_ENVIRONMENT || 'prod'

interface Shopper {
  id: string
  username: string
  displayName: string
  country: string | null
  plan: string | null
  orgId: string | null
}

export const PRODUCTS = [
  { id: 'kettle', name: 'Gooseneck Kettle', price: 89, tone: 'from-amber-200 to-orange-300', blurb: 'Precise pour, 0.9 L, holds temperature for an hour.' },
  { id: 'grinder', name: 'Burr Grinder', price: 149, tone: 'from-stone-200 to-stone-400', blurb: '40 grind settings, conical steel burrs.' },
  { id: 'dripper', name: 'Ceramic Dripper', price: 32, tone: 'from-sky-100 to-sky-300', blurb: 'Spiral ribs for an even draw-down.' },
  { id: 'beans', name: 'House Blend, 1 kg', price: 28, tone: 'from-yellow-700 to-amber-900', blurb: 'Chocolate, red apple, brown sugar.' },
  { id: 'scale', name: 'Brew Scale', price: 59, tone: 'from-zinc-200 to-zinc-400', blurb: '0.1 g resolution with a built-in timer.' },
  { id: 'mugs', name: 'Stoneware Mugs (2)', price: 36, tone: 'from-rose-100 to-rose-300', blurb: 'Hand-glazed, 350 ml.' },
]

async function loadShopper(sessionId: string | undefined): Promise<Shopper | null> {
  if (!sessionId) return null
  const raw = await redis.get(keys.shopSession(sessionId))
  return raw ? (JSON.parse(raw) as Shopper) : null
}

const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200), anonymousId: z.string().min(1).max(128) }).strict()

shopRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    await limitLogins(req.ip ?? 'unknown')
    const { username, password, anonymousId } = loginSchema.parse(req.body)
    const { rows } = await pool.query<{ id: string; username: string; display_name: string; role: string; password_hash: string; country: string | null; plan: string | null; org_id: string | null }>(
      'SELECT id, username, display_name, role, password_hash, country, plan, org_id FROM users WHERE username = $1',
      [username.toLowerCase()],
    )
    const row = rows[0]
    if (!row || row.role !== 'shopper' || !(await bcrypt.compare(password, row.password_hash))) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password')
    }
    const shopper: Shopper = { id: row.id, username: row.username, displayName: row.display_name, country: row.country, plan: row.plan, orgId: row.org_id }
    const { stableId, created } = await linkIdentity(SHOP_ENV, shopper.id, anonymousId)
    const sessionId = randomBytes(32).toString('base64url')
    await redis.set(keys.shopSession(sessionId), JSON.stringify(shopper), 'EX', config.sessionTtlSeconds)
    res.cookie(config.shopCookie, sessionId, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: config.sessionTtlSeconds * 1000, path: '/' })
    res.json({ user: shopper, stableId, aliasCreated: created })
  }),
)

shopRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const id = req.cookies?.[config.shopCookie]
    if (typeof id === 'string') await redis.del(keys.shopSession(id))
    res.clearCookie(config.shopCookie, { path: '/' })
    res.status(204).end()
  }),
)

shopRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const shopper = await loadShopper(req.cookies?.[config.shopCookie])
    if (!shopper) return void res.json({ user: null, stableId: null })
    res.json({ user: shopper, stableId: await resolveStableId(SHOP_ENV, shopper.id) })
  }),
)

shopRouter.get('/products', (_req, res) => {
  res.json({ products: PRODUCTS })
})

const FREE_SHIPPING_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="120" height="40" rx="8" fill="#d1fae5"/>' +
  '<path d="M14 12h34v16H14zM48 18h12l8 6v4H48" fill="none" stroke="#047857" stroke-width="3"/>' +
  '<circle cx="24" cy="30" r="4" fill="#047857"/><circle cx="58" cy="30" r="4" fill="#047857"/>' +
  '<text x="74" y="25" font-family="sans-serif" font-size="11" fill="#047857">$0</text></svg>'

/**
 * The cart banner's illustration, standing in for a slow third-party CDN: it
 * answers after SHOP_ASSET_DELAY_MS (default 3.5 s). The shipping_banner
 * treatment deliberately logs its exposure from this image's onLoad, so
 * visitors who leave or check out sooner are never logged (the SRM demo).
 */
shopRouter.get('/assets/free-shipping.svg', (_req, res) => {
  const delay = Number(process.env.SHOP_ASSET_DELAY_MS ?? 3500)
  setTimeout(() => res.type('image/svg+xml').set('Cache-Control', 'no-store').send(FREE_SHIPPING_SVG), delay)
})
