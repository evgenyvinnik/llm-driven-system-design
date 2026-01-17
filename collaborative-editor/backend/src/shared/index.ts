/**
 * @fileoverview Barrel export for shared modules.
 *
 * Import from this module to access all shared functionality:
 * ```typescript
 * import { logger, register, createCircuitBreaker, publishOperation } from './shared/index.js';
 * ```
 */

export * from './logger.js';
export * from './metrics.js';
export * from './circuitBreaker.js';
export * from './queue.js';
export * from './idempotency.js';
