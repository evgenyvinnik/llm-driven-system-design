/**
 * Idempotency module for the job scheduler.
 * Prevents duplicate job creation and execution by tracking request keys.
 * Uses Redis for distributed idempotency key storage.
 * @module shared/idempotency
 */

import { Request, Response, NextFunction } from 'express';
import { redis } from '../queue/redis';
import { logger } from '../utils/logger';

/** Redis key prefix for idempotency keys */
const IDEMPOTENCY_PREFIX = 'job_scheduler:idempotency:';

/** Default TTL for idempotency keys (24 hours) */
const DEFAULT_TTL = 86400;

/**
 * Idempotency record stored in Redis.
 */
interface IdempotencyRecord {
  /** HTTP status code of the original response */
  statusCode: number;
  /** Response body of the original request */
  response: unknown;
  /** Timestamp when the record was created */
  createdAt: number;
  /** Whether the request is still processing */
  processing: boolean;
}

/**
 * Generates an idempotency key from request data.
 * Uses a combination of method, path, and body hash.
 * @param req - Express request
 * @param clientKey - Optional client-provided idempotency key
 * @returns Generated idempotency key
 */
function generateIdempotencyKey(req: Request, clientKey?: string): string {
  if (clientKey) {
    return `${IDEMPOTENCY_PREFIX}${clientKey}`;
  }

  // Generate key from request content
  const crypto = require('crypto');
  const content = JSON.stringify({
    method: req.method,
    path: req.path,
    body: req.body,
    userId: req.user?.userId,
  });

  const hash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 32);
  return `${IDEMPOTENCY_PREFIX}${hash}`;
}

/**
 * Checks if a job with the given name already exists and is active.
 * Used to prevent duplicate job scheduling.
 * @param jobName - Name of the job to check
 * @returns True if a duplicate job exists
 */
export async function checkJobIdempotency(jobName: string): Promise<boolean> {
  const key = `${IDEMPOTENCY_PREFIX}job:${jobName}`;
  const exists = await redis.exists(key);
  return exists === 1;
}

/**
 * Marks a job name as used for idempotency checking.
 * @param jobName - Name of the job
 * @param jobId - ID of the created job
 * @param ttl - TTL in seconds (defaults to 24 hours)
 */
export async function markJobCreated(
  jobName: string,
  jobId: string,
  ttl: number = DEFAULT_TTL
): Promise<void> {
  const key = `${IDEMPOTENCY_PREFIX}job:${jobName}`;
  await redis.setex(key, ttl, JSON.stringify({
    jobId,
    createdAt: Date.now(),
  }));
  logger.debug({ jobName, jobId }, 'Marked job as created for idempotency');
}

/**
 * Clears the idempotency marker for a job.
 * Should be called when a job is deleted.
 * @param jobName - Name of the job
 */
export async function clearJobIdempotency(jobName: string): Promise<void> {
  const key = `${IDEMPOTENCY_PREFIX}job:${jobName}`;
  await redis.del(key);
  logger.debug({ jobName }, 'Cleared job idempotency marker');
}

/**
 * Idempotency middleware for HTTP requests.
 * Stores and returns cached responses for duplicate requests.
 * Uses the Idempotency-Key header or generates a key from request content.
 */
export function idempotencyMiddleware(ttl: number = DEFAULT_TTL) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Only apply to POST/PUT requests
    if (!['POST', 'PUT'].includes(req.method)) {
      return next();
    }

    // Get idempotency key from header or generate one
    const clientKey = req.headers['idempotency-key'] as string;
    const key = generateIdempotencyKey(req, clientKey);

    try {
      // Try to get existing record
      const existingData = await redis.get(key);

      if (existingData) {
        const record: IdempotencyRecord = JSON.parse(existingData);

        // If request is still processing, return conflict
        if (record.processing) {
          logger.warn({ key }, 'Duplicate request while processing');
          res.status(409).json({
            success: false,
            error: 'Request is already being processed',
          });
          return;
        }

        // Return cached response
        logger.info({ key }, 'Returning cached idempotent response');
        res.status(record.statusCode).json(record.response);
        return;
      }

      // Mark request as processing
      const processingRecord: IdempotencyRecord = {
        statusCode: 0,
        response: null,
        createdAt: Date.now(),
        processing: true,
      };
      await redis.setex(key, ttl, JSON.stringify(processingRecord));

      // Override res.json to capture the response
      const originalJson = res.json.bind(res);
      res.json = function (body: unknown): Response {
        // Store the response for future requests
        const finalRecord: IdempotencyRecord = {
          statusCode: res.statusCode,
          response: body,
          createdAt: processingRecord.createdAt,
          processing: false,
        };

        redis.setex(key, ttl, JSON.stringify(finalRecord)).catch((error) => {
          logger.error({ err: error, key }, 'Failed to store idempotency record');
        });

        return originalJson(body);
      };

      next();
    } catch (error) {
      logger.error({ err: error, key }, 'Idempotency check failed');
      // On error, proceed without idempotency check
      next();
    }
  };
}

/**
 * Checks if a job execution is already in progress.
 * Used to prevent duplicate executions of the same job.
 * @param jobId - Job ID
 * @param scheduledAt - Scheduled execution time
 * @returns True if execution is already in progress
 */
export async function checkExecutionIdempotency(
  jobId: string,
  scheduledAt: Date
): Promise<boolean> {
  const key = `${IDEMPOTENCY_PREFIX}execution:${jobId}:${scheduledAt.toISOString()}`;
  const exists = await redis.exists(key);
  return exists === 1;
}

/**
 * Marks an execution as in progress.
 * @param jobId - Job ID
 * @param executionId - Execution ID
 * @param scheduledAt - Scheduled execution time
 * @param ttl - TTL in seconds
 */
export async function markExecutionStarted(
  jobId: string,
  executionId: string,
  scheduledAt: Date,
  ttl: number = 3600
): Promise<boolean> {
  const key = `${IDEMPOTENCY_PREFIX}execution:${jobId}:${scheduledAt.toISOString()}`;

  // Use SET NX to atomically check and set
  const result = await redis.set(key, JSON.stringify({
    executionId,
    startedAt: Date.now(),
  }), 'EX', ttl, 'NX');

  return result === 'OK';
}

/**
 * Clears an execution idempotency marker.
 * @param jobId - Job ID
 * @param scheduledAt - Scheduled execution time
 */
export async function clearExecutionIdempotency(
  jobId: string,
  scheduledAt: Date
): Promise<void> {
  const key = `${IDEMPOTENCY_PREFIX}execution:${jobId}:${scheduledAt.toISOString()}`;
  await redis.del(key);
}

logger.info('Idempotency module initialized');
