import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { createModuleLogger } from './logger.js';
import redis from '../db/redis.js';

const logger = createModuleLogger('idempotency');

/**
 * Idempotency middleware for submission handling
 *
 * Idempotency prevents duplicate executions when:
 * - Client retries due to network issues
 * - User double-clicks submit button
 * - Frontend makes duplicate requests
 *
 * Each submission is identified by a hash of (userId, problemSlug, code, language)
 * If the same submission is made within the TTL window, the existing submission ID is returned.
 */

// TTL for idempotency keys (5 minutes)
export const IDEMPOTENCY_TTL = 300;

// Prefix for Redis keys
const IDEMPOTENCY_PREFIX = 'idempotency:submission:';

/**
 * Generate a unique idempotency key from submission data
 */
export function generateIdempotencyKey(userId: string, problemSlug: string, code: string, language: string): string {
  const data = JSON.stringify({
    userId,
    problemSlug,
    code: normalizeCode(code),
    language
  });

  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Normalize code for comparison (remove trailing whitespace, normalize line endings)
 */
function normalizeCode(code: string): string {
  return code
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * Check if a submission is a duplicate and get existing submission ID
 * Returns null if not a duplicate
 */
export async function checkDuplicate(userId: string, problemSlug: string, code: string, language: string): Promise<string | null> {
  try {
    const key = IDEMPOTENCY_PREFIX + generateIdempotencyKey(userId, problemSlug, code, language);
    const existingSubmissionId = await redis.get(key);

    if (existingSubmissionId) {
      logger.info({
        userId,
        problemSlug,
        existingSubmissionId
      }, 'Duplicate submission detected');
      return existingSubmissionId;
    }

    return null;
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Failed to check idempotency');
    // On error, allow the submission to proceed (fail open)
    return null;
  }
}

/**
 * Store submission for idempotency checking
 */
export async function storeSubmission(userId: string, problemSlug: string, code: string, language: string, submissionId: string): Promise<void> {
  try {
    const key = IDEMPOTENCY_PREFIX + generateIdempotencyKey(userId, problemSlug, code, language);
    await redis.setex(key, IDEMPOTENCY_TTL, submissionId);

    logger.debug({
      userId,
      problemSlug,
      submissionId
    }, 'Stored submission for idempotency');
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Failed to store idempotency key');
    // Non-critical error, continue processing
  }
}

// Extend Request type to include storeIdempotencyKey
declare global {
  namespace Express {
    interface Request {
      storeIdempotencyKey?: (submissionId: string) => Promise<void>;
    }
  }
}

/**
 * Express middleware for idempotency based on Idempotency-Key header
 * This is an alternative approach using client-provided keys
 */
export function idempotencyMiddleware(keyPrefix = 'idempotency:'): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    if (!idempotencyKey) {
      // No idempotency key provided, proceed normally
      next();
      return;
    }

    const redisKey = `${keyPrefix}${idempotencyKey}`;

    try {
      // Check if we've already processed this request
      const cachedResponse = await redis.get(redisKey);

      if (cachedResponse) {
        const { statusCode, body } = JSON.parse(cachedResponse);
        logger.info({ idempotencyKey }, 'Returning cached response for idempotent request');
        res.status(statusCode).json(body);
        return;
      }

      // Store the original res.json to intercept the response
      const originalJson = res.json.bind(res);

      res.json = function(body: unknown) {
        // Cache the response for future duplicate requests
        const responseData = {
          statusCode: res.statusCode,
          body
        };

        redis.setex(redisKey, IDEMPOTENCY_TTL, JSON.stringify(responseData))
          .catch((err: Error) => logger.error({ error: err.message }, 'Failed to cache idempotent response'));

        return originalJson(body);
      };

      next();
    } catch (error) {
      logger.error({ error: (error as Error).message, idempotencyKey }, 'Idempotency check failed');
      // Fail open - allow request to proceed
      next();
    }
  };
}

/**
 * Check for duplicate submission based on content hash (without header)
 * Returns middleware that adds duplicateSubmissionId to req if duplicate found
 */
export function submissionIdempotency(): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { problemSlug, language, code } = req.body as { problemSlug?: string; language?: string; code?: string };
    const userId = req.session?.userId;

    if (!userId || !problemSlug || !code || !language) {
      next();
      return;
    }

    const existingSubmissionId = await checkDuplicate(userId, problemSlug, code, language);

    if (existingSubmissionId) {
      // Return the existing submission instead of creating a new one
      res.status(200).json({
        submissionId: existingSubmissionId,
        status: 'duplicate',
        message: 'Identical submission already exists. Returning existing submission ID.'
      });
      return;
    }

    // Store helper for later use after submission is created
    req.storeIdempotencyKey = async (submissionId: string) => {
      await storeSubmission(userId, problemSlug, code, language, submissionId);
    };

    next();
  };
}
