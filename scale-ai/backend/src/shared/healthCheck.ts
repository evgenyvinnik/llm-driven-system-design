/**
 * Health check module for service orchestration.
 * Provides liveness and readiness endpoints with dependency checks.
 *
 * WHY: Container orchestrators (Kubernetes, Docker Swarm) use health checks to
 * determine if a service should receive traffic (readiness) or needs to be
 * restarted (liveness). Without proper health checks, unhealthy instances
 * continue receiving traffic, causing user-facing errors. Health checks also
 * enable graceful rolling deployments.
 *
 * @module shared/healthCheck
 */

import { Request, Response, Router } from 'express'
import { pool } from './db.js'
import { redis } from './cache.js'
import { minioClient, DRAWINGS_BUCKET } from './storage.js'
import { getAllCircuitBreakerStatus, CircuitBreaker } from './circuitBreaker.js'
import { logger } from './logger.js'

/**
 * Result of a single dependency health check.
 */
export interface DependencyStatus {
  name: string
  status: 'healthy' | 'degraded' | 'unhealthy'
  latencyMs: number
  message?: string
  lastChecked: string
}

/**
 * Complete health check response.
 */
export interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy'
  service: string
  version: string
  uptime: number
  timestamp: string
  dependencies: DependencyStatus[]
  circuitBreakers?: ReturnType<CircuitBreaker['getStatus']>[]
}

/**
 * Service start time for uptime calculation.
 */
const startTime = Date.now()

/**
 * Service version from package.json or environment.
 */
const VERSION = process.env.SERVICE_VERSION || '0.1.0'

/**
 * Service name from environment.
 */
const SERVICE_NAME = process.env.SERVICE_NAME || 'scale-ai'

/**
 * Configuration for health check timeouts.
 */
const CHECK_TIMEOUT_MS = 5000

/**
 * Checks PostgreSQL database connectivity.
 * Executes a simple query to verify the connection pool is working.
 *
 * @returns Dependency status object
 */
async function checkPostgres(): Promise<DependencyStatus> {
  const start = Date.now()

  try {
    const _result = await Promise.race([
      pool.query('SELECT 1 as health_check'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), CHECK_TIMEOUT_MS)
      ),
    ])

    return {
      name: 'postgres',
      status: 'healthy',
      latencyMs: Date.now() - start,
      message: 'Connection pool active',
      lastChecked: new Date().toISOString(),
    }
  } catch (error) {
    return {
      name: 'postgres',
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      message: error instanceof Error ? error.message : 'Unknown error',
      lastChecked: new Date().toISOString(),
    }
  }
}

/**
 * Checks Redis/Valkey connectivity.
 * Executes a PING command to verify the connection.
 *
 * @returns Dependency status object
 */
async function checkRedis(): Promise<DependencyStatus> {
  const start = Date.now()

  try {
    const result = await Promise.race([
      redis.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), CHECK_TIMEOUT_MS)
      ),
    ])

    return {
      name: 'redis',
      status: result === 'PONG' ? 'healthy' : 'degraded',
      latencyMs: Date.now() - start,
      message: result === 'PONG' ? 'Connected' : `Unexpected response: ${result}`,
      lastChecked: new Date().toISOString(),
    }
  } catch (error) {
    return {
      name: 'redis',
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      message: error instanceof Error ? error.message : 'Unknown error',
      lastChecked: new Date().toISOString(),
    }
  }
}

/**
 * Checks MinIO object storage connectivity.
 * Verifies the drawings bucket exists.
 *
 * @returns Dependency status object
 */
async function checkMinio(): Promise<DependencyStatus> {
  const start = Date.now()

  try {
    const exists = await Promise.race([
      minioClient.bucketExists(DRAWINGS_BUCKET),
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), CHECK_TIMEOUT_MS)
      ),
    ])

    return {
      name: 'minio',
      status: exists ? 'healthy' : 'degraded',
      latencyMs: Date.now() - start,
      message: exists ? 'Bucket accessible' : 'Bucket not found',
      lastChecked: new Date().toISOString(),
    }
  } catch (error) {
    return {
      name: 'minio',
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      message: error instanceof Error ? error.message : 'Unknown error',
      lastChecked: new Date().toISOString(),
    }
  }
}

