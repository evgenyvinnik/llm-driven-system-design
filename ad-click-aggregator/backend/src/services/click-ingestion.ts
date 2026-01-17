import { v4 as uuidv4 } from 'uuid';
import type { ClickEvent, ClickEventInput } from '../types/index.js';
import { query } from './database.js';
import {
  isDuplicateClick,
  markClickProcessed,
  incrementRealTimeCounter,
  trackUniqueUser,
} from './redis.js';
import { detectFraud } from './fraud-detection.js';
import { updateAggregates } from './aggregation.js';

interface ClickIngestionResult {
  success: boolean;
  click_id: string;
  is_duplicate: boolean;
  is_fraudulent: boolean;
  fraud_reason?: string;
  message: string;
}

/**
 * Format a date to a minute bucket string (YYYY-MM-DD HH:MM:00)
 */
function getMinuteBucket(date: Date): string {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d.toISOString().slice(0, 16) + ':00Z';
}

/**
 * Process an incoming click event
 * Handles deduplication, fraud detection, and storage
 */
export async function processClickEvent(input: ClickEventInput): Promise<ClickIngestionResult> {
  // Generate click_id if not provided
  const clickId = input.click_id || uuidv4();

  // Check for duplicate click
  const isDuplicate = await isDuplicateClick(clickId);
  if (isDuplicate) {
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

  // Store raw click event in database
  await storeClickEvent(clickEvent);

  // Mark click as processed for deduplication
  await markClickProcessed(clickId);

  // Update real-time counters in Redis
  const timeBucket = getMinuteBucket(clickEvent.timestamp);
  await incrementRealTimeCounter(clickEvent.ad_id, clickEvent.campaign_id, timeBucket);

  // Track unique users if user_id is provided
  if (clickEvent.user_id) {
    await trackUniqueUser(clickEvent.ad_id, clickEvent.user_id, timeBucket);
  }

  // Update aggregation tables
  await updateAggregates(clickEvent);

  return {
    success: true,
    click_id: clickId,
    is_duplicate: false,
    is_fraudulent: fraudResult.is_fraudulent,
    fraud_reason: fraudResult.reason,
    message: fraudResult.is_fraudulent
      ? 'Click recorded but flagged as potentially fraudulent'
      : 'Click recorded successfully',
  };
}

/**
 * Store a click event in the database
 */
async function storeClickEvent(click: ClickEvent): Promise<void> {
  const sql = `
    INSERT INTO click_events (
      click_id, ad_id, campaign_id, advertiser_id, user_id,
      timestamp, device_type, os, browser, country, region,
      ip_hash, is_fraudulent, fraud_reason
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
  ]);
}

/**
 * Batch process multiple click events
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
