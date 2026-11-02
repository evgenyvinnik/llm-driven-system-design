import { pool } from './db.js';
import { diffLines, Change } from 'diff';
import { logger } from './logger.js';
import { pageOperations } from './metrics.js';
import { AccessError } from './accessService.js';
import { afterPageWrite, uniqueSlug } from './pageService.js';
import { sanitizePageHtml } from './htmlSanitizer.js';

interface PageVersion {
  id: string;
  page_id: string;
  version_number: number;
  title: string;
  content_json: object;
  content_html: string;
  content_text: string;
  change_message: string;
  created_by: string;
  created_at: string;
  author_username?: string;
}

interface DiffResult {
  fromVersion: number;
  toVersion: number;
  changes: Change[];
  titleChanged: boolean;
  fromTitle: string;
  toTitle: string;
}

/** Retrieves all version records for a page ordered by version number descending. */
export async function getVersionHistory(pageId: string): Promise<PageVersion[]> {
  const result = await pool.query(
    `SELECT pv.*, u.username as author_username
     FROM page_versions pv
     JOIN users u ON u.id = pv.created_by
     WHERE pv.page_id = $1
     ORDER BY pv.version_number DESC`,
    [pageId],
  );
  return result.rows;
}

/** Retrieves a specific version of a page by version number. */
export async function getVersion(pageId: string, versionNumber: number): Promise<PageVersion | null> {
  const result = await pool.query(
    `SELECT pv.*, u.username as author_username
     FROM page_versions pv
     JOIN users u ON u.id = pv.created_by
     WHERE pv.page_id = $1 AND pv.version_number = $2`,
    [pageId, versionNumber],
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

/** Computes a line-by-line diff between two page versions for history display. */
export async function computeDiff(
  pageId: string,
  fromVersion: number,
  toVersion: number,
): Promise<DiffResult> {
  const [fromVer, toVer] = await Promise.all([
    getVersion(pageId, fromVersion),
    getVersion(pageId, toVersion),
  ]);

  if (!fromVer || !toVer) {
    throw new AccessError(404, `Version not found: from=${fromVersion}, to=${toVersion}`);
  }

  const changes = diffLines(fromVer.content_html, toVer.content_html);

  logger.debug(
    { pageId, fromVersion, toVersion, changeCount: changes.length },
    'Computed diff between versions',
  );

  return {
    fromVersion,
    toVersion,
    changes,
    titleChanged: fromVer.title !== toVer.title,
    fromTitle: fromVer.title,
    toTitle: toVer.title,
  };
}

/**
 * Restores a page to a previous version by writing it forward as a new
 * version. Like any edit it invalidates the cache and reindexes the page;
 * previously the restored content stayed out of search and cached reads kept
 * serving the replaced version for up to two minutes.
 */
export async function restoreVersion(
  pageId: string,
  versionNumber: number,
  restoredBy: string,
): Promise<{ version: number; slug: string }> {
  const version = await getVersion(pageId, versionNumber);
  if (!version) throw new AccessError(404, 'Version not found');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query(
      'SELECT version, space_id, title, slug FROM pages WHERE id = $1 FOR UPDATE',
      [pageId],
    );
    const page = current.rows[0];
    if (!page) throw new AccessError(404, 'Page not found');
    const newVersionNum = page.version + 1;
    const slug = version.title === page.title
      ? page.slug
      : await uniqueSlug(client, page.space_id, version.title, pageId);

    await client.query(
      `UPDATE pages
       SET title = $1, slug = $2, content_json = $3, content_html = $4, content_text = $5,
           version = $6, updated_by = $7, updated_at = NOW()
       WHERE id = $8`,
      [
        version.title,
        slug,
        JSON.stringify(version.content_json),
        // Versions written before sanitization existed may hold unsafe HTML.
        sanitizePageHtml(version.content_html),
        version.content_text,
        newVersionNum,
        restoredBy,
        pageId,
      ],
    );

    await client.query(
      `INSERT INTO page_versions (page_id, version_number, title, content_json, content_html, content_text, change_message, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        pageId,
        newVersionNum,
        version.title,
        JSON.stringify(version.content_json),
        sanitizePageHtml(version.content_html),
        version.content_text,
        `Restored from version ${versionNumber}`,
        restoredBy,
      ],
    );

    await client.query('COMMIT');
    await afterPageWrite(page.space_id, pageId);
    pageOperations.inc({ operation: 'restore' });
    logger.info({ pageId, restoredFrom: versionNumber, newVersion: newVersionNum }, 'Page version restored');
    return { version: newVersionNum, slug };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
