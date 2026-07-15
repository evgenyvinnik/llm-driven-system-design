/**
 * @fileoverview ClickHouse client for time-series analytics.
 * Provides connection management and query helpers for the columnar OLAP database.
 * ClickHouse handles click event storage and auto-aggregation via materialized views.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient, ClickHouseClient, ClickHouseLogLevel } from '@clickhouse/client';
import { logger } from '../shared/logger.js';

let client: ClickHouseClient | null = null;

/**
 * ClickHouse connection configuration from environment variables.
 */
const CLICKHOUSE_CONFIG = {
  host: process.env.CLICKHOUSE_HOST || 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER || 'adclick',
  password: process.env.CLICKHOUSE_PASSWORD || 'adclick123',
  database: process.env.CLICKHOUSE_DATABASE || 'adclick',
};

/**
 * Initializes the ClickHouse client connection.
 * Should be called once during application startup.
 */
export async function initClickHouse(): Promise<void> {
  const log = logger.child({ source: 'clickhouse' });

  try {
    client = createClient({
      url: CLICKHOUSE_CONFIG.host,
      username: CLICKHOUSE_CONFIG.username,
      password: CLICKHOUSE_CONFIG.password,
      database: CLICKHOUSE_CONFIG.database,
      log: {
        level: ClickHouseLogLevel.WARN,
      },
      clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 0,
      },
    });

    // Verify connection
    const result = await client.ping();
    if (result.success) {
      log.info({ host: CLICKHOUSE_CONFIG.host }, 'ClickHouse connected successfully');
    } else {
      throw new Error('ClickHouse ping failed');
    }

    // Apply schema on boot. The docker-entrypoint-initdb.d mount only runs on a
    // fresh volume, so a persisted (or partially-initialized) volume can leave
    // the tables/materialized views missing. The schema is idempotent
    // (CREATE ... IF NOT EXISTS), so re-running it every boot is safe and
    // self-healing.
    try {
      const schemaPath = join(__dirname, '../../db/clickhouse-init.sql');
      const schema = readFileSync(schemaPath, 'utf-8');
      for (const stmt of schema.split(';')) {
        const query = stmt.trim();
        if (query) {
          await client.command({ query });
        }
      }
      log.info('ClickHouse schema ensured');
    } catch (schemaError) {
      log.error({ error: schemaError }, 'Failed to apply ClickHouse schema');
    }
  } catch (error) {
    log.error({ error }, 'Failed to connect to ClickHouse');
    throw error;
  }
}

/**
 * Returns the ClickHouse client instance.
 * @throws Error if client is not initialized
 */
export function getClickHouseClient(): ClickHouseClient {
  if (!client) {
    throw new Error('ClickHouse client not initialized. Call initClickHouse() first.');
  }
  return client;
}

/**
 * Closes the ClickHouse client connection.
 * Should be called during graceful shutdown.
 */
export async function closeClickHouse(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    logger.info('ClickHouse connection closed');
  }
}

/**
 * Click event structure for ClickHouse insertion.
 */
export interface ClickHouseClickEvent {
  click_id: string;
  ad_id: string;
  campaign_id: string;
  advertiser_id: string;
  user_id: string | null;
  timestamp: Date;
  device_type: string;
  os: string;
  browser: string;
  country: string;
  region: string | null;
  ip_hash: string | null;
  is_fraudulent: number;
  fraud_reason: string | null;
}

/**
 * Inserts a click event into ClickHouse.
 * Uses async insert for high throughput (does not wait for confirmation).
 * Materialized views automatically populate aggregation tables.
 *
 * @param event - Click event to insert
 */
