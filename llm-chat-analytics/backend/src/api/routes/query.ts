/**
 * Dashboard query endpoints. Each widget has its own GET whose query string is
 * the canonical query; the response echoes the canonical string so the client
 * can drop any response that no longer matches what it is showing.
 *
 * A request that the browser aborts closes the connection; the handler passes
 * an AbortSignal to ClickHouse so the superseded query stops there too.
 */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { requireAuth, requireOrgAccess, type OrgAccess, type Permission } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { breakdown, cached, drilldown, latency, overview, readWatermarks, series, watermarkFor, type QueryContext } from '../services/query-service.js'
import { canonicalString, dimensionSchema, parseFilters } from '../services/query-spec.js'

export const queryRouter = Router()
queryRouter.use(requireAuth)

function abortOnClose(req: Request, res: Response): AbortSignal {
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) controller.abort()
  })
  req.on('aborted', () => controller.abort())
  return controller.signal
}

async function context(req: Request, res: Response, permission: Permission = 'metrics:read'): Promise<QueryContext & { access: OrgAccess }> {
  const org = typeof req.query.org === 'string' ? req.query.org : ''
  if (!org) throw new HttpError(400, 'MISSING_ORG', 'org is required')
  const access = await requireOrgAccess(req.user!, org, permission)
  const signal = abortOnClose(req, res)
  if (config.queryDelayMs > 0) await simulateSlowWarehouse(signal)
  return { access, filters: parseFilters(req.query, access.timeZone), signal }
}

/** QUERY_DELAY_MS: lets you watch the client abort superseded requests and ignore late answers. */
function simulateSlowWarehouse(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.random() * config.queryDelayMs)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new HttpError(499, 'CLIENT_CLOSED', 'Request aborted by the client'))
    })
  })
}

/** Seals a window for caching once it ends before the slowest stream's watermark. */
async function sealedBefore(): Promise<number | null> {
  return watermarkFor(await readWatermarks(), ['client', 'server'])
}

const metricParam = z.object({ metric: z.string().min(1).max(64) })

queryRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const ctx = await context(req, res)
    const result = await cached('overview', ctx, {}, await sealedBefore(), () => overview(ctx))
    res.json({ widget: 'overview', echo: result.echo, cache: result.cache, ...result.data })
  }),
)

queryRouter.get(
  '/series',
  asyncHandler(async (req, res) => {
    const ctx = await context(req, res)
    const { metric } = metricParam.parse(req.query)
    const result = await cached('series', ctx, { metric }, await sealedBefore(), () => series(ctx, metric))
    res.json({ widget: 'series', echo: result.echo, cache: result.cache, ...result.data })
  }),
)

queryRouter.get(
  '/latency',
  asyncHandler(async (req, res) => {
    const ctx = await context(req, res)
    const result = await cached('latency', ctx, {}, await sealedBefore(), () => latency(ctx))
    res.json({ widget: 'latency', echo: result.echo, cache: result.cache, ...result.data })
  }),
)

queryRouter.get(
  '/breakdown',
  asyncHandler(async (req, res) => {
    const ctx = await context(req, res)
    const { metric } = metricParam.parse(req.query)
    const dim = dimensionSchema.parse(req.query.dim)
    const result = await cached('breakdown', ctx, { metric, dim }, await sealedBefore(), () => breakdown(ctx, metric, dim))
    res.json({ widget: 'breakdown', echo: result.echo, cache: result.cache, ...result.data })
  }),
)

const drillSchema = z.object({
  metric: z.string().min(1).max(64),
  bucket: z.string().datetime({ offset: true }).transform((s) => Date.parse(s)),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

queryRouter.get(
  '/drilldown',
  asyncHandler(async (req, res) => {
    const ctx = await context(req, res, 'drilldown:read')
    const { metric, bucket, offset, limit } = drillSchema.parse(req.query)
    // Not cached: it is opened rarely and must reflect the raw table right now.
    const data = await drilldown(ctx, metric, bucket, offset, limit)
    res.json({ widget: 'drilldown', echo: canonicalString(ctx.filters, { metric }), ...data })
  }),
)
