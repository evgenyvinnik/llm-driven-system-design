import { esClient } from './elasticsearch.js';
import { pool } from './db.js';
import { config } from '../config/index.js';
import { searchLatency } from './metrics.js';
import { logger } from './logger.js';

interface SearchResult {
  page_id: string;
  space_id: string;
  space_key: string;
  title: string;
  content_text: string;
  labels: string[];
  score: number;
  highlight?: {
    title?: string[];
    content_text?: string[];
  };
}

interface SearchResponse {
  results: SearchResult[];
  total: number;
  took: number;
}

/** Indexes a page document in Elasticsearch with title, content, and labels. */
export async function indexPage(pageId: string, spaceId: string): Promise<void> {
  try {
    // Fetch page data from DB
    const pageResult = await pool.query(
      `SELECT p.*, s.key as space_key FROM pages p JOIN spaces s ON s.id = p.space_id WHERE p.id = $1`,
      [pageId],
    );
    if (pageResult.rows.length === 0) {
      logger.warn({ pageId }, 'Page not found for indexing');
      return;
    }

    const page = pageResult.rows[0];

    // Fetch labels
    const labelResult = await pool.query(
      'SELECT label FROM page_labels WHERE page_id = $1',
      [pageId],
    );
    const labels = labelResult.rows.map((r: { label: string }) => r.label);

    // Index in Elasticsearch
    await esClient.index({
      index: config.elasticsearch.index,
      id: pageId,
      body: {
        page_id: pageId,
        space_id: spaceId,
        space_key: page.space_key,
        title: page.title,
        content_text: page.content_text,
        labels,
        created_by: page.created_by,
        updated_at: page.updated_at,
        status: page.status,
      },
    });

    logger.debug({ pageId }, 'Page indexed in Elasticsearch');
  } catch (err) {
    logger.error({ err, pageId }, 'Failed to index page in Elasticsearch');
  }
}

/** Removes a page document from the Elasticsearch index. */
export async function deletPageIndex(pageId: string): Promise<void> {
  try {
    await esClient.delete({
      index: config.elasticsearch.index,
      id: pageId,
    });
    logger.debug({ pageId }, 'Page removed from Elasticsearch index');
  } catch (err) {
    logger.warn({ err, pageId }, 'Failed to delete page from Elasticsearch index');
  }
}

/** Searches pages via Elasticsearch with fuzzy matching, falling back to PostgreSQL ILIKE. */
export async function searchPages(
  query: string,
  spaceId?: string,
  page: number = 1,
  pageSize: number = 20,
): Promise<SearchResponse> {
  const end = searchLatency.startTimer();

  try {
    const must: object[] = [
      {
        multi_match: {
          query,
          fields: ['title^3', 'content_text', 'labels^2'],
          type: 'best_fields',
          fuzziness: 'AUTO',
        },
      },
    ];

    const filter: object[] = [{ term: { status: 'published' } }];

    if (spaceId) {
      filter.push({ term: { space_id: spaceId } });
    }

    const result = await esClient.search<Record<string, unknown>>({
      index: config.elasticsearch.index,
      body: {
        from: (page - 1) * pageSize,
        size: pageSize,
        query: {
          bool: { must, filter },
        },
        highlight: {
          fields: {
            title: { number_of_fragments: 1 },
            content_text: {
              number_of_fragments: 2,
              fragment_size: 150,
            },
          },
          pre_tags: ['<mark>'],
          post_tags: ['</mark>'],
        },
      },
    });

    const hits = result.hits.hits;
    const total = typeof result.hits.total === 'number' ? result.hits.total : result.hits.total?.value || 0;

    const results: SearchResult[] = hits.map((hit) => ({
      ...(hit._source as unknown as SearchResult),
      score: hit._score || 0,
      highlight: hit.highlight,
    }));

    end();

    return { results, total, took: result.took };
  } catch (err) {
    end();
    logger.error({ err, query }, 'Search failed');
    // Fallback to PostgreSQL full-text search
    return fallbackSearch(query, spaceId, page, pageSize);
  }
}

async function fallbackSearch(
  query: string,
  spaceId?: string,
  page: number = 1,
  pageSize: number = 20,
): Promise<SearchResponse> {
  const offset = (page - 1) * pageSize;
  const params: (string | number)[] = [`%${query}%`, pageSize, offset];

  let spaceFilter = '';
  if (spaceId) {
    spaceFilter = 'AND p.space_id = $4';
    params.push(spaceId);
  }

  const result = await pool.query(
    `SELECT p.id as page_id, p.space_id, s.key as space_key, p.title, p.content_text,
            ARRAY(SELECT label FROM page_labels WHERE page_id = p.id) as labels
     FROM pages p
     JOIN spaces s ON s.id = p.space_id
     WHERE p.status = 'published'
       AND (p.title ILIKE $1 OR p.content_text ILIKE $1)
       ${spaceFilter}
     ORDER BY p.updated_at DESC
     LIMIT $2 OFFSET $3`,
    params,
  );

  return {
    results: result.rows.map((r: SearchResult) => ({ ...r, score: 1.0 })),
    total: result.rows.length,
    took: 0,
  };
}
