import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../services/db.js';
import {
  requestApproval,
  reviewApproval,
  getPageApprovals,
  getPendingApprovals,
} from '../services/approvalService.js';
import {
  AccessError,
  adminSpaceIds,
  callerFrom,
  isUuid,
  requirePage,
  respondError,
} from '../services/accessService.js';

const router = Router();

// Pending approvals the caller can review, plus their own open requests
router.get('/pending', requireAuth, async (req: Request, res: Response) => {
  try {
    const caller = callerFrom(req);
    const approvals = await getPendingApprovals(caller.userId!, await adminSpaceIds(caller));
    res.json({ approvals });
  } catch (err) {
    respondError(res, err, 'Failed to get pending approvals');
  }
});

// Approvals for a page (anyone who can see the page)
router.get('/page/:pageId', async (req: Request, res: Response) => {
  try {
    const { access } = await requirePage(req.params.pageId, callerFrom(req), 'view');
    const approvals = await getPageApprovals(req.params.pageId);
    res.json({
      approvals,
      // Lets the UI offer Approve/Reject only to someone allowed to use them.
      canReview: access.canAdmin,
    });
  } catch (err) {
    respondError(res, err, 'Failed to get page approvals');
  }
});

// Request approval of the page's current version (editors of the space)
router.post('/request', requireAuth, async (req: Request, res: Response) => {
  try {
    const { pageId } = req.body;
    if (!pageId) {
      res.status(400).json({ error: 'Page ID is required' });
      return;
    }

    const { page } = await requirePage(pageId, callerFrom(req), 'edit');
    const approval = await requestApproval(page.id, req.session.userId!, Number(page.version));
    res.status(201).json({ approval });
  } catch (err) {
    respondError(res, err, 'Failed to request approval');
  }
});

// Approve or reject (admins of the page's space, never the requester)
router.post('/:id/review', requireAuth, async (req: Request, res: Response) => {
  try {
    const { status, comment } = req.body;

    if (!status || !['approved', 'rejected'].includes(status)) {
      res.status(400).json({ error: 'Status must be "approved" or "rejected"' });
      return;
    }
    if (!isUuid(req.params.id)) throw new AccessError(404, 'Approval not found');

    const found = await pool.query('SELECT page_id FROM page_approvals WHERE id = $1', [req.params.id]);
    if (!found.rows[0]) throw new AccessError(404, 'Approval not found');
    await requirePage(found.rows[0].page_id, callerFrom(req), 'admin');

    const approval = await reviewApproval(req.params.id, req.session.userId!, status, comment);
    res.json({ approval });
  } catch (err) {
    respondError(res, err, 'Failed to review approval');
  }
});

/** Router for page approval workflow: request, review, and list pending approvals. */
export default router;
