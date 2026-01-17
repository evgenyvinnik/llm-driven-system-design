/**
 * Idempotency middleware for preventing duplicate submissions.
 * Uses Redis to track processed requests and return cached responses.
 *
 * WHY: Network failures, client retries, and duplicate clicks can cause the same
 * request to be submitted multiple times. Without idempotency, this leads to
 * duplicate data (e.g., multiple identical drawings from one user action).
 * Idempotency keys allow the server to recognize duplicate requests and return
 * the same response without re-processing.
 *
 * @module shared/idempotency
 */

import { Request, Response, NextFunction } from 'express'
import { redis } from './cache.js'
import { logger } from './logger.js'

/**
 * Configuration options for idempotency middleware.
 */
export interface IdempotencyOptions {
  /** Time-to-live for idempotency keys in seconds (default: 3600 = 1 hour) */
  ttlSeconds: number
  /** Header name for client-provided idempotency key (default: 'x-idempotency-key') */
  headerName: string
  /** Prefix for Redis keys (default: 'idem:') */
  keyPrefix: string
  /** Whether to require the idempotency header (default: false) */
  required: boolean
  /** Function to extract additional context for the key (e.g., userId) */
  contextExtractor?: (req: Request) => string
}

/**
 * Default idempotency options.
 */
const DEFAULT_OPTIONS: IdempotencyOptions = {
  ttlSeconds: 3600, // 1 hour
  headerName: 'x-idempotency-key',
  keyPrefix: 'idem:',
  required: false,
}

/**
 * Stored response data for returning on duplicate requests.
 */
interface StoredResponse {
  statusCode: number
  body: unknown
  processedAt: number
}

/**
 * Creates idempotency middleware for Express.
 * Prevents duplicate processing by caching responses keyed by idempotency key.
 *
 * @param operationName - Name of the operation for key namespacing (e.g., 'drawing')
 * @param options - Configuration options
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * app.post('/api/drawings',
 *   idempotencyMiddleware('drawing'),
 *   async (req, res) => {
 *     // This handler will only run once per idempotency key
 *     const drawing = await saveDrawing(req.body)
 *     res.status(201).json(drawing)
 *   }
 * )
 * ```
 */
export function idempotencyMiddleware(
  operationName: string,
  options: Partial<IdempotencyOptions> = {}
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const config: IdempotencyOptions = { ...DEFAULT_OPTIONS, ...options }

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Get idempotency key from header
    let idempotencyKey = req.headers[config.headerName.toLowerCase()] as string | undefined

    // If no key provided and not required, generate one from request body hash
    if (!idempotencyKey) {
      if (config.required) {
        res.status(400).json({
          error: 'Idempotency key required',
          message: `Please provide ${config.headerName} header`,
        })
        return
      }

      // Generate key from request body for implicit idempotency
      idempotencyKey = generateKeyFromRequest(req, config.contextExtractor)
    }

    // Build the full Redis key
    const redisKey = `${config.keyPrefix}${operationName}:${idempotencyKey}`

    try {
      // Check if this request was already processed
      const existing = await redis.get(redisKey)

      if (existing) {
        const stored: StoredResponse = JSON.parse(existing)

        logger.info({
          msg: 'Returning cached idempotent response',
          operation: operationName,
          idempotencyKey,
          processedAt: new Date(stored.processedAt).toISOString(),
        })

        // Return the cached response
        res.status(stored.statusCode).json(stored.body)
        return
      }

      // Mark as processing (with a short TTL to handle crashes)
      await redis.setex(redisKey, 60, JSON.stringify({ processing: true }))

      // Store the original res.json to capture the response
      const originalJson = res.json.bind(res)
      let responseBody: unknown = null

      res.json = function (body: unknown) {
        responseBody = body
        return originalJson(body)
      }

      // Store the original res.status to capture the status code
      let statusCode = 200
      const originalStatus = res.status.bind(res)

      res.status = function (code: number) {
        statusCode = code
        return originalStatus(code)
      }

      // After response is sent, store the result
      res.on('finish', async () => {
        // Only cache successful responses (2xx) and client errors (4xx)
        // Don't cache 5xx errors as they should be retried
        if (statusCode < 500) {
          const stored: StoredResponse = {
            statusCode,
            body: responseBody,
            processedAt: Date.now(),
          }

          try {
            await redis.setex(redisKey, config.ttlSeconds, JSON.stringify(stored))

            logger.debug({
              msg: 'Cached idempotent response',
              operation: operationName,
              idempotencyKey,
              statusCode,
              ttlSeconds: config.ttlSeconds,
            })
          } catch (err) {
            logger.error({
              msg: 'Failed to cache idempotent response',
              operation: operationName,
              idempotencyKey,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        } else {
          // Delete the processing marker on 5xx so request can be retried
          await redis.del(redisKey).catch(() => {})
        }
      })

      next()
    } catch (err) {
      // If Redis is down, proceed without idempotency (fail open)
      logger.warn({
        msg: 'Idempotency check failed, proceeding without',
        operation: operationName,
        error: err instanceof Error ? err.message : String(err),
      })
      next()
    }
  }
}

/**
 * Generates an idempotency key from request properties.
 * Uses a hash of the body combined with optional context.
 *
 * @param req - Express request object
 * @param contextExtractor - Optional function to extract additional context
 * @returns Generated idempotency key
 */
function generateKeyFromRequest(
  req: Request,
  contextExtractor?: (req: Request) => string
): string {
  const bodyString = JSON.stringify(req.body || {})
  const context = contextExtractor ? contextExtractor(req) : ''
  const combined = `${context}:${bodyString}`

  // Simple hash function for key generation
  return hashString(combined)
}

/**
 * Simple hash function for generating keys.
 * Uses djb2 algorithm for fast, decent distribution.
 *
 * @param str - String to hash
 * @returns Hexadecimal hash string
 */
function hashString(str: string): string {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) + hash) ^ char
  }
  return (hash >>> 0).toString(16)
}

