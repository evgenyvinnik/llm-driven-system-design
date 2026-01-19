import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { query } from '../db/pool.js';
import { Queue, Worker, Job } from 'bullmq';
import _redis from '../db/redis.js';

// Interfaces
export interface WebhookEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  created: number;
  api_version: string;
  livemode: boolean;
}

export interface WebhookJobData {
  eventId: string;
  merchantId: string;
  url: string;
  event: WebhookEvent;
  signature: string;
}

export interface WebhookDeliveryResult {
  success: boolean;
  status: number;
  statusText?: string;
  error?: string;
}

export interface WebhookEventRow {
  id: string;
  type: string;
  data: WebhookEvent;
  status: string;
  attempts: number;
  last_error: string | null;
  delivered_at: Date | null;
  created_at: Date;
}

export interface RetryWebhookResult {
  queued: boolean;
}

// BullMQ queue for webhook delivery
const webhookQueue = new Queue<WebhookJobData>('webhook_delivery', {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
});

// Maximum retry attempts
const MAX_ATTEMPTS = 5;

// Exponential backoff delays in ms
const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000];

/**
 * Create and queue a webhook event
 */
export async function sendWebhook(
  merchantId: string,
  eventType: string,
  data: Record<string, unknown>
): Promise<WebhookEvent | null> {
  // Get merchant webhook configuration
  const merchantResult = await query<{ webhook_url: string | null; webhook_secret: string | null }>(
    `
    SELECT webhook_url, webhook_secret FROM merchants WHERE id = $1
  `,
    [merchantId]
  );

  if (merchantResult.rows.length === 0) {
    console.log(`Merchant ${merchantId} not found for webhook`);
    return null;
  }

  const merchant = merchantResult.rows[0];

  if (!merchant.webhook_url) {
    console.log(`Merchant ${merchantId} has no webhook URL configured`);
    return null;
  }

  // Create event record
  const eventId = uuidv4();
  const event: WebhookEvent = {
    id: `evt_${eventId.replace(/-/g, '')}`,
    type: eventType,
    data,
    created: Math.floor(Date.now() / 1000),
    api_version: '2024-01-01',
    livemode: false,
  };

  // Store event in database
  await query(
    `
    INSERT INTO webhook_events (id, merchant_id, type, data)
    VALUES ($1, $2, $3, $4)
  `,
    [eventId, merchantId, eventType, JSON.stringify(event)]
  );

  // Create signature
  const signature = signPayload(event, merchant.webhook_secret);

  // Queue for delivery
  await webhookQueue.add(
    'deliver',
    {
      eventId,
      merchantId,
      url: merchant.webhook_url,
      event,
      signature,
    },
    {
      attempts: MAX_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
    }
  );

  // Create delivery record
  await query(
    `
    INSERT INTO webhook_deliveries (event_id, merchant_id, url, status)
    VALUES ($1, $2, $3, 'pending')
  `,
    [eventId, merchantId, merchant.webhook_url]
  );

  return event;
}

/**
 * Sign webhook payload
 * Format: t=timestamp,v1=signature
 */
export function signPayload(payload: unknown, secret: string | null): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const payloadString = JSON.stringify(payload);
  const signedPayload = `${timestamp}.${payloadString}`;

  const signature = crypto
    .createHmac('sha256', secret || 'default_secret')
    .update(signedPayload)
    .digest('hex');

  return `t=${timestamp},v1=${signature}`;
}

/**
 * Verify webhook signature
 */
export function verifySignature(
  payload: unknown,
  signature: string,
  secret: string,
  tolerance: number = 300
): boolean {
  const parts = signature.split(',');
  const timestampPart = parts.find((p) => p.startsWith('t='));
  const signaturePart = parts.find((p) => p.startsWith('v1='));

  if (!timestampPart || !signaturePart) {
    return false;
  }

  const timestamp = parseInt(timestampPart.slice(2));
  const providedSignature = signaturePart.slice(3);

  // Check timestamp tolerance (prevent replay attacks)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) {
    return false;
  }

  // Reconstruct and verify signature
  const payloadString = JSON.stringify(payload);
  const signedPayload = `${timestamp}.${payloadString}`;
  const expectedSignature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(providedSignature), Buffer.from(expectedSignature));
}

