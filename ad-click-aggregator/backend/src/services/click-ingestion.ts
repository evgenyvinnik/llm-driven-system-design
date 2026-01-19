/**
 * @fileoverview Click event ingestion service - the core data pipeline.
 * Handles incoming ad clicks with deduplication, fraud detection,
 * persistent storage, and real-time aggregation updates.
 * Designed for high throughput (10,000+ clicks/second at scale).
 *
 * Key features:
 * - Idempotency: Prevents duplicate click counting via Redis + PostgreSQL UPSERT
 * - Metrics: Prometheus counters/histograms for monitoring ingestion throughput
 * - Structured logging: JSON logs for debugging and auditing
 * - ClickHouse: Time-series storage with auto-aggregation via materialized views
 */

import { v4 as uuidv4 } from 'uuid';
import type { ClickEvent, ClickEventInput } from '../types/index.js';
import { query } from './database.js';
import {
  isDuplicateClick,
  markClickProcessed,
  incrementRealTimeCounter,
  trackUniqueUser,
  checkIdempotencyKey,
  setIdempotencyKey,
} from './redis.js';
import { detectFraud } from './fraud-detection.js';
import { insertClickEvent as insertClickHouseEvent } from './clickhouse.js';
import { logger, logHelpers } from '../shared/logger.js';
import { clickMetrics, aggregationMetrics, timeAsync } from '../shared/metrics.js';
import { IDEMPOTENCY_CONFIG as _IDEMPOTENCY_CONFIG } from '../shared/config.js';

/**
 * Result of processing a click event through the ingestion pipeline.
 */
interface ClickIngestionResult {
  /** Whether processing completed successfully */
  success: boolean;
  /** Unique click identifier */
  click_id: string;
  /** Whether this was a duplicate click (already processed) */
  is_duplicate: boolean;
  /** Whether the click was flagged as fraudulent */
  is_fraudulent: boolean;
  /** Reason for fraud flagging, if applicable */
  fraud_reason?: string;
  /** Human-readable processing status message */
  message: string;
}

/**
 * Formats a date to minute-granularity bucket for aggregation.
 * Used as the key for real-time counters and aggregation tables.
 *
 * @param date - Date to format
 * @returns ISO string truncated to minute (YYYY-MM-DDTHH:MM:00Z)
 */
function getMinuteBucket(date: Date): string {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d.toISOString().slice(0, 16) + ':00Z';
}

/**
 * Main entry point for processing incoming click events.
 * Implements the full ingestion pipeline with idempotency guarantees:
 * 1. Idempotency key check (prevents duplicate requests)
 * 2. Deduplication check via Redis (prevents duplicate click IDs)
 * 3. Fraud detection scoring
 * 4. Persistent storage in PostgreSQL with UPSERT
 * 5. Real-time counter updates in Redis
 * 6. Aggregation table updates
 *
 * WHY IDEMPOTENCY: Network retries, load balancer failovers, and client
 * bugs can cause the same click to be submitted multiple times. Without
 * idempotency, each retry would increment counters, leading to inflated
 * metrics and incorrect billing. The idempotency key (from client) plus
 * click_id deduplication (from Redis TTL) provides defense in depth.
 *
 * @param input - Raw click event input from API
 * @param idempotencyKey - Optional client-provided idempotency key
 * @returns Processing result with click ID and status
 */
