import { db } from '../models/db.js';
import { bulkIndexDocuments, indexDocument } from '../models/elasticsearch.js';
import { extractDomain } from '../utils/helpers.js';
import { processText, extractKeywords } from '../utils/tokenizer.js';

/**
 * Indexer - builds search index from crawled documents
 */
class Indexer {
  constructor() {
    this.batchSize = 100;
  }

  /**
   * Index all documents that have been crawled but not yet indexed
   */
  async indexAll() {
    console.log('Starting indexing process...');

    let offset = 0;
    let indexedCount = 0;

    while (true) {
      // Get batch of documents to index
      const result = await db.query(
        `SELECT
           d.id,
           d.url_id,
           d.url,
           d.title,
           d.description,
           d.content,
           d.content_length,
           d.fetch_time,
           u.page_rank,
           u.inlink_count,
           u.domain
         FROM documents d
         JOIN urls u ON d.url_id = u.id
         WHERE u.crawl_status = 'crawled'
         ORDER BY d.id
         LIMIT $1 OFFSET $2`,
        [this.batchSize, offset]
      );

      if (result.rows.length === 0) {
        break;
      }

      // Transform documents for Elasticsearch
      const docs = result.rows.map((row) => ({
        url_id: row.url_id,
        url: row.url,
        title: row.title,
        description: row.description,
        content: row.content,
        domain: row.domain,
        page_rank: row.page_rank || 0,
        inlink_count: row.inlink_count || 0,
        fetch_time: row.fetch_time,
        content_length: row.content_length,
      }));

      // Bulk index to Elasticsearch
      await bulkIndexDocuments(docs);

      indexedCount += docs.length;
      offset += this.batchSize;

      console.log(`Indexed ${indexedCount} documents...`);
    }

    console.log(`Indexing complete. Total: ${indexedCount} documents`);
    return indexedCount;
  }

  /**
   * Index a single document
   */
  async indexOne(urlId) {
    const result = await db.query(
      `SELECT
         d.id,
         d.url_id,
         d.url,
         d.title,
         d.description,
         d.content,
         d.content_length,
         d.fetch_time,
         u.page_rank,
         u.inlink_count,
         u.domain
       FROM documents d
       JOIN urls u ON d.url_id = u.id
       WHERE d.url_id = $1`,
      [urlId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Document not found for URL ID: ${urlId}`);
    }

    const row = result.rows[0];
    const doc = {
      url_id: row.url_id,
      url: row.url,
      title: row.title,
      description: row.description,
      content: row.content,
      domain: row.domain,
      page_rank: row.page_rank || 0,
      inlink_count: row.inlink_count || 0,
      fetch_time: row.fetch_time,
      content_length: row.content_length,
    };

    await indexDocument(doc);
    return doc;
  }

  /**
   * Update inlink counts in URLs table
   */
  async updateInlinkCounts() {
    console.log('Updating inlink counts...');

    await db.query(`
      UPDATE urls u
      SET inlink_count = (
        SELECT COUNT(*)
        FROM links l
        WHERE l.target_url_id = u.id
      ),
      updated_at = NOW()
    `);

    console.log('Inlink counts updated');
  }

  /**
   * Get indexing statistics
   */
  async getStats() {
    const urlStats = await db.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE crawl_status = 'pending') as pending,
        COUNT(*) FILTER (WHERE crawl_status = 'crawled') as crawled,
        COUNT(*) FILTER (WHERE crawl_status LIKE 'error%') as errors
      FROM urls
    `);

    const docStats = await db.query(`
      SELECT
        COUNT(*) as total,
        AVG(content_length) as avg_content_length
      FROM documents
    `);

    const linkStats = await db.query('SELECT COUNT(*) as total FROM links');

    return {
      urls: urlStats.rows[0],
      documents: docStats.rows[0],
      links: linkStats.rows[0],
    };
  }

  /**
   * Extract and store keywords for a document
   */
  async extractDocumentKeywords(urlId) {
    const result = await db.query(
      'SELECT content, title FROM documents WHERE url_id = $1',
      [urlId]
    );

    if (result.rows.length === 0) return [];

    const { content, title } = result.rows[0];
    const fullText = `${title} ${title} ${content}`; // Double weight for title
    const keywords = extractKeywords(fullText, 20);

    return keywords;
  }
}

export const indexer = new Indexer();
