/**
 * Circuit breaker pattern for storage operations
 *
 * WHY: Circuit breakers prevent cascading failures when external dependencies
 * (like MinIO storage) become unhealthy. Instead of continuing to send requests
 * to a failing service (which wastes resources and increases latency), the circuit
 * breaker fails fast and allows the system to recover gracefully.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service is failing, requests fail immediately
 * - HALF-OPEN: Testing if service has recovered
 */

import CircuitBreaker from 'opossum';
import type { Client as MinioClient } from 'minio';
import type { Pool } from 'pg';
import { circuitBreakerState, circuitBreakerFailures } from './metrics.js';
import logger from './logger.js';

// Default circuit breaker options
const DEFAULT_OPTIONS = {
  timeout: 10000,           // 10 seconds timeout for each request
  errorThresholdPercentage: 50, // Open circuit when 50% of requests fail
  resetTimeout: 30000,      // Try again after 30 seconds
  volumeThreshold: 5,       // Minimum requests before tripping
};

// Map state names to numeric values for metrics
const STATE_VALUES: Record<string, number> = {
  closed: 0,
  open: 1,
  halfOpen: 2,
};

export interface BreakerOptions {
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  volumeThreshold?: number;
}

export interface PutObjectParams {
  bucket: string;
  key: string;
  data: Buffer;
  size: number;
  metadata: Record<string, string>;
}

export interface GetObjectParams {
  bucket: string;
  key: string;
}

export interface DeleteObjectParams {
  bucket: string;
  key: string;
}

export interface StatObjectParams {
  bucket: string;
  key: string;
}

export interface BreakerStats {
  fires: number;
  failures: number;
  successes: number;
  timeouts: number;
  fallbacks: number;
  rejects: number;
}

export interface BreakerHealth {
  state: string;
  stats: BreakerStats;
}

export interface StorageHealth {
  [key: string]: BreakerHealth;
}

type BreakerFunction<T, R> = (params: T) => Promise<R>;

/**
 * Create a circuit breaker for a given function
 */
export function createCircuitBreaker<T, R>(
  fn: BreakerFunction<T, R>,
  name: string,
  options: BreakerOptions = {}
): CircuitBreaker<[T], R> {
  const breaker = new CircuitBreaker(fn, {
    ...DEFAULT_OPTIONS,
    ...options,
    name,
  });

  // Set up event listeners for metrics and logging
  breaker.on('success', () => {
    circuitBreakerState.set({ breaker_name: name }, STATE_VALUES.closed);
  });

  breaker.on('timeout', () => {
    logger.warn({ breaker: name }, 'Circuit breaker timeout');
    circuitBreakerFailures.inc({ breaker_name: name });
  });

  breaker.on('reject', () => {
    logger.warn({ breaker: name }, 'Circuit breaker rejected request');
  });

  breaker.on('open', () => {
    logger.error({ breaker: name }, 'Circuit breaker opened - service unavailable');
    circuitBreakerState.set({ breaker_name: name }, STATE_VALUES.open);
  });

  breaker.on('halfOpen', () => {
    logger.info({ breaker: name }, 'Circuit breaker half-open - testing service');
    circuitBreakerState.set({ breaker_name: name }, STATE_VALUES.halfOpen);
  });

  breaker.on('close', () => {
    logger.info({ breaker: name }, 'Circuit breaker closed - service recovered');
    circuitBreakerState.set({ breaker_name: name }, STATE_VALUES.closed);
  });

  breaker.on('fallback', (result: unknown) => {
    logger.info({ breaker: name, result }, 'Circuit breaker fallback executed');
  });

  breaker.on('failure', (error: Error) => {
    logger.error({ breaker: name, error: error.message }, 'Circuit breaker recorded failure');
    circuitBreakerFailures.inc({ breaker_name: name });
  });

  // Initialize metric to closed state
  circuitBreakerState.set({ breaker_name: name }, STATE_VALUES.closed);

  return breaker;
}

/**
 * Storage circuit breakers for MinIO operations
 */
export class StorageCircuitBreakers {
  private minioClient: MinioClient;
  private breakers: {
    put: CircuitBreaker<[PutObjectParams], unknown>;
    get: CircuitBreaker<[GetObjectParams], NodeJS.ReadableStream>;
    delete: CircuitBreaker<[DeleteObjectParams], void>;
    stat: CircuitBreaker<[StatObjectParams], unknown>;
  };

