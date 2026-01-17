/**
 * Scraper worker process for fetching product prices.
 * Runs independently of the API server as a cron-scheduled job.
 * Processes products from a Redis-backed priority queue, respecting
 * rate limits and concurrency settings.
 * @module scraper-worker
 */
import cron from 'node-cron';
import dotenv from 'dotenv';

import { scraper } from './services/scraperService.js';
import { getProductsToScrape, updateProductPrice, setProductError } from './services/productService.js';
import { processPriceChange } from './services/alertService.js';
import { publishPriceUpdate, addToScrapeQueue, getNextScrapeJob, markScrapeComplete } from './db/redis.js';
import logger from './utils/logger.js';
import { sleep } from './utils/helpers.js';

dotenv.config();

/** Maximum concurrent scrape operations */
const MAX_CONCURRENT_SCRAPES = parseInt(process.env.MAX_CONCURRENT_SCRAPES || '5', 10);

/** Interval between scheduled scrape runs in minutes */
const SCRAPE_INTERVAL_MINUTES = parseInt(process.env.SCRAPE_INTERVAL_MINUTES || '30', 10);

/** Flag indicating if a scrape job is currently running */
let isRunning = false;

/** Counter for currently active concurrent scrapes */
let activeScrapes = 0;

/**
 * Scrapes a single product and updates the database.
 * Fetches the product URL, extracts price data, updates the database,
 * and triggers alerts if the price changed.
 * @param productId - The UUID of the product to scrape
 */
async function scrapeProduct(productId: string): Promise<void> {
  const { getProductById } = await import('./services/productService.js');

  const product = await getProductById(productId);
  if (!product) {
    logger.warn(`Product ${productId} not found`);
    return;
  }

  logger.info(`Scraping product: ${product.title || product.url}`);

  try {
    const data = await scraper.scrape(product.url);

    if (data.price === null) {
      logger.warn(`Could not extract price for ${product.url}`);
      await setProductError(productId, 'Could not extract price');
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

    // Check for price change and trigger alerts
    if (product.current_price !== null && data.price !== product.current_price) {
      const changePct = ((data.price - product.current_price) / product.current_price) * 100;

      logger.info(
        `Price change detected for ${product.title || product.url}: ` +
        `$${product.current_price} -> $${data.price} (${changePct.toFixed(2)}%)`
      );

      // Publish real-time update
      await publishPriceUpdate(productId, data.price, product.current_price);

      // Process alerts
      await processPriceChange({
        product_id: productId,
        old_price: product.current_price,
        new_price: data.price,
        change_pct: changePct,
      });
    }

    logger.info(`Successfully scraped ${product.url}: $${data.price}`);
  } catch (error) {
    logger.error(`Failed to scrape ${product.url}: ${error}`);
    await setProductError(productId, error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Processes the Redis scrape queue up to the concurrency limit.
 * Spawns concurrent scrape tasks and tracks completion.
 */
async function processQueue(): Promise<void> {
  while (isRunning && activeScrapes < MAX_CONCURRENT_SCRAPES) {
    const productId = await getNextScrapeJob();
    if (!productId) {
      break;
    }

    activeScrapes++;

    // Process in background
    scrapeProduct(productId)
      .finally(() => {
        activeScrapes--;
        markScrapeComplete(productId);
      });
  }
}

/**
 * Populates the Redis scrape queue from the database.
 * Queries for products that are due for scraping based on their
 * priority-based refresh interval.
 */
async function populateQueue(): Promise<void> {
  logger.info('Populating scrape queue...');

  const products = await getProductsToScrape(100);
  logger.info(`Found ${products.length} products to scrape`);

  for (const product of products) {
    await addToScrapeQueue(product.id, product.scrape_priority);
  }
}

/**
 * Executes a complete scrape job cycle.
 * Populates the queue and processes until all products are scraped.
 * Prevents concurrent job runs.
 */
async function runScrapeJob(): Promise<void> {
  if (isRunning) {
    logger.warn('Scrape job already running');
    return;
  }

  isRunning = true;
  logger.info('Starting scrape job...');

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

    logger.info('Scrape job completed');
  } catch (error) {
    logger.error('Scrape job failed:', error);
  } finally {
    isRunning = false;
  }
}

/**
 * Graceful shutdown handler.
 * Stops accepting new work and waits for active scrapes to complete.
 * Force exits after 30 seconds if scrapes don't complete.
 */
function shutdown() {
  logger.info('Shutting down scraper worker...');
  isRunning = false;

  // Wait for active scrapes to complete
  const checkInterval = setInterval(() => {
    if (activeScrapes === 0) {
      clearInterval(checkInterval);
      logger.info('Scraper worker shut down');
      process.exit(0);
    }
  }, 1000);

  // Force exit after 30 seconds
  setTimeout(() => {
    logger.warn('Force shutting down scraper worker');
    process.exit(1);
  }, 30000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

/**
 * Main entry point for the scraper worker.
 * Runs an initial scrape job, then schedules periodic jobs via cron.
 */
async function main() {
  logger.info('Price Tracker Scraper Worker starting...');
  logger.info(`Max concurrent scrapes: ${MAX_CONCURRENT_SCRAPES}`);
  logger.info(`Scrape interval: ${SCRAPE_INTERVAL_MINUTES} minutes`);

  // Run immediately on start
  await runScrapeJob();

  // Schedule periodic scrape jobs
  cron.schedule(`*/${SCRAPE_INTERVAL_MINUTES} * * * *`, async () => {
    logger.info('Scheduled scrape job triggered');
    await runScrapeJob();
  });

  logger.info('Scraper worker running. Press Ctrl+C to stop.');
}

main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
