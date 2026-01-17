/**
 * @fileoverview Download worker for processing download events from RabbitMQ.
 * Handles async processing like analytics aggregation, recommendation updates, etc.
 */

import { connectRabbitMQ, consumeMessages, QueueConfig, MessageEnvelope } from '../shared/queue.js';
import { logger } from '../shared/logger.js';
import { query } from '../config/database.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Download event data structure.
 */
interface DownloadEvent {
  downloadId: string;
  appId: string;
  userId: string | null;
  version: string | null;
  country: string | null;
  deviceType: string | null;
  timestamp: string;
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * Processes a download event.
 * - Updates daily download aggregates for ranking calculations
 * - Updates user preferences for recommendation engine
 * - Tracks geographic distribution
 */
async function handleDownloadEvent(envelope: MessageEnvelope<DownloadEvent>): Promise<void> {
  const { data } = envelope;
  const { appId, userId, country, deviceType } = data;

  logger.debug({ eventId: envelope.eventId, appId }, 'Processing download event');

  try {
    // Update daily download aggregates (for ranking velocity)
    const today = new Date().toISOString().split('T')[0];
    await query(`
      INSERT INTO daily_download_stats (app_id, date, download_count, country, device_type)
      VALUES ($1, $2, 1, $3, $4)
      ON CONFLICT (app_id, date, country, device_type)
      DO UPDATE SET download_count = daily_download_stats.download_count + 1
    `, [appId, today, country || 'unknown', deviceType || 'unknown']).catch((err) => {
      // Table might not exist yet - log but don't fail
      logger.debug({ error: err.message }, 'daily_download_stats table may not exist');
    });

    // Update user download history for recommendations
    if (userId) {
      // Get app's category for user preference tracking
      const appResult = await query(`
        SELECT category_id FROM apps WHERE id = $1
      `, [appId]);

      if (appResult.rows.length > 0 && appResult.rows[0].category_id) {
        const categoryId = appResult.rows[0].category_id;

        // Update user category preferences (for recommendations)
        await query(`
          INSERT INTO user_category_preferences (user_id, category_id, score)
          VALUES ($1, $2, 1)
          ON CONFLICT (user_id, category_id)
          DO UPDATE SET score = user_category_preferences.score + 1, updated_at = NOW()
        `, [userId, categoryId]).catch((err) => {
          logger.debug({ error: err.message }, 'user_category_preferences table may not exist');
        });
      }
    }

    logger.info({ eventId: envelope.eventId, appId, userId }, 'Download event processed');
  } catch (error) {
    logger.error({
      eventId: envelope.eventId,
      appId,
      error: (error as Error).message,
    }, 'Failed to process download event');
    throw error;
  }
}

// =============================================================================
// Worker Entry Point
// =============================================================================

/**
 * Starts the download worker.
 * Connects to RabbitMQ and begins consuming download events.
 */
async function startWorker(): Promise<void> {
  logger.info('Starting download worker...');

  try {
    await connectRabbitMQ();
    logger.info('Connected to RabbitMQ');

    await consumeMessages<DownloadEvent>(
      QueueConfig.queues.downloadProcessing,
      handleDownloadEvent,
      {
        prefetch: 10, // Process up to 10 messages concurrently
        maxRetries: 3,
        retryDelay: 1000,
      }
    );

    logger.info('Download worker started, waiting for messages...');
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Failed to start download worker');
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down download worker');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down download worker');
  process.exit(0);
});

// Start the worker
startWorker();