export async function insertClickEvent(event: ClickHouseClickEvent): Promise<void> {
  const ch = getClickHouseClient();

  await ch.insert({
    table: 'click_events',
    values: [
      {
        click_id: event.click_id,
        ad_id: event.ad_id,
        campaign_id: event.campaign_id,
        advertiser_id: event.advertiser_id,
        user_id: event.user_id,
        timestamp: event.timestamp.toISOString().replace('T', ' ').replace('Z', ''),
        device_type: event.device_type || 'unknown',
        os: event.os || 'unknown',
        browser: event.browser || 'unknown',
        country: event.country || 'unknown',
        region: event.region,
        ip_hash: event.ip_hash,
        is_fraudulent: event.is_fraudulent,
        fraud_reason: event.fraud_reason,
      },
    ],
    format: 'JSONEachRow',
  });
}

/**
 * Inserts multiple click events in a single batch.
 * More efficient than individual inserts for high-volume ingestion.
 *
 * @param events - Array of click events to insert
 */
export async function insertClickEventsBatch(events: ClickHouseClickEvent[]): Promise<void> {
  if (events.length === 0) return;

  const ch = getClickHouseClient();

  await ch.insert({
    table: 'click_events',
    values: events.map((event) => ({
      click_id: event.click_id,
      ad_id: event.ad_id,
      campaign_id: event.campaign_id,
      advertiser_id: event.advertiser_id,
      user_id: event.user_id,
      timestamp: event.timestamp.toISOString().replace('T', ' ').replace('Z', ''),
      device_type: event.device_type || 'unknown',
      os: event.os || 'unknown',
      browser: event.browser || 'unknown',
      country: event.country || 'unknown',
      region: event.region,
      ip_hash: event.ip_hash,
      is_fraudulent: event.is_fraudulent,
      fraud_reason: event.fraud_reason,
    })),
    format: 'JSONEachRow',
  });
}

/**
 * Aggregate query result row structure.
 */
export interface AggregateRow {
  time_bucket: string;
  ad_id?: string;
  campaign_id?: string;
  country?: string;
  device_type?: string;
  click_count: number;
  unique_users: number;
  fraud_count: number;
}

/**
 * Queries aggregated click data from ClickHouse.
 * Automatically selects the appropriate pre-aggregated table based on granularity.
 *
 * @param params - Query parameters
 * @returns Aggregated data rows
 */
export async function queryAggregates(params: {
  granularity: 'minute' | 'hour' | 'day';
  startTime: Date;
  endTime: Date;
  campaignId?: string;
  advertiserId?: string;
  adId?: string;
  groupBy?: ('country' | 'device_type')[];
}): Promise<AggregateRow[]> {
  const ch = getClickHouseClient();

  let tableName: string;
  switch (params.granularity) {
    case 'minute':
      tableName = 'click_aggregates_minute';
      break;
    case 'day':
      tableName = 'click_aggregates_day';
      break;
    default:
      tableName = 'click_aggregates_hour';
  }

  const conditions: string[] = [
    `time_bucket >= '${params.startTime.toISOString()}'`,
    `time_bucket <= '${params.endTime.toISOString()}'`,
  ];

  if (params.campaignId) {
    conditions.push(`campaign_id = '${params.campaignId}'`);
  }
  if (params.advertiserId) {
    conditions.push(`advertiser_id = '${params.advertiserId}'`);
  }
  if (params.adId) {
    conditions.push(`ad_id = '${params.adId}'`);
  }

  const groupByFields = ['time_bucket'];
  const selectFields = ['time_bucket'];

  if (params.groupBy?.includes('country')) {
    groupByFields.push('country');
    selectFields.push('country');
  }
  if (params.groupBy?.includes('device_type')) {
    groupByFields.push('device_type');
    selectFields.push('device_type');
  }

  const query = `
    SELECT
      ${selectFields.join(', ')},
      sum(click_count) as click_count,
      sum(unique_users) as unique_users,
      sum(fraud_count) as fraud_count
    FROM ${tableName}
    WHERE ${conditions.join(' AND ')}
    GROUP BY ${groupByFields.join(', ')}
    ORDER BY time_bucket ASC
  `;

  const result = await ch.query({
    query,
    format: 'JSONEachRow',
  });

  const rows = await result.json<AggregateRow>();
  return rows;
}

/**
 * Gets real-time stats for the last N minutes.
 *
 * @param minutes - Number of minutes to look back
 * @returns Time series data with totals
 */
