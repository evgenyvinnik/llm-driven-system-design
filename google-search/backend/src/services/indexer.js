import { db } from '../models/db.js';
import { bulkIndexDocuments, indexDocument } from '../models/elasticsearch.js';
import { extractDomain } from '../utils/helpers.js';
import { processText, extractKeywords } from '../utils/tokenizer.js';
import { logger } from '../shared/logger.js';
import {
  indexOperationsCounter,
  indexLatencyHistogram,
} from '../shared/metrics.js';
import { createCircuitBreaker } from '../shared/circuitBreaker.js';
import {
  filterAlreadyIndexed,
  markBatchAsIndexed,
  generateDocumentIdempotencyKey,
} from '../shared/idempotency.js';
import crypto from 'crypto';

/**
 * Indexer - builds search index from crawled documents
 *
 * Uses circuit breaker to protect Elasticsearch availability
 * Uses idempotency to prevent duplicate indexing
 */
class Indexer {
  constructor() {
    this.batchSize = 100;

    // Create circuit breaker for bulk indexing
    this.bulkIndexBreaker = createCircuitBreaker(
      'elasticsearch-bulk-index',
      async (docs) => bulkIndexDocuments(docs),
      {
        timeout: 30000, // Bulk operations can take time
        errorThresholdPercentage: 40,
        resetTimeout: 15000,
      }
    );

    // Create circuit breaker for single document indexing
    this.singleIndexBreaker = createCircuitBreaker(
      'elasticsearch-single-index',
      async (doc) => indexDocument(doc),
      {
        timeout: 10000,
        errorThresholdPercentage: 50,
        resetTimeout: 10000,
      }
    );
  }

  /**
   * Generate content hash for idempotency
   */
  generateContentHash(doc) {
    const content = `${doc.title}:${doc.content?.substring(0, 1000) || ''}`;
    return crypto.createHash('md5').update(content).digest('hex').substring(0, 12);
  }

  /**
   * Index all documents that have been crawled but not yet indexed
   *
   * WHY circuit breaker protects index availability:
   * - If Elasticsearch is overloaded, circuit breaker trips
   * - Allows ES cluster to recover instead of piling up requests
   * - Fail fast pattern prevents request queue buildup
   */
  async indexAll() {
    logger.info('Starting indexing process...');

    let offset = 0;
    let indexedCount = 0;
    let skippedCount = 0;
    const startTime = Date.now();

    while (true) {
      const batchStartTime = Date.now();

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
        _contentHash: this.generateContentHash(row),
      }));

      // Filter out already indexed documents (idempotency)
      const keyGenerator = (doc) =>
        generateDocumentIdempotencyKey(doc.url_id, doc._contentHash);

      const docsToIndex = await filterAlreadyIndexed(docs, keyGenerator);

      if (docsToIndex.length > 0) {
        try {
          // Use circuit breaker for bulk indexing
          await this.bulkIndexBreaker.fire(docsToIndex);

          // Mark as indexed for idempotency
          await markBatchAsIndexed(docsToIndex, keyGenerator);

          indexedCount += docsToIndex.length;
          indexOperationsCounter.labels('bulk', 'success').inc();

          const batchDuration = (Date.now() - batchStartTime) / 1000;
          indexLatencyHistogram.labels('bulk').observe(batchDuration);

          logger.info(
            {
              batchSize: docsToIndex.length,
              totalIndexed: indexedCount,
              batchDurationMs: Date.now() - batchStartTime,
            },
            `Indexed batch of ${docsToIndex.length} documents`
          );
        } catch (error) {
          indexOperationsCounter.labels('bulk', 'error').inc();

          if (error.message.includes('Circuit breaker')) {
            logger.warn(
              { error: error.message },
              'Circuit breaker open - pausing indexing'
            );
            // Wait before retrying
            await new Promise((resolve) => setTimeout(resolve, 5000));
            continue; // Retry same batch
          }

          throw error;
        }
      }

      skippedCount += docs.length - docsToIndex.length;
      offset += this.batchSize;

      logger.debug(
        {
          indexed: docsToIndex.length,
          skipped: docs.length - docsToIndex.length,
          offset,
        },
        'Batch processed'
      );
    }

    const totalDuration = Date.now() - startTime;
    logger.info(
      {
        totalIndexed: indexedCount,
        totalSkipped: skippedCount,
        durationMs: totalDuration,
      },
      `Indexing complete. Indexed: ${indexedCount}, Skipped: ${skippedCount}`
    );

    return indexedCount;
  }

  /**
   * Index a single document
   *
   * WHY circuit breaker protects availability:
   * - Individual document indexing is wrapped with circuit breaker
   * - Prevents cascading failures if ES is slow
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

    try {
      // Use circuit breaker for single document indexing
      await this.singleIndexBreaker.fire(doc);
      indexOperationsCounter.labels('single', 'success').inc();

      logger.debug({ urlId, url: doc.url }, 'Single document indexed');
    } catch (error) {
      indexOperationsCounter.labels('single', 'error').inc();
      throw error;
    }

    return doc;
  }

  /**
   * Update inlink counts in URLs table
   */
  async updateInlinkCounts() {
    logger.info('Updating inlink counts...');

    await db.query(`
      UPDATE urls u
      SET inlink_count = (
        SELECT COUNT(*)
        FROM links l
        WHERE l.target_url_id = u.id
      ),
      updated_at = NOW()
    `);

    logger.info('Inlink counts updated');
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
