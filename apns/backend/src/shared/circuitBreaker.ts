/**
 * Circuit Breaker Module.
 *
 * Provides circuit breaker pattern for external service connections.
 * Uses the Opossum library for robust circuit breaker implementation.
 *
 * WHY: Circuit breakers prevent cascading failures when external services
 * (like the actual APNs servers in a real scenario, or in our case the
 * WebSocket connections and Redis pub/sub) become unavailable. Instead of
 * continuing to make failing requests, the circuit "opens" and fails fast,
 * allowing the system to degrade gracefully and recover when the dependency
 * comes back online.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Too many failures, requests fail immediately without attempting
 * - HALF-OPEN: Testing if service recovered, limited requests allowed
 *
 * @module shared/circuitBreaker
 */

import * as CircuitBreakerModule from "opossum";
const CircuitBreaker = CircuitBreakerModule.default || CircuitBreakerModule;
type CircuitBreakerType<TArgs extends unknown[], TResult> = InstanceType<typeof CircuitBreakerModule.default<TArgs, TResult>>;

import { logger } from "./logger.js";
import {
  circuitBreakerState,
  circuitBreakerEvents,
} from "./metrics.js";

/**
 * Circuit breaker configuration options.
 * These can be tuned based on the characteristics of the protected service.
 */
export interface CircuitBreakerOptions {
  /** Time in ms before attempting to close an open circuit (default: 30000) */
  resetTimeout?: number;
  /** Error rate threshold as decimal (0.5 = 50%) to open circuit (default: 0.5) */
  errorThresholdPercentage?: number;
  /** Timeout in ms for individual requests (default: 10000) */
  timeout?: number;
  /** Number of requests to track for error rate calculation (default: 10) */
  volumeThreshold?: number;
  /** Name for logging and metrics */
  name?: string;
}

/** Default circuit breaker options */
const DEFAULT_OPTIONS: Required<CircuitBreakerOptions> = {
  resetTimeout: 30000, // 30 seconds before trying again
  errorThresholdPercentage: 50, // Open circuit at 50% error rate
  timeout: 10000, // 10 second timeout per request
  volumeThreshold: 10, // Need at least 10 requests to calculate error rate
  name: "default",
};

/**
 * Creates a circuit breaker wrapper around an async function.
 * The wrapped function will be protected by the circuit breaker pattern.
 *
 * @param fn - Async function to protect with circuit breaker
 * @param options - Circuit breaker configuration
 * @returns Circuit breaker wrapped function
 *
 * @example
 * ```typescript
 * const protectedSend = createCircuitBreaker(
 *   async (notification) => await sendToAPNs(notification),
 *   { name: "apns_push", timeout: 5000 }
 * );
 *
 * try {
 *   const result = await protectedSend.fire(notification);
 * } catch (error) {
 *   if (error.name === 'OpenCircuitError') {
 *     // Circuit is open, service is down
 *   }
 * }
 * ```
 */
export function createCircuitBreaker<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: CircuitBreakerOptions = {}
): CircuitBreakerType<TArgs, TResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const breaker = new CircuitBreaker(fn, {
    timeout: opts.timeout,
    errorThresholdPercentage: opts.errorThresholdPercentage,
    resetTimeout: opts.resetTimeout,
    volumeThreshold: opts.volumeThreshold,
  });

  const circuitName = opts.name;

  // Initialize state metric
  circuitBreakerState.set({ circuit: circuitName }, 0); // 0 = closed

  // Set up event handlers for monitoring

  breaker.on("open", () => {
    logger.warn({
      event: "circuit_breaker_open",
      circuit: circuitName,
      message: `Circuit breaker opened for ${circuitName}`,
    });
    circuitBreakerState.set({ circuit: circuitName }, 1); // 1 = open
    circuitBreakerEvents.inc({ circuit: circuitName, event: "open" });
  });

  breaker.on("close", () => {
    logger.info({
      event: "circuit_breaker_close",
      circuit: circuitName,
      message: `Circuit breaker closed for ${circuitName}`,
    });
    circuitBreakerState.set({ circuit: circuitName }, 0); // 0 = closed
    circuitBreakerEvents.inc({ circuit: circuitName, event: "close" });
  });

  breaker.on("halfOpen", () => {
    logger.info({
      event: "circuit_breaker_half_open",
      circuit: circuitName,
      message: `Circuit breaker half-open for ${circuitName}`,
    });
    circuitBreakerState.set({ circuit: circuitName }, 2); // 2 = half-open
    circuitBreakerEvents.inc({ circuit: circuitName, event: "half_open" });
  });

  breaker.on("success", () => {
    circuitBreakerEvents.inc({ circuit: circuitName, event: "success" });
  });

  breaker.on("failure", (error) => {
    logger.warn({
      event: "circuit_breaker_failure",
      circuit: circuitName,
      error: error.message,
    });
    circuitBreakerEvents.inc({ circuit: circuitName, event: "failure" });
  });

  breaker.on("timeout", () => {
    logger.warn({
      event: "circuit_breaker_timeout",
      circuit: circuitName,
    });
    circuitBreakerEvents.inc({ circuit: circuitName, event: "timeout" });
  });

  breaker.on("reject", () => {
    // Request rejected because circuit is open
    circuitBreakerEvents.inc({ circuit: circuitName, event: "reject" });
  });

  breaker.on("fallback", () => {
    circuitBreakerEvents.inc({ circuit: circuitName, event: "fallback" });
  });

  return breaker;
}

