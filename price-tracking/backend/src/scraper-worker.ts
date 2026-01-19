/**
 * Scraper worker process for fetching product prices.
 * Runs independently of the API server as a cron-scheduled job.
 * Processes products from a Redis-backed priority queue, respecting
 * rate limits, circuit breakers, and concurrency settings.
 * @module scraper-worker
 */
import cron from 'node-cron';
import dotenv from 'dotenv';

import { scraper } from './services/scraperService.js';
import { getProductsToScrape, updateProductPrice, setProductError, getProductById } from './services/productService.js';
import { processPriceChange } from './services/alertService.js';
import { publishPriceUpdate, addToScrapeQueue, getNextScrapeJob, markScrapeComplete } from './db/redis.js';
import logger, { logScrape, logPriceChange } from './utils/logger.js';
import { sleep, extractDomain } from './utils/helpers.js';
import {
  executeWithResilience,
  isCircuitOpen,
  getCircuitBreakerStates,
} from './shared/resilience.js';
import {
  scrapesTotal,
  scrapeDuration,
  scrapeQueueSize,
  activeScrapes as activeScrapesGauge,
  alertsTriggered,
  priceHistoryInserts,
} from './shared/metrics.js';
import { runRetentionCleanup, getRetentionConfig } from './shared/retention.js';

dotenv.config();

/** Maximum concurrent scrape operations */
const MAX_CONCURRENT_SCRAPES = parseInt(process.env.MAX_CONCURRENT_SCRAPES || '5', 10);

/** Interval between scheduled scrape runs in minutes */
const SCRAPE_INTERVAL_MINUTES = parseInt(process.env.SCRAPE_INTERVAL_MINUTES || '30', 10);

/** Interval for retention cleanup in hours */
const RETENTION_CLEANUP_HOURS = parseInt(process.env.RETENTION_CLEANUP_HOURS || '24', 10);

/** Flag indicating if a scrape job is currently running */
let isRunning = false;

/** Counter for currently active concurrent scrapes */
let activeScrapes = 0;

/** Track last retention cleanup time */
let lastRetentionCleanup = 0;

/**
 * Scrapes a single product with resilience patterns.
 * Uses circuit breaker and retry logic to handle failures gracefully.
 * Updates metrics for monitoring and alerting.
 *
 * @param productId - The UUID of the product to scrape
 */
async function scrapeProduct(productId: string): Promise<void> {
  const product = await getProductById(productId);
  if (!product) {
    logger.warn({ productId, action: 'scrape_skip' }, `Product ${productId} not found`);
    return;
  }

  const domain = extractDomain(product.url);
  const startTime = Date.now();

  // Check if circuit is open before attempting
  if (isCircuitOpen(domain)) {
    logScrape(domain, productId, 'circuit_open', 0);
    scrapesTotal.labels(domain, 'circuit_open').inc();
    return;
  }

  logger.info(
    { productId, domain, title: product.title, action: 'scrape_start' },
    `Scraping product: ${product.title || product.url}`
  );

  try {
    // Execute scrape with circuit breaker and retry protection
    const data = await executeWithResilience(domain, async () => {
      return scraper.scrape(product.url);
    });

    const durationMs = Date.now() - startTime;
    const durationSec = durationMs / 1000;

    if (data.price === null) {
      logger.warn(
        { productId, domain, url: product.url, action: 'scrape_no_price' },
        `Could not extract price for ${product.url}`
      );
      await setProductError(productId, 'Could not extract price');
      scrapesTotal.labels(domain, 'no_price').inc();
      scrapeDuration.labels(domain).observe(durationSec);
      return;
    }

    // Update product with new price
    await updateProductPrice(
      productId,
      data.price,
      data.title || undefined,
      data.image_url || undefined,
      data.availability
    );

    // Track price history insertion
    priceHistoryInserts.inc();

    // Check for price change and trigger alerts
    if (product.current_price !== null && data.price !== product.current_price) {
      const changePct = ((data.price - product.current_price) / product.current_price) * 100;

      logPriceChange(productId, product.current_price, data.price, changePct);

      // Publish real-time update
      await publishPriceUpdate(productId, data.price, product.current_price);

      // Process alerts and track metrics
      const _alertResult = await processPriceChange({
        product_id: productId,
        old_price: product.current_price,
        new_price: data.price,
        change_pct: changePct,
      });

      // Track alert metrics (if processPriceChange returns alert info)
      if (data.price < product.current_price) {
        alertsTriggered.labels('price_drop').inc();
      }
    }

    // Track success metrics
    scrapesTotal.labels(domain, 'success').inc();
    scrapeDuration.labels(domain).observe(durationSec);
    logScrape(domain, productId, 'success', durationMs);

  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    logScrape(domain, productId, 'failure', durationMs, errorMessage);
    scrapesTotal.labels(domain, 'failure').inc();
    scrapeDuration.labels(domain).observe(durationMs / 1000);

    await setProductError(productId, errorMessage);
  }
}

/**
 * Processes the Redis scrape queue up to the concurrency limit.
 * Spawns concurrent scrape tasks and tracks completion.
 * Updates queue size metrics for monitoring.
 */
async function processQueue(): Promise<void> {
  while (isRunning && activeScrapes < MAX_CONCURRENT_SCRAPES) {
    const productId = await getNextScrapeJob();
    if (!productId) {
      break;
    }

    activeScrapes++;
    activeScrapesGauge.set(activeScrapes);

    // Process in background
    scrapeProduct(productId)
      .finally(() => {
        activeScrapes--;
        activeScrapesGauge.set(activeScrapes);
        markScrapeComplete(productId);
      });
  }
}

/**
 * Populates the Redis scrape queue from the database.
 * Queries for products that are due for scraping based on their
 * priority-based refresh interval. Skips domains with open circuits.
 */
