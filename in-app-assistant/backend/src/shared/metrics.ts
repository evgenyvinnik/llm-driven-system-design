/**
 * Prometheus metrics. Each process exposes its own registry on /metrics.
 * @module shared/metrics
 */
import type { NextFunction, Request, Response } from 'express'
import client from 'prom-client'

export const registry = new client.Registry()
client.collectDefaultMetrics({ register: registry })

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
})

export const turnsFinished = new client.Counter({
  name: 'assistant_turns_finished_total',
  help: 'Turns reaching a terminal state',
  labelNames: ['app', 'status'],
  registers: [registry],
})

export const turnDuration = new client.Histogram({
  name: 'assistant_turn_active_seconds',
  help: 'Time a turn spent running (excludes waiting on the browser or the user)',
  buckets: [0.5, 1, 2, 5, 10, 20, 40, 80, 120],
  registers: [registry],
})

export const modelCalls = new client.Histogram({
  name: 'assistant_model_call_seconds',
  help: 'One model call, from request to final message',
  labelNames: ['model', 'outcome'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32],
  registers: [registry],
})

export const modelTokens = new client.Counter({
  name: 'assistant_model_tokens_total',
  help: 'Tokens by kind: input (uncached), cache_read, cache_write, output',
  labelNames: ['kind'],
  registers: [registry],
})

export const toolCalls = new client.Histogram({
  name: 'assistant_tool_call_seconds',
  help: 'Tool execution time by tool and outcome',
  labelNames: ['tool', 'outcome'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5, 30],
  registers: [registry],
})

export const policyDecisions = new client.Counter({
  name: 'assistant_policy_decisions_total',
  help: 'Policy engine decisions',
  labelNames: ['decision', 'rule'],
  registers: [registry],
})

export const retrievalSeconds = new client.Histogram({
  name: 'assistant_retrieval_seconds',
  help: 'Hybrid retrieval latency (keyword + vector + fuse + rerank)',
  labelNames: ['source'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
})

export const sseConnections = new client.Gauge({
  name: 'assistant_sse_connections',
  help: 'Open turn event streams on this API instance',
  registers: [registry],
})

export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  const end = httpDuration.startTimer()
  res.on('close', () => {
    // Route patterns, not raw paths, keep label cardinality bounded.
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched'
    end({ method: req.method, route, status: String(res.statusCode) })
  })
  next()
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.set('Content-Type', registry.contentType)
  res.end(await registry.metrics())
}