  constructor(minioClient: MinioClient) {
    this.minioClient = minioClient;
    this.breakers = this._initializeBreakers();
  }

  private _initializeBreakers() {
    // Circuit breaker for put operations (uploads)
    const putBreaker = createCircuitBreaker<PutObjectParams, unknown>(
      async ({ bucket, key, data, size, metadata }) => {
        return await this.minioClient.putObject(bucket, key, data, size, metadata);
      },
      'storage_put',
      { timeout: 30000 } // Longer timeout for uploads
    );

    // Circuit breaker for get operations (downloads)
    const getBreaker = createCircuitBreaker<GetObjectParams, NodeJS.ReadableStream>(
      async ({ bucket, key }) => {
        return await this.minioClient.getObject(bucket, key);
      },
      'storage_get',
      { timeout: 15000 }
    );

    // Circuit breaker for delete operations
    const deleteBreaker = createCircuitBreaker<DeleteObjectParams, void>(
      async ({ bucket, key }) => {
        await this.minioClient.removeObject(bucket, key);
      },
      'storage_delete',
      { timeout: 10000 }
    );

    // Circuit breaker for stat operations (checking if object exists)
    const statBreaker = createCircuitBreaker<StatObjectParams, unknown>(
      async ({ bucket, key }) => {
        return await this.minioClient.statObject(bucket, key);
      },
      'storage_stat',
      { timeout: 5000 }
    );

    // Add fallbacks for graceful degradation
    getBreaker.fallback((err: Error) => {
      logger.error({ error: err.message }, 'Storage get fallback triggered');
      throw new Error('Storage service temporarily unavailable');
    });

    putBreaker.fallback((err: Error) => {
      logger.error({ error: err.message }, 'Storage put fallback triggered');
      throw new Error('Storage service temporarily unavailable. Please retry later.');
    });

    return {
      put: putBreaker,
      get: getBreaker,
      delete: deleteBreaker,
      stat: statBreaker,
    };
  }

  /**
   * Upload an object with circuit breaker protection
   */
  async putObject(bucket: string, key: string, data: Buffer, size: number, metadata: Record<string, string> = {}): Promise<unknown> {
    return this.breakers.put.fire({ bucket, key, data, size, metadata });
  }

  /**
   * Download an object with circuit breaker protection
   */
  async getObject(bucket: string, key: string): Promise<NodeJS.ReadableStream> {
    return this.breakers.get.fire({ bucket, key });
  }

  /**
   * Delete an object with circuit breaker protection
   */
  async removeObject(bucket: string, key: string): Promise<void> {
    return this.breakers.delete.fire({ bucket, key });
  }

  /**
   * Check if object exists with circuit breaker protection
   */
  async statObject(bucket: string, key: string): Promise<unknown> {
    return this.breakers.stat.fire({ bucket, key });
  }

  /**
   * Get current health status of all breakers
   */
  getHealth(): StorageHealth {
    const health: StorageHealth = {};
    for (const [name, breaker] of Object.entries(this.breakers)) {
      health[name] = {
        state: breaker.status.name,
        stats: {
          fires: breaker.stats.fires,
          failures: breaker.stats.failures,
          successes: breaker.stats.successes,
          timeouts: breaker.stats.timeouts,
          fallbacks: breaker.stats.fallbacks,
          rejects: breaker.stats.rejects,
        },
      };
    }
    return health;
  }

  /**
   * Check if storage is healthy (all breakers closed)
   */
  isHealthy(): boolean {
    return Object.values(this.breakers).every(
      (breaker) => !breaker.opened
    );
  }
}

/**
 * Database circuit breaker for PostgreSQL operations
 */
export function createDatabaseCircuitBreaker(pool: Pool): CircuitBreaker<[(pool: Pool) => Promise<unknown>], unknown> {
  const breaker = createCircuitBreaker<(pool: Pool) => Promise<unknown>, unknown>(
    async (queryFn) => {
      return await queryFn(pool);
    },
    'database',
    {
      timeout: 5000,
      errorThresholdPercentage: 30,
      resetTimeout: 60000,
    }
  );

  return breaker;
}

export default {
  createCircuitBreaker,
  StorageCircuitBreakers,
  createDatabaseCircuitBreaker,
};