/**
 * Creates an idempotency key for drawing submissions.
 * Combines session ID, shape, and timestamp for uniqueness.
 *
 * @param sessionId - User's session ID
 * @param shape - Shape being drawn
 * @param timestamp - Submission timestamp (optional, defaults to now)
 * @returns Idempotency key string
 *
 * @example
 * ```typescript
 * // In the frontend, generate and send the key:
 * const idempotencyKey = generateDrawingIdempotencyKey(sessionId, shape)
 *
 * fetch('/api/drawings', {
 *   method: 'POST',
 *   headers: {
 *     'Content-Type': 'application/json',
 *     'X-Idempotency-Key': idempotencyKey,
 *   },
 *   body: JSON.stringify(drawingData),
 * })
 * ```
 */
export function generateDrawingIdempotencyKey(
  sessionId: string,
  shape: string,
  timestamp?: number
): string {
  // Round timestamp to 10-second windows to handle slight timing differences
  const ts = Math.floor((timestamp || Date.now()) / 10000)
  return `${sessionId}:${shape}:${ts}`
}

/**
 * Checks if a request has already been processed.
 * Useful for checking idempotency status outside the middleware.
 *
 * @param operationName - Name of the operation
 * @param idempotencyKey - The idempotency key to check
 * @param options - Configuration options
 * @returns True if the request was already processed
 */
export async function isAlreadyProcessed(
  operationName: string,
  idempotencyKey: string,
  options: Partial<IdempotencyOptions> = {}
): Promise<boolean> {
  const config = { ...DEFAULT_OPTIONS, ...options }
  const redisKey = `${config.keyPrefix}${operationName}:${idempotencyKey}`

  try {
    const existing = await redis.get(redisKey)
    if (existing) {
      const stored = JSON.parse(existing)
      return !stored.processing // Only return true if fully processed
    }
    return false
  } catch {
    return false
  }
}

/**
 * Clears an idempotency key (useful for testing or admin overrides).
 *
 * @param operationName - Name of the operation
 * @param idempotencyKey - The idempotency key to clear
 * @param options - Configuration options
 */
export async function clearIdempotencyKey(
  operationName: string,
  idempotencyKey: string,
  options: Partial<IdempotencyOptions> = {}
): Promise<void> {
  const config = { ...DEFAULT_OPTIONS, ...options }
  const redisKey = `${config.keyPrefix}${operationName}:${idempotencyKey}`
  await redis.del(redisKey)
}
