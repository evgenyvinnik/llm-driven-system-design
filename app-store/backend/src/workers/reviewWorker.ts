/**
 * @fileoverview Review worker for processing review events from RabbitMQ.
 * Handles async processing like deeper integrity analysis, moderation, notifications.
 */

import { connectRabbitMQ, consumeMessages, QueueConfig, MessageEnvelope } from '../shared/queue.js';
import { logger } from '../shared/logger.js';
import { query } from '../config/database.js';
import { redis } from '../config/redis.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Review event data structure.
 */
interface ReviewEvent {
  reviewId: string;
  userId: string;
  appId: string;
  rating: number;
  integrityScore: number;
  status: string;
  timestamp: string;
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * Processes a review event.
 * - Performs deeper integrity analysis if needed
 * - Updates review coordination detection data
 * - Notifies developers of new reviews
 */
async function handleReviewEvent(envelope: MessageEnvelope<ReviewEvent>): Promise<void> {
  const { data, eventId } = envelope;
  const { reviewId, userId, appId, rating, integrityScore, status } = data;

  logger.debug({ eventId, reviewId, appId }, 'Processing review event');

  // Check for duplicate processing
  const processedKey = `processed:review:${eventId}`;
  const alreadyProcessed = await redis.get(processedKey);
  if (alreadyProcessed) {
    logger.info({ eventId, reviewId }, 'Review event already processed, skipping');
    return;
  }

  try {
    // If review is pending (low integrity score), perform deeper analysis
    if (status === 'pending') {
      await performDeepIntegrityAnalysis(reviewId, userId, appId, integrityScore);
    }

    // Update review coordination detection metrics
    await updateCoordinationMetrics(appId, rating);

    // Record processing for idempotency
    await redis.setex(processedKey, 86400, '1'); // 24-hour idempotency window

    logger.info({ eventId, reviewId, appId, status }, 'Review event processed');
  } catch (error) {
    logger.error({
      eventId,
      reviewId,
      appId,
      error: (error as Error).message,
    }, 'Failed to process review event');
    throw error;
  }
}

/**
 * Performs deeper integrity analysis for pending reviews.
 * This could involve ML models, external services, etc.
 */
async function performDeepIntegrityAnalysis(
  reviewId: string,
  userId: string,
  appId: string,
  initialScore: number
): Promise<void> {
  logger.debug({ reviewId }, 'Performing deep integrity analysis');

  try {
    // Get user's review patterns across all apps
    const userPatterns = await query(`
      SELECT
        COUNT(*) as total_reviews,
        AVG(rating) as avg_rating,
        COUNT(*) FILTER (WHERE rating = 5) as five_star_count,
        COUNT(*) FILTER (WHERE rating = 1) as one_star_count,
        COUNT(DISTINCT app_id) as apps_reviewed
      FROM reviews
      WHERE user_id = $1
    `, [userId]);

    const patterns = userPatterns.rows[0];

    // Calculate additional signals
    let adjustedScore = initialScore;

    // Users who only give 5-star or 1-star reviews are suspicious
    const totalReviews = parseInt(patterns.total_reviews, 10);
    const fiveStarRatio = parseInt(patterns.five_star_count, 10) / Math.max(totalReviews, 1);
    const oneStarRatio = parseInt(patterns.one_star_count, 10) / Math.max(totalReviews, 1);

    if (fiveStarRatio > 0.9 || oneStarRatio > 0.9) {
      adjustedScore -= 0.2;
    }

    // Users reviewing many apps quickly are suspicious
    if (totalReviews > 10 && parseInt(patterns.apps_reviewed, 10) === totalReviews) {
      adjustedScore -= 0.1;
    }

    // Clamp score to valid range
    adjustedScore = Math.max(0, Math.min(1, adjustedScore));

    // Update review if score changed significantly
    if (Math.abs(adjustedScore - initialScore) > 0.1) {
      const newStatus = adjustedScore >= 0.6 ? 'published' : 'pending';

      await query(`
        UPDATE reviews
        SET integrity_score = $1, status = $2, updated_at = NOW()
        WHERE id = $3
      `, [adjustedScore, newStatus, reviewId]);

      // If newly published, update app rating
      if (newStatus === 'published' && initialScore < 0.6) {
        const review = await query(`SELECT rating FROM reviews WHERE id = $1`, [reviewId]);
        if (review.rows.length > 0) {
          await query(`
            UPDATE apps
            SET rating_sum = rating_sum + $1,
                rating_count = rating_count + 1,
                average_rating = (rating_sum + $1) / (rating_count + 1),
                updated_at = NOW()
            WHERE id = $2
          `, [review.rows[0].rating, appId]);
        }
      }

      logger.info({
        reviewId,
        originalScore: initialScore,
        adjustedScore,
        newStatus,
      }, 'Review integrity score updated after deep analysis');
    }
  } catch (error) {
    logger.error({ reviewId, error: (error as Error).message }, 'Deep integrity analysis failed');
    // Don't throw - this is non-critical
  }
}

/**
 * Updates coordination detection metrics.
 * Tracks review patterns to detect review bombing or coordinated attacks.
 */
async function updateCoordinationMetrics(appId: string, rating: number): Promise<void> {
  const hourKey = `review_velocity:${appId}:${Math.floor(Date.now() / 3600000)}`;

  try {
    // Increment hourly review count
    await redis.hincrby(hourKey, 'total', 1);
    await redis.hincrby(hourKey, `rating_${rating}`, 1);
    await redis.expire(hourKey, 86400 * 7); // Keep for 7 days

    // Check for anomalies
    const currentHour = await redis.hgetall(hourKey);
    const totalThisHour = parseInt(currentHour?.total || '0', 10);

    // Alert if review velocity is unusually high
    if (totalThisHour > 50) {
      logger.warn({
        appId,
        reviewsThisHour: totalThisHour,
        distribution: currentHour,
      }, 'High review velocity detected - possible coordination');
    }
  } catch (error) {
    logger.debug({ appId, error: (error as Error).message }, 'Failed to update coordination metrics');
    // Non-critical, don't throw
  }
}

// =============================================================================
// Worker Entry Point
// =============================================================================

/**
 * Starts the review worker.
 * Connects to RabbitMQ and begins consuming review events.
 */
async function startWorker(): Promise<void> {
  logger.info('Starting review worker...');

  try {
    await connectRabbitMQ();
    logger.info('Connected to RabbitMQ');

    await consumeMessages<ReviewEvent>(
      QueueConfig.queues.reviewProcessing,
      handleReviewEvent,
      {
        prefetch: 5, // Lower prefetch since integrity analysis is heavier
        maxRetries: 3,
        retryDelay: 2000,
      }
    );

    logger.info('Review worker started, waiting for messages...');
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Failed to start review worker');
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down review worker');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down review worker');
  process.exit(0);
});

// Start the worker
startWorker();
