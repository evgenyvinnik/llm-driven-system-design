import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { reportLimiter } from '../services/rateLimiter.js';
import { getPipelineReport, getRevenueReport, getLeadsBySourceReport } from '../services/reportService.js';
import { callerFrom, isAdmin, respondError } from '../services/accessPolicy.js';

const router = Router();

/**
 * Whose records a report aggregates. `?all=true` used to give any signed-in
 * user the whole organization's pipeline, revenue and lead mix; aggregates are
 * held to the same visibility rule as the rows they sum, so only admins get the
 * org-wide view and everyone else gets their own records. The response says
 * which scope was applied, so the UI can label it.
 */
function reportScope(req: Request): { ownerId?: string; scope: 'org' | 'own' } {
  const caller = callerFrom(req);
  if (req.query.all === 'true' && isAdmin(caller)) return { scope: 'org' };
  return { ownerId: caller.userId, scope: 'own' };
}

// GET /api/reports/pipeline
router.get('/pipeline', requireAuth, reportLimiter, async (req: Request, res: Response) => {
  try {
    const { ownerId, scope } = reportScope(req);
    const pipeline = await getPipelineReport(ownerId);
    res.json({ pipeline, scope });
  } catch (err) {
    respondError(res, err, 'Failed to fetch pipeline report');
  }
});

// GET /api/reports/revenue
router.get('/revenue', requireAuth, reportLimiter, async (req: Request, res: Response) => {
  try {
    const { ownerId, scope } = reportScope(req);
    // Clamped: a non-numeric value used to reach Postgres as 'NaN months'.
    const requested = parseInt(String(req.query.months ?? '12'), 10);
    const months = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 60) : 12;
    const revenue = await getRevenueReport(ownerId, months);
    res.json({ revenue, scope });
  } catch (err) {
    respondError(res, err, 'Failed to fetch revenue report');
  }
});

// GET /api/reports/leads
router.get('/leads', requireAuth, reportLimiter, async (req: Request, res: Response) => {
  try {
    const { ownerId, scope } = reportScope(req);
    const leads = await getLeadsBySourceReport(ownerId);
    res.json({ leads, scope });
  } catch (err) {
    respondError(res, err, 'Failed to fetch leads report');
  }
});

export default router;
