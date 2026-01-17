import { db } from '../models/db.js';
import { updatePageRanks } from '../models/elasticsearch.js';
import { config } from '../config/index.js';

/**
 * PageRank Calculator - iteratively computes PageRank for all URLs
 */
class PageRankCalculator {
  constructor() {
    this.dampingFactor = config.pageRank.dampingFactor;
    this.iterations = config.pageRank.iterations;
    this.convergenceThreshold = config.pageRank.convergenceThreshold;
  }

  /**
   * Calculate PageRank for all URLs
   */
  async calculate() {
    console.log('Starting PageRank calculation...');
    console.log(`Parameters: d=${this.dampingFactor}, max_iterations=${this.iterations}`);

    // Get all crawled URLs
    const urlsResult = await db.query(
      `SELECT id FROM urls WHERE crawl_status = 'crawled' ORDER BY id`
    );

    const urls = urlsResult.rows.map((r) => r.id);
    const n = urls.length;

    if (n === 0) {
      console.log('No URLs to calculate PageRank for');
      return {};
    }

    console.log(`Calculating PageRank for ${n} URLs...`);

    // Create URL ID to index mapping for efficient lookup
    const urlToIndex = new Map();
    urls.forEach((id, index) => {
      urlToIndex.set(id, index);
    });

    // Build adjacency list - get all links
    const linksResult = await db.query(
      `SELECT source_url_id, target_url_id
       FROM links l
       WHERE l.source_url_id IN (SELECT id FROM urls WHERE crawl_status = 'crawled')
         AND l.target_url_id IN (SELECT id FROM urls WHERE crawl_status = 'crawled')`
    );

    // Outlinks: source -> [targets]
    const outlinks = new Map();
    // Inlinks: target -> [sources]
    const inlinks = new Map();

    for (const { source_url_id, target_url_id } of linksResult.rows) {
      if (!outlinks.has(source_url_id)) {
        outlinks.set(source_url_id, []);
      }
      outlinks.get(source_url_id).push(target_url_id);

      if (!inlinks.has(target_url_id)) {
        inlinks.set(target_url_id, []);
      }
      inlinks.get(target_url_id).push(source_url_id);
    }

    console.log(`Link graph built: ${linksResult.rows.length} links`);

    // Initialize PageRank uniformly
    let ranks = new Map();
    const initialRank = 1 / n;
    for (const urlId of urls) {
      ranks.set(urlId, initialRank);
    }

    // Iterative calculation
    const teleportProb = (1 - this.dampingFactor) / n;

    for (let iteration = 0; iteration < this.iterations; iteration++) {
      const newRanks = new Map();

      // Handle dangling nodes (pages with no outlinks)
      // Their PageRank should be distributed equally to all pages
      let danglingSum = 0;
      for (const urlId of urls) {
        if (!outlinks.has(urlId) || outlinks.get(urlId).length === 0) {
          danglingSum += ranks.get(urlId);
        }
      }
      const danglingContribution = (this.dampingFactor * danglingSum) / n;

      // Calculate new PageRank for each page
      for (const urlId of urls) {
        let sum = 0;

        // Sum contributions from pages linking to this one
        const inlinkList = inlinks.get(urlId) || [];
        for (const sourceId of inlinkList) {
          const sourceOutlinkCount = outlinks.get(sourceId)?.length || 1;
          sum += ranks.get(sourceId) / sourceOutlinkCount;
        }

        // PageRank formula
        const newRank = teleportProb + this.dampingFactor * sum + danglingContribution;
        newRanks.set(urlId, newRank);
      }

      // Check for convergence
      let maxDiff = 0;
      for (const urlId of urls) {
        const diff = Math.abs(newRanks.get(urlId) - ranks.get(urlId));
        maxDiff = Math.max(maxDiff, diff);
      }

      ranks = newRanks;

      if ((iteration + 1) % 10 === 0) {
        console.log(`Iteration ${iteration + 1}: max diff = ${maxDiff.toFixed(8)}`);
      }

      if (maxDiff < this.convergenceThreshold) {
        console.log(`Converged after ${iteration + 1} iterations`);
        break;
      }
    }

    // Normalize ranks (sum to 1)
    let totalRank = 0;
    for (const rank of ranks.values()) {
      totalRank += rank;
    }
    for (const [urlId, rank] of ranks) {
      ranks.set(urlId, rank / totalRank);
    }

    // Store PageRank in database
    await this.storePageRanks(ranks);

    // Update Elasticsearch
    const pageRanksObj = Object.fromEntries(ranks);
    await updatePageRanks(pageRanksObj);

    console.log('PageRank calculation complete');

    // Return top 10 pages by PageRank
    const sortedRanks = [...ranks.entries()].sort((a, b) => b[1] - a[1]);
    return sortedRanks.slice(0, 10);
  }

  /**
   * Store PageRank values in database
   */
  async storePageRanks(ranks) {
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      for (const [urlId, rank] of ranks) {
        await client.query(
          'UPDATE urls SET page_rank = $1, updated_at = NOW() WHERE id = $2',
          [rank, urlId]
        );
      }

      await client.query('COMMIT');
      console.log(`Stored PageRank for ${ranks.size} URLs`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get PageRank statistics
   */
  async getStats() {
    const result = await db.query(`
      SELECT
        COUNT(*) as total,
        AVG(page_rank) as avg_rank,
        MAX(page_rank) as max_rank,
        MIN(page_rank) as min_rank
      FROM urls
      WHERE page_rank > 0
    `);

    const topPages = await db.query(`
      SELECT u.id, u.url, u.page_rank, d.title
      FROM urls u
      LEFT JOIN documents d ON u.id = d.url_id
      WHERE u.page_rank > 0
      ORDER BY u.page_rank DESC
      LIMIT 10
    `);

    return {
      stats: result.rows[0],
      topPages: topPages.rows,
    };
  }
}

export const pageRankCalculator = new PageRankCalculator();