/**
 * Runs all dependency health checks in parallel.
 *
 * @returns Array of dependency status objects
 */
async function checkAllDependencies(): Promise<DependencyStatus[]> {
  const checks = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkMinio(),
  ])

  return checks
}

/**
 * Determines overall status from dependency statuses.
 * - All healthy = healthy
 * - Any degraded = degraded
 * - Any unhealthy = unhealthy
 *
 * @param dependencies - Array of dependency statuses
 * @returns Overall status
 */
function calculateOverallStatus(
  dependencies: DependencyStatus[]
): 'healthy' | 'degraded' | 'unhealthy' {
  if (dependencies.some((d) => d.status === 'unhealthy')) {
    return 'unhealthy'
  }
  if (dependencies.some((d) => d.status === 'degraded')) {
    return 'degraded'
  }
  return 'healthy'
}

/**
 * Creates a health check router with /health, /health/live, and /health/ready endpoints.
 *
 * Endpoints:
 * - GET /health - Full health check with all dependencies and circuit breakers
 * - GET /health/live - Simple liveness check (is the process running?)
 * - GET /health/ready - Readiness check (can the service handle requests?)
 *
 * @returns Express Router with health check endpoints
 *
 * @example
 * ```typescript
 * app.use(healthCheckRouter())
 * ```
 */
export function healthCheckRouter(): Router {
  const router = Router()

  /**
   * Full health check endpoint.
   * Returns detailed status of all dependencies and circuit breakers.
   * Use for monitoring dashboards and debugging.
   */
  router.get('/health', async (_req: Request, res: Response) => {
    try {
      const dependencies = await checkAllDependencies()
      const circuitBreakers = getAllCircuitBreakerStatus()

      const response: HealthCheckResponse = {
        status: calculateOverallStatus(dependencies),
        service: SERVICE_NAME,
        version: VERSION,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        timestamp: new Date().toISOString(),
        dependencies,
        circuitBreakers,
      }

      const statusCode = response.status === 'healthy' ? 200 : response.status === 'degraded' ? 200 : 503

      res.status(statusCode).json(response)
    } catch (error) {
      logger.error({
        msg: 'Health check failed',
        error: error instanceof Error ? error.message : String(error),
      })

      res.status(503).json({
        status: 'unhealthy',
        service: SERVICE_NAME,
        version: VERSION,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        timestamp: new Date().toISOString(),
        dependencies: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  })

  /**
   * Liveness probe endpoint.
   * Returns 200 if the process is running and can respond to requests.
   * Does NOT check dependencies - only process health.
   * Use for container restart decisions.
   */
  router.get('/health/live', (_req: Request, res: Response) => {
    res.json({
      status: 'alive',
      service: SERVICE_NAME,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    })
  })

  /**
   * Readiness probe endpoint.
   * Returns 200 only if the service can handle requests (dependencies healthy).
   * Use for load balancer traffic routing decisions.
   */
  router.get('/health/ready', async (_req: Request, res: Response) => {
    try {
      const dependencies = await checkAllDependencies()
      const overallStatus = calculateOverallStatus(dependencies)

      // Consider healthy or degraded as ready (degraded = partial functionality)
      const isReady = overallStatus !== 'unhealthy'

      res.status(isReady ? 200 : 503).json({
        status: isReady ? 'ready' : 'not_ready',
        service: SERVICE_NAME,
        timestamp: new Date().toISOString(),
        dependencies: dependencies.map((d) => ({ name: d.name, status: d.status })),
      })
    } catch (error) {
      res.status(503).json({
        status: 'not_ready',
        service: SERVICE_NAME,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  })

  return router
}

/**
 * Simple health check for basic endpoints (backwards compatibility).
 * Returns minimal status for existing /health endpoints.
 *
 * @param serviceName - Name of the service
 * @returns Express handler function
 */
export function simpleHealthCheck(serviceName: string): (req: Request, res: Response) => void {
  return (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: serviceName,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    })
  }
}

export {
  checkPostgres,
  checkRedis,
  checkMinio,
  checkAllDependencies,
  calculateOverallStatus,
}
