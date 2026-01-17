import CircuitBreaker from 'opossum';
import logger from './logger.js';
import { circuitBreakerState, circuitBreakerTrips, gitOperationDuration, gitOperationsTotal } from './metrics.js';

/**
 * Circuit Breaker for Git Operations
 *
 * Protects the system when git operations are failing:
 * - Opens circuit after consecutive failures
 * - Rejects requests immediately when open
 * - Periodically tests if service recovered
 *
 * Benefits:
 * - Prevents cascade failures
 * - Allows git storage to recover
 * - Provides fast failure for users
 */

// Circuit breaker configuration
const CIRCUIT_OPTIONS = {
  timeout: 30000,           // 30 seconds - git operations can be slow
  errorThresholdPercentage: 50,  // Open circuit if 50% of requests fail
  resetTimeout: 30000,      // Try again after 30 seconds
  volumeThreshold: 5,       // Minimum requests before calculating error percentage
};

// Map of circuit breakers by operation type
const circuitBreakers = new Map();

/**
 * Create a circuit breaker for a specific operation
 */
function createCircuitBreaker(name, operation) {
  const breaker = new CircuitBreaker(operation, {
    ...CIRCUIT_OPTIONS,
    name,
  });

  // Update metrics on state changes
  breaker.on('open', () => {
    logger.warn({ service: name }, 'Circuit breaker opened');
    circuitBreakerState.set({ service: name }, 1);
    circuitBreakerTrips.inc({ service: name });
  });

  breaker.on('halfOpen', () => {
    logger.info({ service: name }, 'Circuit breaker half-open');
    circuitBreakerState.set({ service: name }, 2);
  });

  breaker.on('close', () => {
    logger.info({ service: name }, 'Circuit breaker closed');
    circuitBreakerState.set({ service: name }, 0);
  });

  breaker.on('success', (result, latency) => {
    const duration = latency / 1000;
    gitOperationDuration.observe({ operation: name }, duration);
    gitOperationsTotal.inc({ operation: name, status: 'success' });
  });

  breaker.on('failure', (err, latency) => {
    const duration = latency / 1000;
    gitOperationDuration.observe({ operation: name }, duration);
    gitOperationsTotal.inc({ operation: name, status: 'failure' });
    logger.error({ err, service: name, latency }, 'Git operation failed');
  });

  breaker.on('timeout', () => {
    gitOperationsTotal.inc({ operation: name, status: 'timeout' });
    logger.warn({ service: name }, 'Git operation timed out');
  });

  breaker.on('reject', () => {
    gitOperationsTotal.inc({ operation: name, status: 'rejected' });
    logger.warn({ service: name }, 'Git operation rejected - circuit open');
  });

  // Initialize state metric
  circuitBreakerState.set({ service: name }, 0);

  circuitBreakers.set(name, breaker);
  return breaker;
}

/**
 * Get or create a circuit breaker for an operation
 */
function getCircuitBreaker(name, operation) {
  if (!circuitBreakers.has(name)) {
    return createCircuitBreaker(name, operation);
  }

  const breaker = circuitBreakers.get(name);
  // Update the action if provided
  if (operation) {
    breaker.action = operation;
  }
  return breaker;
}

/**
 * Wrap a git operation with circuit breaker protection
 *
 * @param {string} operationName - Name of the operation for metrics
 * @param {Function} operation - Async function to execute
 * @returns {Promise} - Result of the operation
 */
export async function withCircuitBreaker(operationName, operation) {
  const breaker = getCircuitBreaker(operationName, operation);

  try {
    return await breaker.fire();
  } catch (err) {
    if (err.message === 'Breaker is open') {
      throw new Error(`Git service temporarily unavailable: ${operationName}`);
    }
    throw err;
  }
}

/**
 * Protected git operations
 */
export const protectedGitOps = {
  /**
   * Clone repository with circuit breaker
   */
  async clone(cloneOperation) {
    return withCircuitBreaker('git_clone', cloneOperation);
  },

  /**
   * Get branches with circuit breaker
   */
  async branches(branchesOperation) {
    return withCircuitBreaker('git_branches', branchesOperation);
  },

  /**
   * Get commits with circuit breaker
   */
  async commits(commitsOperation) {
    return withCircuitBreaker('git_commits', commitsOperation);
  },

  /**
   * Get tree with circuit breaker
   */
  async tree(treeOperation) {
    return withCircuitBreaker('git_tree', treeOperation);
  },

  /**
   * Get diff with circuit breaker
   */
  async diff(diffOperation) {
    return withCircuitBreaker('git_diff', diffOperation);
  },

  /**
   * Merge branches with circuit breaker
   */
  async merge(mergeOperation) {
    return withCircuitBreaker('git_merge', mergeOperation);
  },

  /**
   * Push to repository with circuit breaker
   */
  async push(pushOperation) {
    return withCircuitBreaker('git_push', pushOperation);
  },
};

/**
 * Get the status of all circuit breakers
 */
export function getCircuitBreakerStatus() {
  const status = {};
  for (const [name, breaker] of circuitBreakers) {
    status[name] = {
      state: breaker.opened ? 'open' : (breaker.halfOpen ? 'half-open' : 'closed'),
      stats: breaker.stats,
    };
  }
  return status;
}

/**
 * Force reset a specific circuit breaker (for admin use)
 */
export function resetCircuitBreaker(name) {
  const breaker = circuitBreakers.get(name);
  if (breaker) {
    breaker.close();
    logger.info({ service: name }, 'Circuit breaker manually reset');
    return true;
  }
  return false;
}

export default {
  withCircuitBreaker,
  protectedGitOps,
  getCircuitBreakerStatus,
  resetCircuitBreaker,
};
