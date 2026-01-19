import Redis from 'ioredis';
import { Request, Response } from 'express';
import { query } from '../db.js';
import redis from '../redis.js';
import { createLogger } from './logger.js';

const logger = createLogger('health');

interface LivenessResult {
  status: string;
  timestamp: string;
}

interface ComponentCheck {
  status: string;
  latencyMs: number;
  serverTime?: Date;
  uptimeSeconds?: number | null;
  error?: string;
}

interface ReadinessResult {
  status: string;
  timestamp: string;
  checks: {
    database: ComponentCheck;
    redis: ComponentCheck;
  };
}

interface MemoryUsage {
  heapUsed: string;
  heapTotal: string;
  rss: string;
  external: string;
}

interface DeepHealthResult {
  status: string;
  timestamp: string;
  uptime: {
    ms: number;
    formatted: string;
  };
  version: string;
  environment: string;
  components: {
    database: ComponentCheck;
    redis: ComponentCheck;
  };
  process: {
    pid: number;
    memoryUsage: MemoryUsage;
    nodeVersion: string;
  };
}

/**
 * Health check service for monitoring system components
 *
 * Provides:
 * - Liveness check: Is the process running?
 * - Readiness check: Is the service ready to accept traffic?
 * - Deep health check: Status of all dependencies
 */
export class HealthCheckService {
  private redis: Redis;
  private startTime: number;

  constructor(redisClient: Redis) {
    this.redis = redisClient;
    this.startTime = Date.now();
  }

  /**
   * Simple liveness check - is the process alive?
   */
  async liveness(): Promise<LivenessResult> {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness check - can the service handle requests?
   */
  async readiness(): Promise<ReadinessResult> {
    const checks = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
    ]);

    const allHealthy = checks.every(c => c.status === 'ok');

    return {
      status: allHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: {
        database: checks[0],
        redis: checks[1],
      },
    };
  }

  /**
   * Deep health check with detailed component status
   */
  async deepHealth(): Promise<DeepHealthResult> {
    const [dbCheck, redisCheck] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
    ]);

    const uptimeMs = Date.now() - this.startTime;
    const allHealthy = dbCheck.status === 'ok' && redisCheck.status === 'ok';

    return {
      status: allHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: {
        ms: uptimeMs,
        formatted: this.formatUptime(uptimeMs),
      },
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      components: {
        database: dbCheck,
        redis: redisCheck,
      },
      process: {
        pid: process.pid,
        memoryUsage: this.formatMemory(process.memoryUsage()),
        nodeVersion: process.version,
      },
    };
  }

  /**
   * Check PostgreSQL database connectivity
   */
  async checkDatabase(): Promise<ComponentCheck> {
    const start = Date.now();

    try {
      const result = await query('SELECT 1 as health_check, NOW() as server_time');
      const latency = Date.now() - start;

      return {
        status: 'ok',
        latencyMs: latency,
        serverTime: result.rows[0].server_time,
      };
    } catch (error) {
      logger.error({ error }, 'Database health check failed');

      return {
        status: 'error',
        error: (error as Error).message,
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Check Redis connectivity
   */
  async checkRedis(): Promise<ComponentCheck> {
    const start = Date.now();

    try {
      const pong = await this.redis.ping();
      const latency = Date.now() - start;

      if (pong !== 'PONG') {
        throw new Error(`Unexpected response: ${pong}`);
      }

      // Get some Redis info
      const info = await this.redis.info('server');
      const uptimeMatch = info.match(/uptime_in_seconds:(\d+)/);
      const redisUptime = uptimeMatch ? parseInt(uptimeMatch[1]) : null;

      return {
        status: 'ok',
        latencyMs: latency,
        uptimeSeconds: redisUptime,
      };
    } catch (error) {
      logger.error({ error }, 'Redis health check failed');

      return {
        status: 'error',
        error: (error as Error).message,
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Format uptime into human-readable string
   */
  formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  /**
   * Format memory usage
   */
  formatMemory(usage: NodeJS.MemoryUsage): MemoryUsage {
    const formatBytes = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)}MB`;

    return {
      heapUsed: formatBytes(usage.heapUsed),
      heapTotal: formatBytes(usage.heapTotal),
      rss: formatBytes(usage.rss),
      external: formatBytes(usage.external),
    };
  }
}

// Create singleton instance
const healthCheck = new HealthCheckService(redis);

// Express route handlers
export function livenessHandler(req: Request, res: Response): void {
  healthCheck.liveness().then(result => {
    res.json(result);
  });
}

export async function readinessHandler(req: Request, res: Response): Promise<void> {
  const result = await healthCheck.readiness();
  const status = result.status === 'ok' ? 200 : 503;
  res.status(status).json(result);
}

export async function healthHandler(req: Request, res: Response): Promise<void> {
  const result = await healthCheck.deepHealth();
  const status = result.status === 'healthy' ? 200 : 503;
  res.status(status).json(result);
}

export default healthCheck;
