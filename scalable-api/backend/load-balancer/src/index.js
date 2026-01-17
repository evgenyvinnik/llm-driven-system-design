import express from 'express';
import cors from 'cors';
import config from '../../shared/config/index.js';
import { requestIdMiddleware, requestLoggerMiddleware, corsOptions } from '../../shared/middleware/common.js';
import { metricsService } from '../../shared/services/metrics.js';
import { CircuitBreaker } from '../../shared/services/circuit-breaker.js';

const app = express();

// Server pool management
class ServerPool {
  constructor(servers) {
    this.servers = servers.map(url => ({
      url,
      healthy: true,
      weight: 5,
      currentConnections: 0,
      totalRequests: 0,
      failedRequests: 0,
      lastCheck: null,
      lastError: null,
      circuitBreaker: new CircuitBreaker(`lb-${url}`, {
        failureThreshold: 3,
        resetTimeout: 15000,
      }),
    }));
    this.currentIndex = 0;
    this.healthCheckInterval = null;
  }

  /**
   * Get next healthy server using least connections algorithm
   */
  getNextServer() {
    const healthyServers = this.servers.filter(s => s.healthy && s.circuitBreaker.state !== 'open');

    if (healthyServers.length === 0) {
      // Fallback: try any server if all are unhealthy
      console.warn('All servers unhealthy, trying first server');
      return this.servers[0];
    }

    // Least connections with weight consideration
    healthyServers.sort((a, b) => {
      const aScore = a.currentConnections / a.weight;
      const bScore = b.currentConnections / b.weight;
      return aScore - bScore;
    });

    return healthyServers[0];
  }

  /**
   * Round-robin selection (alternative algorithm)
   */
  getNextServerRoundRobin() {
    const healthyServers = this.servers.filter(s => s.healthy);
    if (healthyServers.length === 0) {
      return this.servers[0];
    }

    this.currentIndex = (this.currentIndex + 1) % healthyServers.length;
    return healthyServers[this.currentIndex];
  }

  /**
   * Mark request as started
   */
  requestStarted(server) {
    server.currentConnections++;
    server.totalRequests++;
  }

  /**
   * Mark request as completed
   */
  requestCompleted(server, success) {
    server.currentConnections = Math.max(0, server.currentConnections - 1);
    if (!success) {
      server.failedRequests++;
    }
  }

  /**
   * Check health of a single server
   */
  async checkServerHealth(server) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    try {
      const response = await fetch(`${server.url}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        server.healthy = true;
        server.lastCheck = new Date().toISOString();
        server.lastError = null;

        // Adjust weight based on response time or load
        if (data.load !== undefined) {
          server.weight = Math.max(1, 10 - Math.floor(data.load / 10));
        }

        return true;
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      clearTimeout(timeout);
      server.healthy = false;
      server.lastCheck = new Date().toISOString();
      server.lastError = error.message;
      console.warn(`Health check failed for ${server.url}:`, error.message);
      return false;
    }
  }

  /**
   * Start periodic health checks
   */
  startHealthChecks(intervalMs = 5000) {
    // Initial check
    this.checkAllServers();

    this.healthCheckInterval = setInterval(() => {
      this.checkAllServers();
    }, intervalMs);
  }

  /**
   * Check all servers
   */
  async checkAllServers() {
    await Promise.all(this.servers.map(s => this.checkServerHealth(s)));
  }

  /**
   * Stop health checks
   */
  stopHealthChecks() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Get pool status
   */
  getStatus() {
    return {
      totalServers: this.servers.length,
      healthyServers: this.servers.filter(s => s.healthy).length,
      servers: this.servers.map(s => ({
        url: s.url,
        healthy: s.healthy,
        weight: s.weight,
        currentConnections: s.currentConnections,
        totalRequests: s.totalRequests,
        failedRequests: s.failedRequests,
        successRate: s.totalRequests > 0
          ? ((s.totalRequests - s.failedRequests) / s.totalRequests * 100).toFixed(2) + '%'
          : 'N/A',
        lastCheck: s.lastCheck,
        lastError: s.lastError,
        circuitState: s.circuitBreaker.state,
      })),
    };
  }
}

// Initialize server pool
const serverPool = new ServerPool(config.loadBalancer.servers);

// Basic middleware
app.set('trust proxy', true);
app.use(cors(corsOptions()));
app.use(express.json({ limit: '10mb' }));
app.use(express.raw({ type: '*/*', limit: '10mb' }));
app.use(requestIdMiddleware);
app.use(requestLoggerMiddleware);

// Load balancer health check
app.get('/health', (req, res) => {
  const status = serverPool.getStatus();
  const healthy = status.healthyServers > 0;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    service: 'load-balancer',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    backends: status,
  });
});

// Load balancer status
app.get('/lb/status', (req, res) => {
  res.json(serverPool.getStatus());
});

// Metrics endpoint
app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(metricsService.getMetricsPrometheus());
});

// Proxy all other requests to backend servers
app.use('*', async (req, res) => {
  const server = serverPool.getNextServer();

  if (!server) {
    return res.status(503).json({
      error: 'No healthy backend servers available',
      requestId: req.id,
    });
  }

  const targetUrl = `${server.url}${req.originalUrl}`;
  serverPool.requestStarted(server);

  const startTime = Date.now();

  try {
    const result = await server.circuitBreaker.execute(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      // Prepare headers
      const headers = { ...req.headers };
      delete headers.host;
      headers['x-request-id'] = req.id;
      headers['x-forwarded-for'] = req.ip;
      headers['x-forwarded-host'] = req.hostname;
      headers['x-forwarded-proto'] = req.protocol;

      // Prepare body
      let body = undefined;
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        if (typeof req.body === 'object' && !(req.body instanceof Buffer)) {
          body = JSON.stringify(req.body);
          headers['content-type'] = 'application/json';
        } else {
          body = req.body;
        }
      }

      const response = await fetch(targetUrl, {
        method: req.method,
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      return response;
    });

    const duration = Date.now() - startTime;

    // Copy response headers
    for (const [key, value] of result.headers.entries()) {
      if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }

    // Add load balancer headers
    res.setHeader('X-Served-By', server.url);
    res.setHeader('X-Response-Time', `${duration}ms`);

    // Stream response body
    const responseBody = await result.text();
    res.status(result.status).send(responseBody);

    serverPool.requestCompleted(server, true);

    // Record metrics
    metricsService.recordRequest({
      method: req.method,
      path: req.path,
      status: result.status,
      duration,
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    serverPool.requestCompleted(server, false);

    console.error(`Proxy error to ${server.url}:`, error.message);

    metricsService.recordError({
      method: req.method,
      path: req.path,
      error: error.name || 'ProxyError',
    });

    if (error.message.includes('Circuit breaker')) {
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        message: 'Backend server is experiencing issues',
        requestId: req.id,
      });
    }

    res.status(502).json({
      error: 'Bad gateway',
      message: 'Failed to connect to backend server',
      requestId: req.id,
    });
  }
});

// Start server and health checks
const PORT = config.loadBalancer.port;
app.listen(PORT, () => {
  console.log(`Load Balancer running on port ${PORT}`);
  console.log(`Backend servers: ${config.loadBalancer.servers.join(', ')}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Status: http://localhost:${PORT}/lb/status`);

  // Start health checks
  serverPool.startHealthChecks(5000);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  serverPool.stopHealthChecks();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  serverPool.stopHealthChecks();
  process.exit(0);
});