export async function processClickEvent(
  input: ClickEventInput,
  idempotencyKey?: string
): Promise<ClickIngestionResult> {
  const startTime = Date.now();
  const log = logger.child({ source: 'click-ingestion' });

  // Track received click
  clickMetrics.received.inc({ source: 'api' });

  // Generate click_id if not provided
  const clickId = input.click_id || uuidv4();

  // Check idempotency key first (client-level deduplication)
  if (idempotencyKey) {
    const existingResult = await checkIdempotencyKey(idempotencyKey);
    if (existingResult) {
      log.debug({ idempotencyKey, clickId }, 'Idempotency key already processed');
      clickMetrics.duplicates.inc();

      // Return the cached result for idempotent response
      const cachedResult = JSON.parse(existingResult) as ClickIngestionResult;
      clickMetrics.latency.observe(
        { status: 'idempotent' },
        (Date.now() - startTime) / 1000
      );
      return cachedResult;
    }
  }

  // Check for duplicate click ID (click-level deduplication)
  const isDuplicate = await isDuplicateClick(clickId);
  if (isDuplicate) {
    logHelpers.duplicateDetected(log, clickId);
    clickMetrics.duplicates.inc();
    clickMetrics.latency.observe(
      { status: 'duplicate' },
      (Date.now() - startTime) / 1000
    );

    return {
      success: true,
      click_id: clickId,
      is_duplicate: true,
      is_fraudulent: false,
      message: 'Click already processed (duplicate)',
    };
  }

  // Create click event with server timestamp
  const clickEvent: ClickEvent = {
    click_id: clickId,
    ad_id: input.ad_id,
    campaign_id: input.campaign_id,
    advertiser_id: input.advertiser_id,
    user_id: input.user_id,
    timestamp: input.timestamp ? new Date(input.timestamp) : new Date(),
    device_type: input.device_type,
    os: input.os,
    browser: input.browser,
    country: input.country,
    region: input.region,
    ip_hash: input.ip_hash,
  };

  // Run fraud detection
  const fraudResult = await detectFraud(clickEvent);
  clickEvent.is_fraudulent = fraudResult.is_fraudulent;
  clickEvent.fraud_reason = fraudResult.reason;

  if (fraudResult.is_fraudulent) {
    logHelpers.fraudDetected(log, clickId, fraudResult.reason || 'unknown', fraudResult.confidence);
    clickMetrics.fraud.inc({ reason: fraudResult.reason?.split(':')[0] || 'unknown' });
  }

  // Store raw click event in database with idempotency key
  await storeClickEvent(clickEvent, idempotencyKey);

  // Mark click as processed for deduplication
  await markClickProcessed(clickId);

  // Update real-time counters in Redis
  const timeBucket = getMinuteBucket(clickEvent.timestamp);
  await incrementRealTimeCounter(clickEvent.ad_id, clickEvent.campaign_id, timeBucket);

  // Track unique users if user_id is provided
  if (clickEvent.user_id) {
    await trackUniqueUser(clickEvent.ad_id, clickEvent.user_id, timeBucket);
  }

  // Insert into ClickHouse for analytics (materialized views handle aggregation)
  await timeAsync(
    aggregationMetrics.latency,
    { granularity: 'all' },
    async () => {
      await insertClickHouseEvent({
        click_id: clickEvent.click_id,
        ad_id: clickEvent.ad_id,
        campaign_id: clickEvent.campaign_id,
        advertiser_id: clickEvent.advertiser_id,
        user_id: clickEvent.user_id || null,
        timestamp: clickEvent.timestamp,
        device_type: clickEvent.device_type || 'unknown',
        os: clickEvent.os || 'unknown',
        browser: clickEvent.browser || 'unknown',
        country: clickEvent.country || 'unknown',
        region: clickEvent.region || null,
        ip_hash: clickEvent.ip_hash || null,
        is_fraudulent: clickEvent.is_fraudulent ? 1 : 0,
        fraud_reason: clickEvent.fraud_reason || null,
      });
      // ClickHouse materialized views auto-aggregate at minute, hour, and day granularities
      aggregationMetrics.updates.inc({ granularity: 'minute' });
      aggregationMetrics.updates.inc({ granularity: 'hour' });
      aggregationMetrics.updates.inc({ granularity: 'day' });
    }
  );

  const result: ClickIngestionResult = {
    success: true,
    click_id: clickId,
    is_duplicate: false,
    is_fraudulent: fraudResult.is_fraudulent,
    fraud_reason: fraudResult.reason,
    message: fraudResult.is_fraudulent
      ? 'Click recorded but flagged as potentially fraudulent'
      : 'Click recorded successfully',
  };

  // Store idempotency result for future lookups
  if (idempotencyKey) {
    await setIdempotencyKey(idempotencyKey, JSON.stringify(result));
  }

  // Track successful processing
  clickMetrics.processed.inc({ campaign_id: input.campaign_id });
  const durationMs = Date.now() - startTime;
  clickMetrics.latency.observe({ status: 'success' }, durationMs / 1000);

  logHelpers.clickIngested(log, clickId, input.ad_id, input.campaign_id, durationMs, {
    is_fraudulent: fraudResult.is_fraudulent,
  });

  return result;
}

/**
 * Persists a click event to the PostgreSQL database.
 * Uses ON CONFLICT DO NOTHING for idempotency - if a click with the same
 * click_id already exists, the INSERT is silently ignored. This ensures
 * that even if deduplication in Redis fails (cache eviction, Redis restart),
 * we never create duplicate database records.
 *
 * @param click - Fully populated click event to store
 * @param idempotencyKey - Optional idempotency key for request tracking
 */
async function storeClickEvent(click: ClickEvent, idempotencyKey?: string): Promise<void> {
  const sql = `
    INSERT INTO click_events (
      click_id, ad_id, campaign_id, advertiser_id, user_id,
      timestamp, device_type, os, browser, country, region,
      ip_hash, is_fraudulent, fraud_reason, idempotency_key, processed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
    ON CONFLICT (click_id) DO NOTHING
  `;

  await query(sql, [
    click.click_id,
    click.ad_id,
    click.campaign_id,
    click.advertiser_id,
    click.user_id,
    click.timestamp,
    click.device_type,
    click.os,
    click.browser,
    click.country,
    click.region,
    click.ip_hash,
    click.is_fraudulent,
    click.fraud_reason,
    idempotencyKey || null,
  ]);
}

/**
 * Processes multiple click events in sequence.
 * Used for batch ingestion endpoints to improve throughput.
 * Each click is processed independently; failures don't affect others.
 *
 * @param inputs - Array of click event inputs to process
 * @returns Array of results matching input order
 */
export async function processBatchClickEvents(
  inputs: ClickEventInput[]
): Promise<ClickIngestionResult[]> {
  const results: ClickIngestionResult[] = [];

  for (const input of inputs) {
    try {
      const result = await processClickEvent(input);
      results.push(result);
    } catch (error) {
      results.push({
        success: false,
        click_id: input.click_id || 'unknown',
        is_duplicate: false,
        is_fraudulent: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return results;
}
