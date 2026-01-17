const crypto = require('crypto');
const { createModuleLogger } = require('./logger');
const redis = require('../db/redis');

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
const IDEMPOTENCY_TTL = 300;

// Prefix for Redis keys
const IDEMPOTENCY_PREFIX = 'idempotency:submission:';

/**
 * Generate a unique idempotency key from submission data
 */
function generateIdempotencyKey(userId, problemSlug, code, language) {
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
function normalizeCode(code) {
  return code
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * Check if a submission is a duplicate and get existing submission ID
 * Returns null if not a duplicate
 */
async function checkDuplicate(userId, problemSlug, code, language) {
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
    logger.error({ error: error.message }, 'Failed to check idempotency');
    // On error, allow the submission to proceed (fail open)
    return null;
  }
}

/**
 * Store submission for idempotency checking
 */
async function storeSubmission(userId, problemSlug, code, language, submissionId) {
  try {
    const key = IDEMPOTENCY_PREFIX + generateIdempotencyKey(userId, problemSlug, code, language);
    await redis.setex(key, IDEMPOTENCY_TTL, submissionId);

    logger.debug({
      userId,
      problemSlug,
      submissionId
    }, 'Stored submission for idempotency');
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to store idempotency key');
    // Non-critical error, continue processing
  }
}

/**
 * Express middleware for idempotency based on Idempotency-Key header
 * This is an alternative approach using client-provided keys
 */
function idempotencyMiddleware(keyPrefix = 'idempotency:') {
  return async (req, res, next) => {
    const idempotencyKey = req.headers['idempotency-key'];

    if (!idempotencyKey) {
      // No idempotency key provided, proceed normally
      return next();
    }

    const redisKey = `${keyPrefix}${idempotencyKey}`;

    try {
      // Check if we've already processed this request
      const cachedResponse = await redis.get(redisKey);

      if (cachedResponse) {
        const { statusCode, body } = JSON.parse(cachedResponse);
        logger.info({ idempotencyKey }, 'Returning cached response for idempotent request');
        return res.status(statusCode).json(body);
      }

      // Store the original res.json to intercept the response
      const originalJson = res.json.bind(res);

      res.json = function(body) {
        // Cache the response for future duplicate requests
        const responseData = {
          statusCode: res.statusCode,
          body
        };

        redis.setex(redisKey, IDEMPOTENCY_TTL, JSON.stringify(responseData))
          .catch(err => logger.error({ error: err.message }, 'Failed to cache idempotent response'));

        return originalJson(body);
      };

      next();
    } catch (error) {
      logger.error({ error: error.message, idempotencyKey }, 'Idempotency check failed');
      // Fail open - allow request to proceed
      next();
    }
  };
}

/**
 * Check for duplicate submission based on content hash (without header)
 * Returns middleware that adds duplicateSubmissionId to req if duplicate found
 */
function submissionIdempotency() {
  return async (req, res, next) => {
    const { problemSlug, language, code } = req.body;
    const userId = req.session?.userId;

    if (!userId || !problemSlug || !code || !language) {
      return next();
    }

    const existingSubmissionId = await checkDuplicate(userId, problemSlug, code, language);

    if (existingSubmissionId) {
      // Return the existing submission instead of creating a new one
      return res.status(200).json({
        submissionId: existingSubmissionId,
        status: 'duplicate',
        message: 'Identical submission already exists. Returning existing submission ID.'
      });
    }

    // Store helper for later use after submission is created
    req.storeIdempotencyKey = async (submissionId) => {
      await storeSubmission(userId, problemSlug, code, language, submissionId);
    };

    next();
  };
}

module.exports = {
  checkDuplicate,
  storeSubmission,
  generateIdempotencyKey,
  idempotencyMiddleware,
  submissionIdempotency,
  IDEMPOTENCY_TTL
};
