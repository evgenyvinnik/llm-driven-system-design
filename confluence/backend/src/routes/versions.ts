import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getVersionHistory, computeDiff, restoreVersion } from '../services/versionService.js';
import { callerFrom, requirePage, respondError } from '../services/accessService.js';

const router = Router();

// Version history for a page (anyone who can see the page)
router.get('/:pageId', async (req: Request, res: Response) => {
  try {
    await requirePage(req.params.pageId, callerFrom(req), 'view');
    const versions = await getVersionHistory(req.params.pageId);
    res.json({ versions });
  } catch (err) {
    respondError(res, err, 'Failed to get version history');
  }
});

// Diff between two versions
router.get('/:pageId/diff', async (req: Request, res: Response) => {
  try {
    const fromVersion = parseInt(req.query.from as string);
    const toVersion = parseInt(req.query.to as string);

    if (isNaN(fromVersion) || isNaN(toVersion)) {
      res.status(400).json({ error: 'from and to version numbers are required' });
      return;
    }

    await requirePage(req.params.pageId, callerFrom(req), 'view');
    const diff = await computeDiff(req.params.pageId, fromVersion, toVersion);
    res.json({ diff });
  } catch (err) {
    respondError(res, err, 'Failed to compute diff');
  }
});

// Restore a version (editors of the space)
router.post('/:pageId/restore', requireAuth, async (req: Request, res: Response) => {
  try {
    const versionNumber = Number(req.body.versionNumber);
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      res.status(400).json({ error: 'Version number is required' });
      return;
    }

    await requirePage(req.params.pageId, callerFrom(req), 'edit');
    const restored = await restoreVersion(req.params.pageId, versionNumber, req.session.userId!);
    res.json({ message: 'Version restored', ...restored });
  } catch (err) {
    respondError(res, err, 'Failed to restore version');
  }
});

/** Router for page version history, diff computation, and version restoration. */
export default router;
