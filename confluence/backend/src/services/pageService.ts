import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { cacheGet, cacheSet, cacheDelPattern } from './redis.js';
import { publishToQueue } from './queue.js';
import { config } from '../config/index.js';
import { pageOperations } from './metrics.js';
import { logger } from './logger.js';
import { AccessError } from './accessService.js';
import { sanitizePageHtml } from './htmlSanitizer.js';

interface Page {
  id: string;
  space_id: string;
  parent_id: string | null;
  title: string;
  slug: string;
  content_json: object;
  content_html: string;
  content_text: string;
  version: number;
  status: string;
  position: number;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

interface PageTreeNode extends Page {
  children: PageTreeNode[];
}

type Queryable = Pick<PoolClient, 'query'>;

/** URL-safe slug. Titles with no ASCII letters or digits fall back to "page". */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'page';
}

/**
 * A slug unique within the space: `title`, then `title-2`, `title-3`, ...
 * Two pages with the same title used to share a slug, so one of them was
 * unreachable by URL (the slug lookup returned whichever row came first).
 */
export async function uniqueSlug(
  db: Queryable,
  spaceId: string,
  title: string,
  excludePageId?: string,
): Promise<string> {
  const base = slugify(title);
  const taken = await db.query(
    `SELECT slug FROM pages
     WHERE space_id = $1 AND (slug = $2 OR slug LIKE $3) AND ($4::uuid IS NULL OR id <> $4::uuid)`,
    [spaceId, base, `${base}-%`, excludePageId ?? null],
  );
  const used = new Set(taken.rows.map((r: { slug: string }) => r.slug));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

/** Raised when an edit was based on an older version than the one stored. */
export class VersionConflictError extends AccessError {
  constructor(currentVersion: number) {
    super(
      409,
      `This page was changed by someone else (now at version ${currentVersion}). Reload to see their changes.`,
      { currentVersion },
    );
    this.name = 'VersionConflictError';
  }
}

/**
 * Everything that must follow a committed change to a page: drop the cached
 * rows and tree, and ask the indexer to re-read the page. Cache failures are
 * logged rather than thrown, because the write has already committed and the
 * 120-second TTL bounds how long a stale entry can survive.
 */
export async function afterPageWrite(
  spaceId: string,
  pageId: string,
  action: 'index' | 'delete' = 'index',
): Promise<void> {
  try {
    await cacheDelPattern(`space:${spaceId}:*`);
    await cacheDelPattern(`page:${pageId}:*`);
  } catch (err) {
    logger.warn({ err, pageId }, 'Cache invalidation failed after page write');
  }
  await publishToQueue(config.rabbitmq.pageIndexQueue, { action, pageId, spaceId });
}

/** Creates a page with its initial version; the caller has checked edit access to the space. */
export async function createPage(
  spaceId: string,
  title: string,
  contentJson: object,
  contentHtml: string,
  contentText: string,
  createdBy: string,
  parentId: string | null = null,
  status: string = 'published',
): Promise<Page> {
  contentHtml = sanitizePageHtml(contentHtml);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (parentId) {
      const parent = await client.query('SELECT space_id FROM pages WHERE id = $1', [parentId]);
      if (parent.rows[0]?.space_id !== spaceId) {
        throw new AccessError(400, 'Parent page must be in the same space');
      }
    }

    const slug = await uniqueSlug(client, spaceId, title);

    // Get next position for this parent
    const posResult = await client.query(
      `SELECT COALESCE(MAX(position), -1) + 1 as next_pos
       FROM pages WHERE space_id = $1 AND parent_id ${parentId ? '= $2' : 'IS NULL'}`,
      parentId ? [spaceId, parentId] : [spaceId],
    );
    const position = posResult.rows[0].next_pos;

    const result = await client.query(
      `INSERT INTO pages (space_id, parent_id, title, slug, content_json, content_html, content_text, status, position, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       RETURNING *`,
      [spaceId, parentId, title, slug, JSON.stringify(contentJson), contentHtml, contentText, status, position, createdBy],
    );

    const page = result.rows[0];

    // Create initial version
    await client.query(
      `INSERT INTO page_versions (page_id, version_number, title, content_json, content_html, content_text, change_message, created_by)
       VALUES ($1, 1, $2, $3, $4, $5, 'Initial version', $6)`,
      [page.id, title, JSON.stringify(contentJson), contentHtml, contentText, createdBy],
    );

    await client.query('COMMIT');
    await afterPageWrite(spaceId, page.id);

    pageOperations.inc({ operation: 'create' });
    logger.info({ pageId: page.id, spaceId }, 'Page created');

    return page;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Updates a page and records a new version. With `expectedVersion`, the update
 * applies only if the stored version still matches, so two editors saving the
 * same base version cannot silently overwrite each other (the loser gets a
 * VersionConflictError and the current version number).
 */
export async function updatePage(
  pageId: string,
  title: string,
  contentJson: object,
  contentHtml: string,
  contentText: string,
  updatedBy: string,
  changeMessage?: string,
  expectedVersion?: number,
): Promise<Page> {
  contentHtml = sanitizePageHtml(contentHtml);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query('SELECT * FROM pages WHERE id = $1 FOR UPDATE', [pageId]);
    if (current.rows.length === 0) throw new AccessError(404, 'Page not found');

    const page = current.rows[0];
    if (expectedVersion !== undefined && page.version !== expectedVersion) {
      throw new VersionConflictError(page.version);
    }
    const newVersion = page.version + 1;
    const newSlug = title === page.title ? page.slug : await uniqueSlug(client, page.space_id, title, pageId);

    const result = await client.query(
      `UPDATE pages
       SET title = $1, slug = $2, content_json = $3, content_html = $4, content_text = $5,
           version = $6, updated_by = $7, updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [title, newSlug, JSON.stringify(contentJson), contentHtml, contentText, newVersion, updatedBy, pageId],
    );

    await client.query(
      `INSERT INTO page_versions (page_id, version_number, title, content_json, content_html, content_text, change_message, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [pageId, newVersion, title, JSON.stringify(contentJson), contentHtml, contentText, changeMessage || `Version ${newVersion}`, updatedBy],
    );

    await client.query('COMMIT');

    const updated = result.rows[0];
    await afterPageWrite(updated.space_id, pageId);

    pageOperations.inc({ operation: 'update' });
    logger.info({ pageId, version: newVersion }, 'Page updated');

    return updated;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Deletes a page; its children move to the space root (ON DELETE SET NULL). */
export async function deletePage(pageId: string): Promise<void> {
  const found = await pool.query('SELECT space_id FROM pages WHERE id = $1', [pageId]);
  if (!found.rows[0]) throw new AccessError(404, 'Page not found');
  const spaceId: string = found.rows[0].space_id;

  const children = await pool.query('SELECT id FROM pages WHERE parent_id = $1', [pageId]);
  await pool.query('DELETE FROM pages WHERE id = $1', [pageId]);

  await afterPageWrite(spaceId, pageId, 'delete');
  // Reparented children have a new parent_id; their cached rows are stale too.
  for (const child of children.rows as { id: string }[]) {
    await cacheDelPattern(`page:${child.id}:*`).catch(() => undefined);
  }

  pageOperations.inc({ operation: 'delete' });
  logger.info({ pageId }, 'Page deleted');
}

/** Retrieves a page by ID with Redis caching. */
export async function getPageById(pageId: string): Promise<Page | null> {
  const cacheKey = `page:${pageId}:data`;
  const cached = await cacheGet<Page>(cacheKey);
  if (cached) return cached;

  const result = await pool.query('SELECT * FROM pages WHERE id = $1', [pageId]);
  if (result.rows.length === 0) return null;

  const page = result.rows[0];
  await cacheSet(cacheKey, page, 120);
  return page;
}

/** Retrieves a page by its URL slug within a space, with Redis caching. */
export async function getPageBySlug(spaceId: string, slug: string): Promise<Page | null> {
  const cacheKey = `space:${spaceId}:slug:${slug}`;
  const cached = await cacheGet<Page>(cacheKey);
  if (cached) return cached;

  const result = await pool.query(
    'SELECT * FROM pages WHERE space_id = $1 AND slug = $2 ORDER BY created_at LIMIT 1',
    [spaceId, slug],
  );
  if (result.rows.length === 0) return null;

  const page = result.rows[0];
  await cacheSet(cacheKey, page, 120);
  return page;
}

/**
 * Builds the page tree for a space. The flat page list is cached once per
 * space; drafts and archived pages are filtered per request, because whether
 * they are visible depends on the caller, not the space.
 */
export async function getPageTree(spaceId: string, includeUnpublished: boolean): Promise<PageTreeNode[]> {
  const cacheKey = `space:${spaceId}:pages`;
  let pages = await cacheGet<Page[]>(cacheKey);
  if (!pages) {
    const result = await pool.query(
      `SELECT id, space_id, parent_id, title, slug, version, status, position,
              created_by, updated_by, created_at, updated_at
       FROM pages WHERE space_id = $1 ORDER BY position ASC, created_at ASC`,
      [spaceId],
    );
    pages = result.rows as Page[];
    await cacheSet(cacheKey, pages, 120);
  }

  const visible = includeUnpublished ? pages : pages.filter((p) => p.status === 'published');
  return buildTree(visible);
}

function buildTree(pages: Page[]): PageTreeNode[] {
  const map = new Map<string, PageTreeNode>();
  const roots: PageTreeNode[] = [];

  for (const page of pages) {
    map.set(page.id, { ...page, children: [] });
  }

  // A page whose parent is hidden (a draft, for a viewer) is shown at the root.
  for (const page of pages) {
    const node = map.get(page.id)!;
    if (page.parent_id && map.has(page.parent_id)) {
      map.get(page.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Moves a page under a new parent at a position, reordering siblings at both
 * places. The new parent must be in the same space and must not be the page
 * itself or one of its descendants: a cycle has no path to the root, so every
 * page in it would silently vanish from the tree.
 */
export async function movePage(
  pageId: string,
  newParentId: string | null,
  newPosition: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const found = await client.query('SELECT * FROM pages WHERE id = $1 FOR UPDATE', [pageId]);
    const page = found.rows[0];
    if (!page) throw new AccessError(404, 'Page not found');

    if (newParentId) {
      const parent = await client.query('SELECT space_id FROM pages WHERE id = $1', [newParentId]);
      if (parent.rows[0]?.space_id !== page.space_id) {
        throw new AccessError(400, 'New parent must be a page in the same space');
      }
      const cycle = await client.query(
        `WITH RECURSIVE subtree AS (
           SELECT id FROM pages WHERE id = $1
           UNION ALL
           SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
         )
         SELECT 1 FROM subtree WHERE id = $2`,
        [pageId, newParentId],
      );
      if (cycle.rows.length > 0) {
        throw new AccessError(400, 'A page cannot be moved under itself or one of its descendants');
      }
    }

    const position = Math.max(0, Math.floor(newPosition));

    // `parent_id IS NOT DISTINCT FROM $2` matches NULL (the space root) and a
    // real parent alike. The previous `IS NULL` form still referenced $3 while
    // passing two parameters, so every move from or to the root failed.
    await client.query(
      `UPDATE pages SET position = position - 1
       WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND position > $3 AND id <> $4`,
      [page.space_id, page.parent_id, page.position, pageId],
    );

    await client.query(
      `UPDATE pages SET position = position + 1
       WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND position >= $3 AND id <> $4`,
      [page.space_id, newParentId, position, pageId],
    );

    await client.query(
      'UPDATE pages SET parent_id = $1, position = $2, updated_at = NOW() WHERE id = $3',
      [newParentId, position, pageId],
    );

    await client.query('COMMIT');

    try {
      await cacheDelPattern(`space:${page.space_id}:*`);
      await cacheDelPattern(`page:${pageId}:*`);
    } catch (err) {
      logger.warn({ err, pageId }, 'Cache invalidation failed after move');
    }

    pageOperations.inc({ operation: 'move' });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The most recently updated pages the caller can see: published pages in
 * viewable spaces, plus drafts in spaces where the caller is an editor.
 */
export async function getRecentPages(
  viewableSpaceIds: string[],
  editableSpaceIds: string[],
  limit: number = 10,
): Promise<Page[]> {
  if (viewableSpaceIds.length === 0) return [];
  const result = await pool.query(
    `SELECT p.id, p.space_id, p.parent_id, p.title, p.slug, p.version, p.status, p.position,
            p.created_by, p.updated_by, p.created_at, p.updated_at,
            s.key as space_key, s.name as space_name, u.username as author_username
     FROM pages p
     JOIN spaces s ON s.id = p.space_id
     JOIN users u ON u.id = p.created_by
     WHERE p.space_id = ANY($1::uuid[])
       AND (p.status = 'published' OR p.space_id = ANY($2::uuid[]))
     ORDER BY p.updated_at DESC
     LIMIT $3`,
    [viewableSpaceIds, editableSpaceIds, limit],
  );
  return result.rows;
}

/** Normalizes a label: trimmed, lowercase, internal whitespace as hyphens. */
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Adds a label to a page (ignoring duplicates) and reindexes it, since labels are searchable. */
export async function addLabel(pageId: string, spaceId: string, label: string): Promise<void> {
  await pool.query(
    'INSERT INTO page_labels (page_id, label) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [pageId, label],
  );
  await afterPageWrite(spaceId, pageId);
}

/** Removes a label from a page and reindexes it. */
export async function removeLabel(pageId: string, spaceId: string, label: string): Promise<void> {
  await pool.query('DELETE FROM page_labels WHERE page_id = $1 AND label = $2', [pageId, label]);
  await afterPageWrite(spaceId, pageId);
}

/** Retrieves all labels for a page, sorted alphabetically. */
export async function getLabels(pageId: string): Promise<string[]> {
  const result = await pool.query(
    'SELECT label FROM page_labels WHERE page_id = $1 ORDER BY label',
    [pageId],
  );
  return result.rows.map((r: { label: string }) => r.label);
}

/** Builds ancestor breadcrumb chain using a recursive CTE. */
export async function getPageBreadcrumbs(pageId: string): Promise<Array<{ id: string; title: string; slug: string }>> {
  const result = await pool.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id, title, slug, 0 as depth
       FROM pages WHERE id = $1
       UNION ALL
       SELECT p.id, p.parent_id, p.title, p.slug, a.depth + 1
       FROM pages p
       JOIN ancestors a ON p.id = a.parent_id
       WHERE a.depth < 50
     )
     SELECT id, title, slug FROM ancestors ORDER BY depth DESC`,
    [pageId],
  );
  return result.rows;
}
