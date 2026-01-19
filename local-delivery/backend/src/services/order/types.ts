/**
 * Order module types and constants.
 * Re-exports relevant types from main types module and defines module-specific constants.
 *
 * @module services/order/types
 * @description Centralizes type definitions and configuration constants for the order service.
 * All order-related types are re-exported from the main types module for convenience.
 */

// Re-export types from main types module
export type {
  Order,
  OrderWithDetails,
  OrderItem,
  CreateOrderInput,
  OrderStatus,
  DriverOffer,
  Location,
  Merchant,
} from '../../types/index.js';

// Module constants

/**
 * Time in seconds before a driver offer expires and is offered to the next driver.
 * @description After this timeout, the offer is marked as expired and the system
 * attempts to match the order with the next best available driver.
 * @constant {number}
 */
export const OFFER_EXPIRY_SECONDS = 30;

/**
 * Maximum number of drivers to try before cancelling an order for lack of driver.
 * @description If all attempts are exhausted without a driver accepting, the order
 * is automatically cancelled with reason "No driver available".
 * @constant {number}
 */
export const MAX_OFFER_ATTEMPTS = 5;

/**
 * Circuit breaker timeout for driver matching in milliseconds.
 * @description Set to 3 minutes to allow for multiple sequential driver offers
 * (up to MAX_OFFER_ATTEMPTS * OFFER_EXPIRY_SECONDS).
 * @constant {number}
 */
export const DRIVER_MATCHING_TIMEOUT_MS = 180000;

/**
 * Error threshold percentage for circuit breaker to open.
 * @description When the error rate exceeds this percentage, the circuit breaker
 * opens and starts using the fallback behavior.
 * @constant {number}
 */
export const CIRCUIT_BREAKER_ERROR_THRESHOLD = 50;

/**
 * Minimum requests before circuit breaker evaluates error threshold.
 * @description The circuit breaker will not open until at least this many
 * requests have been processed, preventing premature opens on low traffic.
 * @constant {number}
 */
export const CIRCUIT_BREAKER_VOLUME_THRESHOLD = 3;

/**
 * Time in milliseconds before circuit breaker transitions from open to half-open.
 * @description After this period, the circuit breaker allows a test request through
 * to check if the service has recovered.
 * @constant {number}
 */
export const CIRCUIT_BREAKER_RESET_TIMEOUT_MS = 30000;