async function populateQueue(): Promise<void> {
  logger.info({ action: 'populate_queue_start' }, 'Populating scrape queue...');

  const products = await getProductsToScrape(100);

  // Filter out products whose domains have open circuits
  const circuitStates = getCircuitBreakerStates();
  const openDomains = new Set(
    Object.entries(circuitStates)
      .filter(([_, state]) => state === 'open')
      .map(([domain]) => domain)
  );

  let skipped = 0;
  for (const product of products) {
    const domain = extractDomain(product.url);
    if (openDomains.has(domain)) {
      skipped++;
      continue;
    }
    await addToScrapeQueue(product.id, product.scrape_priority);
  }

  logger.info(
    {
      action: 'populate_queue_complete',
      total: products.length,
      queued: products.length - skipped,
      skipped,
      openCircuits: openDomains.size,
    },
    `Found ${products.length} products to scrape (${skipped} skipped due to open circuits)`
  );

  // Update queue size metric
  scrapeQueueSize.set(products.length - skipped);
}

/**
 * Executes a complete scrape job cycle.
 * Populates the queue and processes until all products are scraped.
 * Prevents concurrent job runs.
 */
async function runScrapeJob(): Promise<void> {
  if (isRunning) {
    logger.warn({ action: 'scrape_job_skip' }, 'Scrape job already running');
    return;
  }

  isRunning = true;
  const startTime = Date.now();
  logger.info({ action: 'scrape_job_start' }, 'Starting scrape job...');

  try {
    // Populate queue with products that need scraping
    await populateQueue();

    // Process queue until empty
    while (isRunning) {
      await processQueue();

      // Check if there's more work
      const productsRemaining = await getProductsToScrape(1);
      if (productsRemaining.length === 0 && activeScrapes === 0) {
        break;
      }

      // Small delay to prevent tight loop
      await sleep(1000);
    }

    const durationMs = Date.now() - startTime;
    logger.info(
      { action: 'scrape_job_complete', durationMs },
      `Scrape job completed in ${Math.round(durationMs / 1000)}s`
    );
  } catch (error) {
    logger.error(
      { error, action: 'scrape_job_error' },
      'Scrape job failed'
    );
  } finally {
    isRunning = false;
    scrapeQueueSize.set(0);
  }
}

/**
 * Runs retention cleanup if enough time has passed since the last run.
 * Called periodically to avoid running during every scrape cycle.
 */
async function maybeRunRetentionCleanup(): Promise<void> {
  const now = Date.now();
  const cleanupIntervalMs = RETENTION_CLEANUP_HOURS * 60 * 60 * 1000;

  if (now - lastRetentionCleanup < cleanupIntervalMs) {
    return;
  }

  logger.info({ action: 'retention_cleanup_trigger' }, 'Running scheduled retention cleanup');

  try {
    const result = await runRetentionCleanup();
    lastRetentionCleanup = now;
    logger.info(
      {
        action: 'retention_cleanup_success',
        deletedCount: result.deletedCount,
        durationMs: result.durationMs,
      },
      `Retention cleanup completed: deleted ${result.deletedCount} records`
    );
  } catch (error) {
    logger.error(
      { error, action: 'retention_cleanup_error' },
      'Retention cleanup failed'
    );
  }
}

/**
 * Graceful shutdown handler.
 * Stops accepting new work and waits for active scrapes to complete.
 * Force exits after 30 seconds if scrapes don't complete.
 */
function shutdown() {
  logger.info({ action: 'worker_shutdown_start' }, 'Shutting down scraper worker...');
  isRunning = false;

  // Wait for active scrapes to complete
  const checkInterval = setInterval(() => {
    if (activeScrapes === 0) {
      clearInterval(checkInterval);
      logger.info({ action: 'worker_shutdown_complete' }, 'Scraper worker shut down');
      process.exit(0);
    }
  }, 1000);

  // Force exit after 30 seconds
  setTimeout(() => {
    logger.warn({ action: 'worker_shutdown_force' }, 'Force shutting down scraper worker');
    process.exit(1);
  }, 30000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

/**
 * Main entry point for the scraper worker.
 * Runs an initial scrape job, then schedules periodic jobs via cron.
 * Also schedules retention cleanup.
 */
async function main() {
  const retentionConfig = getRetentionConfig();

  logger.info(
    {
      action: 'worker_start',
      maxConcurrentScrapes: MAX_CONCURRENT_SCRAPES,
      scrapeIntervalMinutes: SCRAPE_INTERVAL_MINUTES,
      retentionMaxAgeDays: retentionConfig.maxAgeDays,
    },
    'Price Tracker Scraper Worker starting...'
  );
  logger.info({ maxConcurrentScrapes: MAX_CONCURRENT_SCRAPES }, `Max concurrent scrapes: ${MAX_CONCURRENT_SCRAPES}`);
  logger.info({ scrapeIntervalMinutes: SCRAPE_INTERVAL_MINUTES }, `Scrape interval: ${SCRAPE_INTERVAL_MINUTES} minutes`);

  // Run immediately on start
  await runScrapeJob();

  // Run initial retention cleanup
  await maybeRunRetentionCleanup();

  // Schedule periodic scrape jobs
  cron.schedule(`*/${SCRAPE_INTERVAL_MINUTES} * * * *`, async () => {
    logger.info({ action: 'scheduled_scrape_trigger' }, 'Scheduled scrape job triggered');
    await runScrapeJob();
    await maybeRunRetentionCleanup();
  });

  logger.info({ action: 'worker_ready' }, 'Scraper worker running. Press Ctrl+C to stop.');
}

main().catch((error) => {
  logger.error({ error, action: 'worker_fatal' }, 'Fatal error');
  process.exit(1);
});
