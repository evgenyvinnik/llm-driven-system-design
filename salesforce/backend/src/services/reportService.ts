import { pool } from './db.js';
import { logger } from './logger.js';

export interface PipelineStage {
  stage: string;
  count: number;
  totalAmountCents: number;
}

export interface RevenueByMonth {
  month: string;
  totalAmountCents: number;
  count: number;
}

export interface LeadsBySource {
  source: string;
  count: number;
}

/** Returns opportunity counts and total amounts grouped by pipeline stage with ordered stage sorting. */
export async function getPipelineReport(userId?: string): Promise<PipelineStage[]> {
  try {
    const params: string[] = [];
    let whereClause = '';
    if (userId) {
      params.push(userId);
      whereClause = 'WHERE owner_id = $1';
    }

    const result = await pool.query(
      `SELECT stage, COUNT(*) as count, COALESCE(SUM(amount_cents), 0) as total_amount_cents
       FROM opportunities
       ${whereClause}
       GROUP BY stage
       ORDER BY CASE stage
         WHEN 'Prospecting' THEN 1
         WHEN 'Qualification' THEN 2
         WHEN 'Needs Analysis' THEN 3
         WHEN 'Proposal' THEN 4
         WHEN 'Negotiation' THEN 5
         WHEN 'Closed Won' THEN 6
         WHEN 'Closed Lost' THEN 7
         ELSE 8
       END`,
      params,
    );

    return result.rows.map((row) => ({
      stage: row.stage,
      count: parseInt(row.count),
      totalAmountCents: parseInt(row.total_amount_cents),
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to fetch pipeline report');
    throw err;
  }
}

/**
 * Returns monthly closed-won revenue totals for the specified period.
 *
 * A deal is booked in the month it closed (closed_at, stamped by the server on
 * entering Closed Won). This used to group by updated_at, so editing the
 * description of a deal won in March moved its revenue to the current month.
 */
export async function getRevenueReport(
  userId?: string,
  months: number = 12,
): Promise<RevenueByMonth[]> {
  try {
    const params: (string | number)[] = [months];
    let ownerFilter = '';
    if (userId) {
      params.push(userId);
      ownerFilter = `AND owner_id = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT
         TO_CHAR(DATE_TRUNC('month', closed_at), 'YYYY-MM') as month,
         COALESCE(SUM(amount_cents), 0) as total_amount_cents,
         COUNT(*) as count
       FROM opportunities
       WHERE stage = 'Closed Won'
         AND closed_at >= NOW() - make_interval(months => $1::int)
         ${ownerFilter}
       GROUP BY DATE_TRUNC('month', closed_at)
       ORDER BY month`,
      params,
    );

    return result.rows.map((row) => ({
      month: row.month,
      totalAmountCents: parseInt(row.total_amount_cents),
      count: parseInt(row.count),
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to fetch revenue report');
    throw err;
  }
}

/** Returns lead counts grouped by acquisition source, sorted by frequency descending. */
export async function getLeadsBySourceReport(userId?: string): Promise<LeadsBySource[]> {
  try {
    const params: string[] = [];
    let whereClause = '';
    if (userId) {
      params.push(userId);
      whereClause = 'WHERE owner_id = $1';
    }

    const result = await pool.query(
      `SELECT COALESCE(source, 'Unknown') as source, COUNT(*) as count
       FROM leads
       ${whereClause}
       GROUP BY source
       ORDER BY count DESC`,
      params,
    );

    return result.rows.map((row) => ({
      source: row.source,
      count: parseInt(row.count),
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to fetch leads by source report');
    throw err;
  }
}
