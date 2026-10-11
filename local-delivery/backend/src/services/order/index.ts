/**
 * Order service module.
 * Re-exports all order-related functionality from submodules.
 *
 * @module services/order
 * @description Central entry point for order service functionality. Aggregates and
 * re-exports all order-related types, constants, and functions from submodules:
 * - types: Type definitions and configuration constants
 * - pricing: Request validation and server-side pricing (integer cents)
 * - create: Order creation (transactional), quotes, tips
 * - tracking: Order queries and statistics
 * - stateMachine: Guarded (compare-and-set) status transitions
 * - cancel: Cancellation that also withdraws live offers
 * - delivery: Delivery completion handling
 * - assignment: Driver offers and the atomic claim
 * - dispatch: Dispatch leases and the sweeper that resumes orphaned matching
 * - matching: Driver matching with circuit breaker
 *
 * @example
 * import {
 *   createOrder,
 *   getOrderWithDetails,
 *   transitionOrder,
 *   startDriverMatchingWithCircuitBreaker
 * } from '../services/order/index.js';
 */

// Types and constants
export type {
  Order,
  OrderWithDetails,
  OrderItem,
  CreateOrderInput,
  OrderStatus,
  DriverOffer,
  Location,
  Merchant,
} from './types.js';

export {
  OFFER_EXPIRY_SECONDS,
  MAX_OFFER_ATTEMPTS,
  DRIVER_MATCHING_TIMEOUT_MS,
  CIRCUIT_BREAKER_ERROR_THRESHOLD,
  CIRCUIT_BREAKER_VOLUME_THRESHOLD,
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
} from './types.js';

// Order creation, pricing and tips
export { createOrder, quoteOrder, updateOrderTip } from './create.js';
export {
  createOrderSchema,
  quoteOrderSchema,
  parseOrderBody,
  priceOrder,
  OrderValidationError,
} from './pricing.js';
export type { CreateOrderRequest, QuoteOrderRequest, OrderQuote } from './pricing.js';

// Order tracking and queries
export {
  getOrderById,
  getOrderWithDetails,
  getCustomerOrders,
  getDriverOrders,
  getOrderStats,
  getRecentOrders,
} from './tracking.js';

// State machine (guarded status transitions)
export {
  ORDER_TRANSITIONS,
  DISPATCHABLE_STATUSES,
  ACTIVE_DELIVERY_STATUSES,
  canTransition,
  transitionOrder,
  publishOrderStatus,
  OrderTransitionError,
  OrderNotFoundError,
  OrderAccessError,
} from './stateMachine.js';

// Cancellation
export { cancelOrder, CUSTOMER_CANCELLABLE_STATUSES } from './cancel.js';

// Delivery completion
export { completeDelivery } from './delivery.js';

// Driver offers and the atomic claim
export {
  createDriverOffer,
  acceptDriverOffer,
  rejectDriverOffer,
  getPendingOfferForDriver,
  expireOldOffers,
} from './assignment.js';
export type { AcceptResult, CreateOfferResult } from './assignment.js';

// Dispatch leases and the sweeper
export {
  DISPATCH_OWNER,
  startDispatchSweeper,
  releaseAllDispatchLeases,
} from './dispatch.js';

// Driver matching with circuit breaker
export {
  startDriverMatching,
  startDriverMatchingWithCircuitBreaker,
  getDriverMatchingCircuitBreakerStatus,
} from './matching.js';
export type { MatchOutcome } from './matching.js';
