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

import { query } from '../models/db.js';
import redis from '../models/redis.js';
import { logger } from './logger.js';
import * as metrics from './metrics.js';
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

// Cache TTL for idempotency checks (in seconds)
export const IDEMPOTENCY_CACHE_TTL = 86400; // 24 hours

// Extend Express Request to include idempotency properties
declare global {
  namespace Express {
    interface Request {
      idempotencyKey?: string;
      hasClientIdempotencyKey?: boolean;
    }
  }
}

export interface BookingIdempotencyData {
  hotelId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  roomCount?: number;
}

export interface BookingRow {
  id: string;
  user_id: string;
  hotel_id: string;
  room_type_id: string;
  check_in: Date;
  check_out: Date;
  room_count: number;
  guest_count: number;
  total_price: string;
  status: string;
  payment_id: string | null;
  reserved_until: Date | null;
  guest_first_name: string;
  guest_last_name: string;
  guest_email: string;
  guest_phone: string;
  special_requests: string | null;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
}

export interface IdempotentResult<T> {
  result: T;
  deduplicated: boolean;
}

/**
 * Generate an idempotency key for a booking request
 * @param userId - User making the request
 * @param bookingData - Booking request data
 * @returns SHA-256 hash as idempotency key
 */
export function generateIdempotencyKey(userId: string, bookingData: BookingIdempotencyData): string {
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
 * @param clientKey - Client-provided idempotency key
 * @param userId - User ID for namespacing
 * @returns Namespaced idempotency key
 */
export function generateClientIdempotencyKey(clientKey: string, userId: string): string {
  return crypto
    .createHash('sha256')
    .update(`${userId}:${clientKey}`)
    .digest('hex');
}

/**
 * Check if a booking with this idempotency key already exists
 * Uses Redis cache first, then falls back to database
 * @param idempotencyKey - The idempotency key to check
 * @returns Existing booking or null
 */
export async function checkIdempotency(idempotencyKey: string): Promise<BookingRow | null> {
  // Check Redis cache first
  const cacheKey = `idempotency:${idempotencyKey}`;
  const cached = await redis.get(cacheKey);

  if (cached) {
    logger.debug({ idempotencyKey }, 'Idempotency cache hit');
    metrics.idempotentRequestsTotal.inc({ deduplicated: 'true' });
    return JSON.parse(cached) as BookingRow;
  }

  // Check database
  const result = await query<BookingRow>(
    'SELECT * FROM bookings WHERE idempotency_key = $1',
    [idempotencyKey]
  );

  if (result.rows.length > 0) {
    const booking = result.rows[0];

    if (booking) {
      // Cache for future requests
      await redis.setex(cacheKey, IDEMPOTENCY_CACHE_TTL, JSON.stringify(booking));

      logger.info(
        { idempotencyKey, bookingId: booking.id },
        'Duplicate booking request detected'
      );
      metrics.idempotentRequestsTotal.inc({ deduplicated: 'true' });

      return booking;
    }
  }

  metrics.idempotentRequestsTotal.inc({ deduplicated: 'false' });
  return null;
}

/**
 * Cache a successful booking for idempotency checks
 * @param idempotencyKey - The idempotency key
 * @param booking - The booking object
 */
export async function cacheIdempotencyResult(
  idempotencyKey: string,
  booking: Record<string, unknown>
): Promise<void> {
  const cacheKey = `idempotency:${idempotencyKey}`;
  await redis.setex(cacheKey, IDEMPOTENCY_CACHE_TTL, JSON.stringify(booking));
}

/**
 * Express middleware to extract idempotency key from header
 * Sets req.idempotencyKey if X-Idempotency-Key header is present
 */
export function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const clientKey = req.headers['x-idempotency-key'] as string | undefined;

  if (clientKey && req.user) {
    req.idempotencyKey = generateClientIdempotencyKey(clientKey, req.user.id);
    req.hasClientIdempotencyKey = true;
  }

  next();
}

/**
 * Decorator for idempotent operations
 * Wraps a function to check for existing results before executing
 * @param operation - The operation to make idempotent
 * @param keyGenerator - Function to generate idempotency key from args
 * @param resultGetter - Function to fetch existing result by key
 * @returns Idempotent version of the operation
 */
export function makeIdempotent<TArgs extends unknown[], TResult>(
  operation: (...args: TArgs) => Promise<TResult>,
  keyGenerator: (...args: TArgs) => string,
  resultGetter: (key: string) => Promise<TResult | null>
): (...args: TArgs) => Promise<IdempotentResult<TResult>> {
  return async function (...args: TArgs): Promise<IdempotentResult<TResult>> {
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

export default {
  generateIdempotencyKey,
  generateClientIdempotencyKey,
  checkIdempotency,
  cacheIdempotencyResult,
  idempotencyMiddleware,
  makeIdempotent,
  IDEMPOTENCY_CACHE_TTL,
};
