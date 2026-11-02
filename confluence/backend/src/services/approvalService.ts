import { pool } from './db.js';
import { logger } from './logger.js';
import { AccessError } from './accessService.js';
import { afterPageWrite } from './pageService.js';

interface Approval {
  id: string;
  page_id: string;
  requested_by: string;
  reviewed_by: string | null;
  status: string;
  comment: string | null;
  page_version: number | null;
  created_at: string;
  reviewed_at: string | null;
  requester_username?: string;
  reviewer_username?: string;
}

/**
 * Opens a review of the page at its current version. One pending request per
 * page is enforced by a partial unique index, so two simultaneous requests
 * cannot both succeed (the old check-then-insert could create duplicates).
 */
export async function requestApproval(
  pageId: string,
  requestedBy: string,
  pageVersion: number,
): Promise<Approval> {
  try {
    const result = await pool.query(
      `INSERT INTO page_approvals (page_id, requested_by, page_version) VALUES ($1, $2, $3) RETURNING *`,
      [pageId, requestedBy, pageVersion],
    );
    logger.info({ pageId, requestedBy, pageVersion }, 'Approval requested');
    return result.rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new AccessError(409, 'An approval request is already pending for this page');
    }
    throw err;
  }
}

/**
 * Approves or rejects a pending request. The caller has already checked that
 * the reviewer administers the page's space. Two rules make the approval mean
 * something:
 * - Nobody reviews their own request.
 * - An approval covers the version that was requested. If the page changed
 *   since, approving would publish content nobody reviewed, so it is refused
 *   and the author must request again.
 * Approving publishes the page, then reindexes it and drops its cached rows.
 */
export async function reviewApproval(
  approvalId: string,
  reviewedBy: string,
  status: 'approved' | 'rejected',
  comment?: string,
): Promise<Approval> {
  const client = await pool.connect();
  let approval: Approval;
  let spaceId: string | null = null;
  try {
    await client.query('BEGIN');

    const found = await client.query(
      `SELECT pa.*, p.version AS current_version, p.space_id
       FROM page_approvals pa JOIN pages p ON p.id = pa.page_id
       WHERE pa.id = $1 AND pa.status = 'pending'
       FOR UPDATE OF pa, p`,
      [approvalId],
    );
    const pending = found.rows[0];
    if (!pending) throw new AccessError(404, 'Approval not found or already reviewed');
    if (pending.requested_by === reviewedBy) {
      throw new AccessError(403, 'You cannot review your own approval request');
    }
    if (
      status === 'approved' &&
      pending.page_version !== null &&
      pending.page_version !== pending.current_version
    ) {
      throw new AccessError(
        409,
        `The page changed after this request (requested at version ${pending.page_version}, now ${pending.current_version}). Ask the author to request approval again.`,
      );
    }

    const result = await client.query(
      `UPDATE page_approvals
       SET reviewed_by = $1, status = $2, comment = $3, reviewed_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [reviewedBy, status, comment || null, approvalId],
    );
    approval = result.rows[0];

    if (status === 'approved') {
      await client.query(
        "UPDATE pages SET status = 'published', updated_at = NOW() WHERE id = $1",
        [approval.page_id],
      );
      spaceId = pending.space_id;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (spaceId) {
    await afterPageWrite(spaceId, approval.page_id);
    logger.info({ approvalId, pageId: approval.page_id }, 'Page approved and published');
  } else {
    logger.info({ approvalId, pageId: approval.page_id }, 'Page approval rejected');
  }
  return approval;
}

/** All approval records for a page, with requester and reviewer names. */
export async function getPageApprovals(pageId: string): Promise<Approval[]> {
  const result = await pool.query(
    `SELECT pa.*,
            req.username as requester_username,
            rev.username as reviewer_username
     FROM page_approvals pa
     JOIN users req ON req.id = pa.requested_by
     LEFT JOIN users rev ON rev.id = pa.reviewed_by
     WHERE pa.page_id = $1
     ORDER BY pa.created_at DESC`,
    [pageId],
  );
  return result.rows;
}

/**
 * Pending approvals relevant to the caller: requests they can review (in
 * spaces they administer, not their own) and requests they made. `can_review`
 * says which is which.
 */
export async function getPendingApprovals(
  userId: string,
  adminSpaceIds: string[],
): Promise<Approval[]> {
  const result = await pool.query(
    `SELECT pa.*,
            p.title as page_title,
            p.slug as page_slug,
            s.key as space_key,
            req.username as requester_username,
            (p.space_id = ANY($2::uuid[]) AND pa.requested_by <> $1) AS can_review
     FROM page_approvals pa
     JOIN pages p ON p.id = pa.page_id
     JOIN spaces s ON s.id = p.space_id
     JOIN users req ON req.id = pa.requested_by
     WHERE pa.status = 'pending'
       AND (p.space_id = ANY($2::uuid[]) OR pa.requested_by = $1)
     ORDER BY pa.created_at DESC`,
    [userId, adminSpaceIds],
  );
  return result.rows;
}
