import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../services/db.js';
import {
  createPage,
  updatePage,
  deletePage,
  getPageBySlug,
  getPageById,
  getPageTree,
  movePage,
  getRecentPages,
  addLabel,
  removeLabel,
  getLabels,
  getPageBreadcrumbs,
  normalizeLabel,
} from '../services/pageService.js';
import {
  AccessError,
  callerFrom,
  canSeePage,
  editableSpaceIds,
  isUuid,
  requirePage,
  requireSpace,
  respondError,
  visibleSpaceIds,
  type SpaceAccess,
} from '../services/accessService.js';

const router = Router();

const PAGE_STATUSES = new Set(['draft', 'published', 'archived']);

/** Author, labels and breadcrumbs for a page the caller can see. */
async function withDetails(page: { id: string; created_by: string }, access: SpaceAccess) {
  const [author, labels, breadcrumbs] = await Promise.all([
    pool.query('SELECT username, display_name FROM users WHERE id = $1', [page.created_by]),
    getLabels(page.id),
    getPageBreadcrumbs(page.id),
  ]);
  // A viewer must not learn the titles of unpublished ancestors.
  const visibleCrumbs = access.canEdit
    ? breadcrumbs
    : await filterPublished(breadcrumbs);
  return {
    ...page,
    author: author.rows[0],
    labels,
    breadcrumbs: visibleCrumbs,
    access: { canEdit: access.canEdit, canAdmin: access.canAdmin, role: access.role },
  };
}

async function filterPublished<T extends { id: string }>(items: T[]): Promise<T[]> {
  if (items.length === 0) return items;
  const published = await pool.query(
    `SELECT id FROM pages WHERE id = ANY($1::uuid[]) AND status = 'published'`,
    [items.map((i) => i.id)],
  );
  const ok = new Set(published.rows.map((r: { id: string }) => r.id));
  return items.filter((i) => ok.has(i.id));
}

// Recent pages the caller can see (dashboard)
router.get('/recent', async (req: Request, res: Response) => {
  try {
    const caller = callerFrom(req);
    const [viewable, editable] = await Promise.all([visibleSpaceIds(caller), editableSpaceIds(caller)]);
    const pages = await getRecentPages(viewable, editable, 20);
    res.json({ pages });
  } catch (err) {
    respondError(res, err, 'Failed to get recent pages');
  }
});

// Page tree for a space; drafts only for editors
router.get('/space/:spaceKey/tree', async (req: Request, res: Response) => {
  try {
    const access = await requireSpace({ key: req.params.spaceKey }, callerFrom(req), 'view');
    const tree = await getPageTree(access.spaceId, access.canEdit);
    res.json({ tree });
  } catch (err) {
    respondError(res, err, 'Failed to get page tree');
  }
});

// Page by slug
router.get('/space/:spaceKey/slug/:slug', async (req: Request, res: Response) => {
  try {
    const access = await requireSpace({ key: req.params.spaceKey }, callerFrom(req), 'view');
    const page = await getPageBySlug(access.spaceId, req.params.slug);
    if (!page || !canSeePage(page, access)) throw new AccessError(404, 'Page not found');
    res.json({ page: await withDetails(page, access) });
  } catch (err) {
    respondError(res, err, 'Failed to get page');
  }
});

// Page by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { access } = await requirePage(req.params.id, callerFrom(req), 'view');
    const page = await getPageById(req.params.id);
    if (!page) throw new AccessError(404, 'Page not found');
    res.json({ page: await withDetails(page, access) });
  } catch (err) {
    respondError(res, err, 'Failed to get page');
  }
});

// Create page (members and admins of the space)
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { spaceId, title, contentJson, contentHtml, contentText, parentId, status } = req.body;

    if (!spaceId || !title) {
      res.status(400).json({ error: 'Space ID and title are required' });
      return;
    }
    if (status !== undefined && !PAGE_STATUSES.has(status)) {
      res.status(400).json({ error: 'Status must be draft, published, or archived' });
      return;
    }
    if (parentId && !isUuid(parentId)) {
      res.status(400).json({ error: 'Invalid parent page' });
      return;
    }

    await requireSpace({ id: spaceId }, callerFrom(req), 'edit');

    const page = await createPage(
      spaceId,
      String(title),
      contentJson || {},
      contentHtml || '',
      contentText || '',
      req.session.userId!,
      parentId || null,
      status || 'published',
    );

    res.status(201).json({ page });
  } catch (err) {
    respondError(res, err, 'Failed to create page');
  }
});

// Update page. `version` (optional) is the version the edit was based on.
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { title, contentJson, contentHtml, contentText, changeMessage, version } = req.body;

    if (!title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }
    if (version !== undefined && !Number.isInteger(version)) {
      res.status(400).json({ error: 'version must be an integer' });
      return;
    }

    await requirePage(req.params.id, callerFrom(req), 'edit');

    const page = await updatePage(
      req.params.id,
      String(title),
      contentJson || {},
      contentHtml || '',
      contentText || '',
      req.session.userId!,
      changeMessage,
      version,
    );

    res.json({ page });
  } catch (err) {
    respondError(res, err, 'Failed to update page');
  }
});

// Delete page
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    await requirePage(req.params.id, callerFrom(req), 'edit');
    await deletePage(req.params.id);
    res.json({ message: 'Page deleted' });
  } catch (err) {
    respondError(res, err, 'Failed to delete page');
  }
});

// Move page within its space
router.post('/:id/move', requireAuth, async (req: Request, res: Response) => {
  try {
    const { parentId, position } = req.body;
    if (parentId && !isUuid(parentId)) {
      res.status(400).json({ error: 'Invalid parent page' });
      return;
    }
    await requirePage(req.params.id, callerFrom(req), 'edit');
    await movePage(req.params.id, parentId || null, Number(position) || 0);
    res.json({ message: 'Page moved' });
  } catch (err) {
    respondError(res, err, 'Failed to move page');
  }
});

// Add label
router.post('/:id/labels', requireAuth, async (req: Request, res: Response) => {
  try {
    const label = typeof req.body.label === 'string' ? normalizeLabel(req.body.label) : '';
    if (!label || label.length > 50) {
      res.status(400).json({ error: 'Label must be 1-50 characters' });
      return;
    }
    const { page } = await requirePage(req.params.id, callerFrom(req), 'edit');
    await addLabel(page.id, page.space_id, label);
    res.status(201).json({ message: 'Label added', label });
  } catch (err) {
    respondError(res, err, 'Failed to add label');
  }
});

// Remove label
router.delete('/:id/labels/:label', requireAuth, async (req: Request, res: Response) => {
  try {
    const { page } = await requirePage(req.params.id, callerFrom(req), 'edit');
    await removeLabel(page.id, page.space_id, normalizeLabel(req.params.label));
    res.json({ message: 'Label removed' });
  } catch (err) {
    respondError(res, err, 'Failed to remove label');
  }
});

// Get labels
router.get('/:id/labels', async (req: Request, res: Response) => {
  try {
    await requirePage(req.params.id, callerFrom(req), 'view');
    const labels = await getLabels(req.params.id);
    res.json({ labels });
  } catch (err) {
    respondError(res, err, 'Failed to get labels');
  }
});

/** Router for wiki page CRUD, tree navigation, labels, and page movement. */
export default router;
