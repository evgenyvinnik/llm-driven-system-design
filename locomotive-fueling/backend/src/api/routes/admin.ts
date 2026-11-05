/**
 * Prices, model parameters and the mock vendor's fault switches.
 * Fuel desk can read prices and drive the vendor faults (to rehearse
 * failures); only admins change prices and parameters.
 * @module api/routes/admin
 */
import { Router } from 'express'
import { z } from 'zod'
import { DEFAULT_PARAMS } from '../../domain/params.js'
import { requireAuth, requireRole } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { loadFuelOptions, loadLocations, loadParams } from '../../shared/repo.js'
import { simNow } from '../../shared/sim-clock.js'
import { enqueuePlan } from '../../shared/triggers.js'
import { changePrice } from '../services/prices.js'

export const adminRouter = Router()
adminRouter.use(requireAuth)

adminRouter.get(
  '/fuel-options',
  requireRole('fuel_desk'),
  asyncHandler(async (_req, res) => {
    const [options, locations, history] = await Promise.all([
      loadFuelOptions(),
      loadLocations(),
      pool.query(
        `SELECT option_id AS "optionId", price_per_gal::float AS "pricePerGal", effective_at AS "effectiveAt", changed_by AS "changedBy", note
           FROM fuel_price_history ORDER BY id DESC LIMIT 40`,
      ),
    ])
    res.json({
      options: options.map((o) => ({ ...o, locationName: locations.get(o.locationId)?.name ?? o.locationId, state: locations.get(o.locationId)?.state ?? '' })),
      history: history.rows,
    })
  }),
)

adminRouter.put(
  '/admin/fuel-options/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = z.object({ pricePerGal: z.number().positive().max(20).optional(), active: z.boolean().optional(), note: z.string().max(200).optional() }).parse(req.body)
    if (body.pricePerGal === undefined && body.active === undefined) throw new HttpError(422, 'EMPTY_PATCH', 'Nothing to change')
    const result = await changePrice(req.params.id, body, req.user!.username, body.note ?? null, await simNow())
    res.json(result)
  }),
)

const paramsSchema = z
  .object({
    reservePct: z.number().min(0.02).max(0.5),
    reserveMinGal: z.number().min(0).max(2000),
    safetyMarginPct: z.number().min(0).max(0.5),
    safetyKeepSlackPct: z.number().min(0).max(0.2),
    acceptedChangeCost: z.number().min(0).max(20000),
    optimizerBudgetMs: z.number().int().min(0).max(10000),
    stalenessMarginPerHour: z.number().min(0).max(0.2),
    maxExtraMargin: z.number().min(0).max(0.5),
    reservationGraceHours: z.number().min(0).max(24),
    delayCostPerHour: z.number().min(0).max(10000),
    stopPenalty: z.number().min(0).max(5000),
    hysteresisAbs: z.number().min(0).max(10000),
    hysteresisPct: z.number().min(0).max(0.5),
    deviationBand: z.number().min(0.02).max(1),
    orderWindowHours: z.number().min(1).max(48),
    valueRemainingFuel: z.boolean(),
    terminalDiscountPerGal: z.number().min(0).max(2),
    gridGal: z.number().int().min(10).max(200),
  })
  .partial()

adminRouter.get(
  '/admin/params',
  requireRole('fuel_desk'),
  asyncHandler(async (_req, res) => {
    res.json({ params: await loadParams(), defaults: DEFAULT_PARAMS })
  }),
)

adminRouter.put(
  '/admin/params',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const patch = paramsSchema.parse(req.body)
    for (const [key, value] of Object.entries(patch)) {
      await pool.query(
        `INSERT INTO model_params (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(value), req.user!.username],
      )
    }
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM trains WHERE status = 'running'`)
    for (const r of rows) await enqueuePlan(r.id, 'param_change', Object.keys(patch).join(', '))
    res.json({ params: await loadParams() })
  }),
)

/** Proxy to the mock vendor's fault switches, so failures can be rehearsed from the UI. */
adminRouter.get(
  '/admin/vendor',
  requireRole('fuel_desk'),
  asyncHandler(async (_req, res) => {
    const r = await fetch(`${config.vendorUrl}/vendor/v1/admin/settings`, { signal: AbortSignal.timeout(2000) }).catch(() => null)
    if (!r?.ok) throw new HttpError(502, 'VENDOR_UNREACHABLE', 'Mock vendor is not reachable')
    res.json(await r.json())
  }),
)

adminRouter.put(
  '/admin/vendor',
  requireRole('fuel_desk'),
  asyncHandler(async (req, res) => {
    const r = await fetch(`${config.vendorUrl}/vendor/v1/admin/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(2000),
    }).catch(() => null)
    if (!r) throw new HttpError(502, 'VENDOR_UNREACHABLE', 'Mock vendor is not reachable')
    res.status(r.status).json(await r.json())
  }),
)

adminRouter.get(
  '/network',
  asyncHandler(async (_req, res) => {
    const locations = await loadLocations()
    res.json({ locations: [...locations.values()] })
  }),
)
