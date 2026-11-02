import { Router, Request, Response } from 'express';
import { searchPages } from '../services/searchService.js';
import { callerFrom, requireSpace, respondError, visibleSpaceIds } from '../services/accessService.js';

const router = Router();

// Search published pages in the spaces the caller can see
router.get('/', async (req: Request, res: Response) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const spaceKey = req.query.space as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize as string) || 20));

    if (!query) {
      res.status(400).json({ error: 'Search query (q) is required' });
      return;
    }

    const caller = callerFrom(req);
    // A space filter narrows the visible set; it never widens it. An unknown or
    // invisible space is a 404, not (as before) a silent global search.
    const spaceIds = spaceKey
      ? [(await requireSpace({ key: spaceKey }, caller, 'view')).spaceId]
      : await visibleSpaceIds(caller);

    res.json(await searchPages(query, spaceIds, page, pageSize));
  } catch (err) {
    respondError(res, err, 'Search failed');
  }
});

/** Router for full-text page search with Elasticsearch and PostgreSQL fallback. */
export default router;
