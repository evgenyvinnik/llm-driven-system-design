/**
 * Endpoint reads with health, scoped to one org.
 * @module api/services/endpoints
 */
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { notFound, HttpError } from '../../shared/errors.js'
import { resolveTarget, SsrfError } from '../../delivery/ssrf.js'
import { systemLookup } from '../../delivery/sender.js'
import { toEndpointDto, type EndpointRow } from './dto.js'

interface HealthRow extends EndpointRow {
  in_flight: number
  waiting: number
  failed: number
  delivered: number
  attempts_1h: number
  ok_1h: number
  p50_ms: number | null
  p95_ms: number | null
}

const HEALTH_SQL = `
  SELECT e.*,
         COALESCE(c.in_flight, 0)::int AS in_flight, COALESCE(c.waiting, 0)::int AS waiting,
         COALESCE(c.failed, 0)::int AS failed, COALESCE(c.delivered, 0)::int AS delivered,
         COALESCE(s.total, 0)::int AS attempts_1h, COALESCE(s.ok, 0)::int AS ok_1h, s.p50_ms, s.p95_ms
    FROM endpoints e
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE state = 'in_flight') AS in_flight,
             count(*) FILTER (WHERE state IN ('queued', 'scheduled')) AS waiting,
             count(*) FILTER (WHERE state = 'failed') AS failed,
             count(*) FILTER (WHERE state = 'delivered') AS delivered
        FROM deliveries d WHERE d.endpoint_id = e.id
    ) c ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS total, count(*) FILTER (WHERE a.outcome = 'delivered') AS ok,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY a.latency_ms) AS p50_ms,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY a.latency_ms) AS p95_ms
        FROM attempts a JOIN deliveries d ON d.id = a.delivery_id
       WHERE d.endpoint_id = e.id AND a.started_at > now() - interval '1 hour' AND a.outcome <> 'lost'
    ) s ON true`

function withHealth(r: HealthRow) {
  return {
    ...toEndpointDto(r),
    health: {
      inFlight: r.in_flight,
      waiting: r.waiting,
      failed: r.failed,
      delivered: r.delivered,
      attempts1h: r.attempts_1h,
      successRate1h: r.attempts_1h > 0 ? r.ok_1h / r.attempts_1h : null,
      p50Ms: r.p50_ms === null ? null : Math.round(r.p50_ms),
      p95Ms: r.p95_ms === null ? null : Math.round(r.p95_ms),
      probing: r.consecutive_failures >= config.delivery.probeAfterFailures,
      effectiveConcurrency: r.consecutive_failures >= config.delivery.probeAfterFailures ? 1 : r.max_concurrency,
    },
  }
}

export type EndpointWithHealth = ReturnType<typeof withHealth>

export async function listEndpoints(orgId: string): Promise<EndpointWithHealth[]> {
  const { rows } = await pool.query<HealthRow>(`${HEALTH_SQL} WHERE e.org_id = $1 ORDER BY e.created_at`, [orgId])
  return rows.map(withHealth)
}

export async function getEndpoint(orgId: string, id: string): Promise<EndpointWithHealth> {
  const { rows } = await pool.query<HealthRow>(`${HEALTH_SQL} WHERE e.org_id = $1 AND e.id = $2`, [orgId, id])
  if (!rows[0]) throw notFound('Endpoint')
  return withHealth(rows[0])
}

/** Raw row, org-checked: every write starts here so one org can never touch another's endpoint. */
export async function endpointRow(orgId: string, id: string): Promise<EndpointRow> {
  const { rows } = await pool.query<EndpointRow>('SELECT * FROM endpoints WHERE id = $1 AND org_id = $2', [id, orgId])
  if (!rows[0]) throw notFound('Endpoint')
  return rows[0]
}

/**
 * Registration-time URL check. It rejects obvious mistakes early (bad URL,
 * a name that already resolves to a private address), but it is NOT the
 * security boundary: DNS can change after registration, so workers vet again
 * on every connection. A name that doesn't resolve yet is accepted with a warning.
 */
export async function vetUrlForRegistration(url: string): Promise<{ warning: string | null }> {
  try {
    await resolveTarget(url, { allowHttp: config.ssrf.allowHttp, allowlist: config.ssrf.allowlist, lookup: systemLookup })
    return { warning: null }
  } catch (err) {
    if (err instanceof SsrfError) {
      if (err.errorClass === 'dns_error') return { warning: `${err.message}. Deliveries will fail until the name resolves.` }
      throw new HttpError(422, err.errorClass === 'ssrf_blocked' ? 'SSRF_BLOCKED' : 'INVALID_URL', err.message)
    }
    throw err
  }
}