export async function getRealTimeStats(minutes: number = 60): Promise<{
  time_series: { timestamp: string; clicks: number }[];
  total_clicks: number;
  clicks_per_minute: number;
}> {
  const ch = getClickHouseClient();

  const query = `
    SELECT
      time_bucket,
      sum(click_count) as clicks
    FROM click_aggregates_minute
    WHERE time_bucket >= now() - INTERVAL ${minutes} MINUTE
    GROUP BY time_bucket
    ORDER BY time_bucket ASC
  `;

  const result = await ch.query({
    query,
    format: 'JSONEachRow',
  });

  const rows = await result.json<{ time_bucket: string; clicks: number }>();

  let totalClicks = 0;
  const timeSeries = rows.map((row) => {
    totalClicks += Number(row.clicks);
    return {
      timestamp: row.time_bucket,
      clicks: Number(row.clicks),
    };
  });

  return {
    time_series: timeSeries,
    total_clicks: totalClicks,
    clicks_per_minute: minutes > 0 ? totalClicks / minutes : 0,
  };
}

/**
 * Gets campaign summary with top countries and devices.
 *
 * @param campaignId - Campaign to summarize
 * @param startTime - Start of reporting period
 * @param endTime - End of reporting period
 */
export async function getCampaignSummary(
  campaignId: string,
  startTime: Date,
  endTime: Date
): Promise<{
  total_clicks: number;
  unique_users: number;
  fraud_count: number;
  fraud_rate: number;
  top_countries: { country: string; clicks: number }[];
  top_devices: { device_type: string; clicks: number }[];
}> {
  const ch = getClickHouseClient();

  // Get totals
  const totalsQuery = `
    SELECT
      sum(click_count) as total_clicks,
      sum(unique_users) as unique_users,
      sum(fraud_count) as fraud_count
    FROM click_aggregates_hour
    WHERE campaign_id = '${campaignId}'
      AND time_bucket >= '${startTime.toISOString()}'
      AND time_bucket <= '${endTime.toISOString()}'
  `;

  const totalsResult = await ch.query({ query: totalsQuery, format: 'JSONEachRow' });
  const totals = (await totalsResult.json<{
    total_clicks: number;
    unique_users: number;
    fraud_count: number;
  }>())[0] || { total_clicks: 0, unique_users: 0, fraud_count: 0 };

  // Get top countries
  const countriesQuery = `
    SELECT country, sum(click_count) as clicks
    FROM click_aggregates_hour
    WHERE campaign_id = '${campaignId}'
      AND time_bucket >= '${startTime.toISOString()}'
      AND time_bucket <= '${endTime.toISOString()}'
    GROUP BY country
    ORDER BY clicks DESC
    LIMIT 10
  `;

  const countriesResult = await ch.query({ query: countriesQuery, format: 'JSONEachRow' });
  const countries = await countriesResult.json<{ country: string; clicks: number }>();

  // Get top devices
  const devicesQuery = `
    SELECT device_type, sum(click_count) as clicks
    FROM click_aggregates_hour
    WHERE campaign_id = '${campaignId}'
      AND time_bucket >= '${startTime.toISOString()}'
      AND time_bucket <= '${endTime.toISOString()}'
    GROUP BY device_type
    ORDER BY clicks DESC
    LIMIT 10
  `;

  const devicesResult = await ch.query({ query: devicesQuery, format: 'JSONEachRow' });
  const devices = await devicesResult.json<{ device_type: string; clicks: number }>();

  const totalClicks = Number(totals.total_clicks);
  const fraudCount = Number(totals.fraud_count);

  return {
    total_clicks: totalClicks,
    unique_users: Number(totals.unique_users),
    fraud_count: fraudCount,
    fraud_rate: totalClicks > 0 ? fraudCount / totalClicks : 0,
    top_countries: countries.map((c) => ({ country: c.country, clicks: Number(c.clicks) })),
    top_devices: devices.map((d) => ({ device_type: d.device_type, clicks: Number(d.clicks) })),
  };
}
