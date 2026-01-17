import {
  getIdempotencyKey,
  setIdempotencyKey,
  acquireIdempotencyLock,
  releaseIdempotencyLock,
} from '../db/redis.js';

/**
 * Idempotency middleware - prevents duplicate requests
 */
export function idempotencyMiddleware(req, res, next) {
  const idempotencyKey = req.headers['idempotency-key'];

  if (!idempotencyKey) {
    // No idempotency key, proceed normally
    return next();
  }

  // Validate key format (max 255 chars)
  if (idempotencyKey.length > 255) {
    return res.status(400).json({
      error: {
        type: 'invalid_request_error',
        message: 'Idempotency key must be 255 characters or fewer',
      },
    });
  }

  const merchantId = req.merchantId;

  if (!merchantId) {
    // Can't use idempotency without merchant context
    return next();
  }

  handleIdempotency(req, res, next, merchantId, idempotencyKey);
}

async function handleIdempotency(req, res, next, merchantId, idempotencyKey) {
  try {
    // Try to acquire lock
    const acquired = await acquireIdempotencyLock(merchantId, idempotencyKey);

    if (!acquired) {
      // Another request with same key is in progress
      return res.status(409).json({
        error: {
          type: 'idempotency_error',
          message: 'A request with this idempotency key is already in progress',
        },
      });
    }

    // Check for cached response
    const cached = await getIdempotencyKey(merchantId, idempotencyKey);
    if (cached) {
      await releaseIdempotencyLock(merchantId, idempotencyKey);

      // Verify request matches
      if (cached.requestPath !== req.path || cached.requestMethod !== req.method) {
        return res.status(422).json({
          error: {
            type: 'idempotency_error',
            message: 'Idempotency key was used for a different request',
          },
        });
      }

      // Return cached response
      return res.status(cached.statusCode).json(cached.body);
    }

    // Store original json method
    const originalJson = res.json.bind(res);

    // Override json to capture response
    res.json = function(body) {
      // Cache successful responses (2xx)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        setIdempotencyKey(merchantId, idempotencyKey, {
          statusCode: res.statusCode,
          body,
          requestPath: req.path,
          requestMethod: req.method,
        }).catch(err => console.error('Failed to cache idempotency:', err));
      }

      // Release lock
      releaseIdempotencyLock(merchantId, idempotencyKey)
        .catch(err => console.error('Failed to release lock:', err));

      return originalJson(body);
    };

    // Attach cleanup for error cases
    res.on('finish', () => {
      releaseIdempotencyLock(merchantId, idempotencyKey)
        .catch(err => console.error('Failed to release lock on finish:', err));
    });

    next();
  } catch (error) {
    console.error('Idempotency middleware error:', error);
    await releaseIdempotencyLock(merchantId, idempotencyKey);
    next(error);
  }
}