/**
 * Circuit breaker for Redis pub/sub notification delivery.
 * Protects against Redis connectivity issues during cross-server communication.
 *
 * WHY: When using Redis pub/sub for routing notifications to the correct server,
 * Redis failures should not block the entire notification flow. With a circuit
 * breaker, we can fall back to storing notifications for later delivery instead
 * of failing the entire request.
 */
let pubsubCircuitBreaker: CircuitBreakerType<[string, string], void> | null = null;

/**
 * Gets or creates the pub/sub circuit breaker.
 * Lazy initialization to allow Redis to be configured first.
 *
 * @param publishFn - The Redis publish function to protect
 * @returns Circuit breaker for pub/sub operations
 */
export function getPubSubCircuitBreaker(
  publishFn: (channel: string, message: string) => Promise<void>
): CircuitBreakerType<[string, string], void> {
  if (!pubsubCircuitBreaker) {
    pubsubCircuitBreaker = createCircuitBreaker(publishFn, {
      name: "redis_pubsub",
      timeout: 5000, // 5 second timeout for pub/sub
      resetTimeout: 15000, // Try again after 15 seconds
      errorThresholdPercentage: 50,
      volumeThreshold: 5, // Need 5 failures to trip
    });
  }
  return pubsubCircuitBreaker;
}

/**
 * Circuit breaker for WebSocket send operations.
 * Factory function creates a breaker for each device connection.
 *
 * WHY: Individual device connections can fail (network issues, device going
 * to sleep, etc.). A per-device circuit breaker prevents a single problematic
 * device from blocking notification delivery to others.
 *
 * @param deviceId - Device ID for metrics and logging
 * @param sendFn - The WebSocket send function to protect
 * @returns Circuit breaker for the device's WebSocket
 */
export function createWebSocketCircuitBreaker(
  deviceId: string,
  sendFn: (data: string) => Promise<void>
): CircuitBreakerType<[string], void> {
  return createCircuitBreaker(
    async (data: string) => sendFn(data),
    {
      name: `websocket_${deviceId.substring(0, 8)}`,
      timeout: 3000, // 3 second timeout for WebSocket sends
      resetTimeout: 10000, // Try again after 10 seconds
      errorThresholdPercentage: 60, // Higher threshold for WS
      volumeThreshold: 3, // Trip after 3 failures
    }
  );
}

/**
 * Health status of a circuit breaker.
 */
export interface CircuitBreakerHealth {
  name: string;
  state: "closed" | "open" | "half-open";
  stats: {
    successes: number;
    failures: number;
    timeouts: number;
    rejects: number;
    fallbacks: number;
  };
}

/**
 * Gets the health status of a circuit breaker.
 * Useful for health check endpoints and debugging.
 *
 * @param breaker - Circuit breaker to check
 * @param name - Name for the response
 * @returns Health status object
 */
export function getCircuitBreakerHealth(
  breaker: CircuitBreakerType<unknown[], unknown>,
  name: string
): CircuitBreakerHealth {
  const stats = breaker.stats;
  let state: "closed" | "open" | "half-open" = "closed";

  if (breaker.opened) {
    state = "open";
  } else if (breaker.halfOpen) {
    state = "half-open";
  }

  return {
    name,
    state,
    stats: {
      successes: stats.successes,
      failures: stats.failures,
      timeouts: stats.timeouts,
      rejects: stats.rejects,
      fallbacks: stats.fallbacks,
    },
  };
}

export default createCircuitBreaker;