/**
 * Attempt to deliver a webhook
 */
export async function deliverWebhook(
  url: string,
  event: WebhookEvent,
  signature: string
): Promise<WebhookDeliveryResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': signature,
        'User-Agent': 'Stripe-Webhook/1.0',
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    return {
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
    };
  } catch (error) {
    clearTimeout(timeout);
    return {
      success: false,
      status: 0,
      error: (error as Error).message,
    };
  }
}

/**
 * Start webhook delivery worker
 */
export function startWebhookWorker(): Worker<WebhookJobData> {
  const worker = new Worker<WebhookJobData>(
    'webhook_delivery',
    async (job: Job<WebhookJobData>) => {
      const { eventId, merchantId: _merchantId, url, event, signature } = job.data;

      console.log(`Delivering webhook ${event.id} to ${url} (attempt ${job.attemptsMade + 1})`);

      const result = await deliverWebhook(url, event, signature);

      // Update delivery record
      if (result.success) {
        await query(
          `
        UPDATE webhook_deliveries
        SET status = 'delivered', response_status = $2, delivered_at = NOW(), attempts = $3
        WHERE event_id = $1
      `,
          [eventId, result.status, job.attemptsMade + 1]
        );

        console.log(`Webhook ${event.id} delivered successfully`);
      } else {
        const nextRetry =
          job.attemptsMade < MAX_ATTEMPTS - 1 ? new Date(Date.now() + BACKOFF_DELAYS[job.attemptsMade]) : null;

        await query(
          `
        UPDATE webhook_deliveries
        SET attempts = $2, last_error = $3, response_status = $4, next_retry_at = $5,
            status = CASE WHEN $6 THEN 'failed' ELSE 'pending' END
        WHERE event_id = $1
      `,
          [
            eventId,
            job.attemptsMade + 1,
            result.error || result.statusText,
            result.status,
            nextRetry,
            job.attemptsMade >= MAX_ATTEMPTS - 1,
          ]
        );

        // Throw to trigger retry
        throw new Error(`Webhook delivery failed: ${result.error || result.statusText}`);
      }
    },
    {
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
      },
      concurrency: 10,
    }
  );

  worker.on('completed', (job: Job<WebhookJobData>) => {
    console.log(`Webhook job ${job.id} completed`);
  });

  worker.on('failed', (job: Job<WebhookJobData> | undefined, err: Error) => {
    console.log(`Webhook job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}

/**
 * Get webhook events for a merchant
 */
export async function getWebhookEvents(
  merchantId: string,
  limit: number = 50,
  offset: number = 0
): Promise<WebhookEventRow[]> {
  const result = await query<WebhookEventRow>(
    `
    SELECT
      we.id, we.type, we.data, we.created_at,
      wd.status, wd.attempts, wd.last_error, wd.delivered_at
    FROM webhook_events we
    LEFT JOIN webhook_deliveries wd ON wd.event_id = we.id
    WHERE we.merchant_id = $1
    ORDER BY we.created_at DESC
    LIMIT $2 OFFSET $3
  `,
    [merchantId, limit, offset]
  );

  return result.rows;
}

/**
 * Retry failed webhook
 */
export async function retryWebhook(eventId: string): Promise<RetryWebhookResult> {
  const result = await query<{
    id: string;
    merchant_id: string;
    data: WebhookEvent;
    webhook_url: string;
    webhook_secret: string;
  }>(
    `
    SELECT we.*, m.webhook_url, m.webhook_secret
    FROM webhook_events we
    JOIN merchants m ON m.id = we.merchant_id
    WHERE we.id = $1
  `,
    [eventId]
  );

  if (result.rows.length === 0) {
    throw new Error('Webhook event not found');
  }

  const row = result.rows[0];
  const event = row.data;
  const signature = signPayload(event, row.webhook_secret);

  // Queue for delivery
  await webhookQueue.add('deliver', {
    eventId,
    merchantId: row.merchant_id,
    url: row.webhook_url,
    event,
    signature,
  });

  // Reset delivery status
  await query(
    `
    UPDATE webhook_deliveries
    SET status = 'pending', next_retry_at = NULL
    WHERE event_id = $1
  `,
    [eventId]
  );

  return { queued: true };
}
