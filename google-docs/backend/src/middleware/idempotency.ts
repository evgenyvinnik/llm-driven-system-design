/**
 * HTTP Idempotency middleware for POST/PUT/PATCH/DELETE requests.
 * Uses the Idempotency-Key header to detect duplicate requests.
 *
 * WHY: HTTP requests can be retried by clients on network failures.
 * Without idempotency, duplicate POSTs create duplicate resources.
 * With idempotency, retries return the same result as the original request.
 */

import { Request, Response, NextFunction } from 'express';
import {
  getIdempotencyResult,
  setIdempotencyResult,
  generateRequestKey,
  acquireIdempotencyLock,
  releaseIdempotencyLock,
} from '../shared/idempotency.js';
import logger from '../shared/logger.js';

/**
 * Idempotency middleware for HTTP requests.
 * Checks for Idempotency-Key header and returns cached response if found.
 * Stores the response for future duplicate requests.
 *
 * Usage:
 * ```
 * router.post('/documents', authenticate, idempotency, async (req, res) => { ... });
 * ```
 */
export async function idempotency(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const clientKey = req.headers['idempotency-key'] as string | undefined;

  // Skip for non-mutating methods
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    next();
    return;
  }

  // Without client key, proceed without idempotency
  if (!clientKey) {
    next();
    return;
  }

  const userId = req.user?.id;
  if (!userId) {
    next();
    return;
  }

  const idempotencyKey = generateRequestKey(clientKey, req.method, req.path, userId);
  if (!idempotencyKey) {
    next();
    return;
  }

  try {
    // Check for cached result
    const cachedResult = await getIdempotencyResult(idempotencyKey);
    if (cachedResult) {
      logger.debug({ idempotency_key: clientKey, path: req.path }, 'Idempotency cache hit');

      res.setHeader('Idempotency-Replayed', 'true');
      res.status(cachedResult.statusCode || 200).json(cachedResult.result);
      return;
    }

    // Try to acquire lock to prevent concurrent processing
    const lockAcquired = await acquireIdempotencyLock(idempotencyKey);
    if (!lockAcquired) {
      // Another request is processing, wait briefly and check for result
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await getIdempotencyResult(idempotencyKey);
      if (result) {
        res.setHeader('Idempotency-Replayed', 'true');
        res.status(result.statusCode || 200).json(result.result);
        return;
      }
      // Still no result, return conflict
      res.status(409).json({
        success: false,
        error: 'Request with this idempotency key is already being processed',
      });
      return;
    }

    // Attach idempotency key info to request for storage after response
    (req as Request & { idempotencyKey?: string }).idempotencyKey = idempotencyKey;

    // Override res.json to capture response
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      // Store result for future idempotent requests
      setIdempotencyResult(idempotencyKey!, body, res.statusCode).then(() => {
        releaseIdempotencyLock(idempotencyKey!);
      }).catch((error) => {
        logger.error({ error, idempotency_key: clientKey }, 'Failed to store idempotency result');
        releaseIdempotencyLock(idempotencyKey!);
      });

      return originalJson(body);
    } as Response['json'];

    next();
  } catch (error) {
    logger.error({ error, idempotency_key: clientKey }, 'Idempotency middleware error');
    // Fail open - continue without idempotency
    next();
  }
}

export default idempotency;
