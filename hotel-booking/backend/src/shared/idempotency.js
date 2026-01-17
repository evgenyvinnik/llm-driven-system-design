/**
 * Idempotency Handler for Booking Operations
 *
 * WHY idempotency prevents double-charging guests:
 * - Network failures can cause client retries
 * - Users may double-click submit buttons
 * - Load balancers may retry failed requests
 *
 * Without idempotency:
 * - Guest submits booking, network times out
 * - Booking was created, but guest doesn't see confirmation
 * - Guest retries, creates SECOND booking
 * - Guest is charged twice for same stay
 *
 * With idempotency:
 * - First request creates booking with idempotency_key hash
 * - Retry finds existing booking by idempotency_key
 * - Returns same booking, no double-charge
 */

const db = require('../models/db');
const redis = require('../models/redis');
const { logger } = require('./logger');
const metrics = require('./metrics');
const crypto = require('crypto');

// Cache TTL for idempotency checks (in seconds)
const IDEMPOTENCY_CACHE_TTL = 86400; // 24 hours

/**
 * Generate an idempotency key for a booking request
 * @param {string} userId - User making the request
 * @param {Object} bookingData - Booking request data
 * @returns {string} SHA-256 hash as idempotency key
 */
function generateIdempotencyKey(userId, bookingData) {
  const { hotelId, roomTypeId, checkIn, checkOut, roomCount } = bookingData;

  // Create a deterministic string from booking parameters
  const keyString = [
    userId,
    hotelId,
    roomTypeId,
    checkIn,
    checkOut,
    roomCount || 1,
  ].join(':');

  return crypto.createHash('sha256').update(keyString).digest('hex');
}

/**
 * Generate an idempotency key from client-provided header
 * Useful for payment confirmations where client controls the key
 * @param {string} clientKey - Client-provided idempotency key
 * @param {string} userId - User ID for namespacing
 * @returns {string} Namespaced idempotency key
 */
function generateClientIdempotencyKey(clientKey, userId) {
  return crypto
    .createHash('sha256')
    .update(`${userId}:${clientKey}`)
    .digest('hex');
}

/**
 * Check if a booking with this idempotency key already exists
 * Uses Redis cache first, then falls back to database
 * @param {string} idempotencyKey - The idempotency key to check
 * @returns {Object|null} Existing booking or null
 */
async function checkIdempotency(idempotencyKey) {
  // Check Redis cache first
  const cacheKey = `idempotency:${idempotencyKey}`;
  const cached = await redis.get(cacheKey);

  if (cached) {
    logger.debug({ idempotencyKey }, 'Idempotency cache hit');
    metrics.idempotentRequestsTotal.inc({ deduplicated: 'true' });
    return JSON.parse(cached);
  }

  // Check database
  const result = await db.query(
    'SELECT * FROM bookings WHERE idempotency_key = $1',
    [idempotencyKey]
  );

  if (result.rows.length > 0) {
    const booking = result.rows[0];

    // Cache for future requests
    await redis.setex(cacheKey, IDEMPOTENCY_CACHE_TTL, JSON.stringify(booking));

    logger.info(
      { idempotencyKey, bookingId: booking.id },
      'Duplicate booking request detected'
    );
    metrics.idempotentRequestsTotal.inc({ deduplicated: 'true' });

    return booking;
  }

  metrics.idempotentRequestsTotal.inc({ deduplicated: 'false' });
  return null;
}

/**
 * Cache a successful booking for idempotency checks
 * @param {string} idempotencyKey - The idempotency key
 * @param {Object} booking - The booking object
 */
async function cacheIdempotencyResult(idempotencyKey, booking) {
  const cacheKey = `idempotency:${idempotencyKey}`;
  await redis.setex(cacheKey, IDEMPOTENCY_CACHE_TTL, JSON.stringify(booking));
}

/**
 * Express middleware to extract idempotency key from header
 * Sets req.idempotencyKey if X-Idempotency-Key header is present
 */
function idempotencyMiddleware(req, res, next) {
  const clientKey = req.headers['x-idempotency-key'];

  if (clientKey && req.user) {
    req.idempotencyKey = generateClientIdempotencyKey(clientKey, req.user.id);
    req.hasClientIdempotencyKey = true;
  }

  next();
}

/**
 * Decorator for idempotent operations
 * Wraps a function to check for existing results before executing
 * @param {Function} operation - The operation to make idempotent
 * @param {Function} keyGenerator - Function to generate idempotency key from args
 * @param {Function} resultGetter - Function to fetch existing result by key
 * @returns {Function} Idempotent version of the operation
 */
function makeIdempotent(operation, keyGenerator, resultGetter) {
  return async function (...args) {
    const idempotencyKey = keyGenerator(...args);

    // Check for existing result
    const existing = await resultGetter(idempotencyKey);
    if (existing) {
      logger.info({ idempotencyKey }, 'Returning cached idempotent result');
      return { result: existing, deduplicated: true };
    }

    // Execute operation
    const result = await operation(...args);
    return { result, deduplicated: false };
  };
}

module.exports = {
  generateIdempotencyKey,
  generateClientIdempotencyKey,
  checkIdempotency,
  cacheIdempotencyResult,
  idempotencyMiddleware,
  makeIdempotent,
  IDEMPOTENCY_CACHE_TTL,
};
