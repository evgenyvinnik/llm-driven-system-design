# Dashboarding System (Metrics Monitoring) - System Design Answer (Fullstack Focus)

## 45-minute system design interview format - Fullstack Engineer Position

---

## Introduction

"Today I'll design a metrics monitoring and visualization system similar to Datadog or Grafana. This system collects time-series metrics from servers, stores them efficiently, and provides real-time dashboards and alerting. As a fullstack engineer, I'll focus on how the frontend and backend work together: shared type definitions, API contracts, real-time data flow, and end-to-end feature implementation."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm the core end-to-end functionality:

1. **Metrics Ingestion**: Agents push metrics to API, stored in time-series database
2. **Dashboard Viewing**: Frontend queries backend, renders charts with auto-refresh
3. **Dashboard Editing**: Drag-and-drop UI, changes persist to backend
4. **Alert Configuration**: Create rules in UI, backend evaluates and sends notifications
5. **Time Range Selection**: Frontend controls time range, backend queries appropriate tables"

### Non-Functional Requirements

"For a fullstack monitoring system:

- **End-to-End Latency**: User action to UI update < 200ms
- **API Contract Stability**: Breaking changes require versioning
- **Type Safety**: Shared types between frontend and backend
- **Real-Time Feel**: 10-second refresh without flicker"

---

## Step 2: API Contract and Shared Types

### Shared Type Definitions

```typescript
// shared/types.ts - Used by both frontend and backend

// ============ Metrics ============

export interface MetricPoint {
  name: string;
  value: number;
  tags?: Record<string, string>;
  timestamp?: number; // Unix ms, optional (server adds if missing)
}

export interface MetricDataPoint {
  time: string; // ISO 8601
  value: number;
}

export interface QueryParams {
  query: string;           // Metric name
  start: string;           // ISO 8601
  end: string;             // ISO 8601
  aggregation?: 'avg' | 'min' | 'max' | 'sum' | 'count';
  step?: string;           // e.g., '1m', '5m', '1h'
  tags?: Record<string, string>;
}

export interface QueryResult {
  data: MetricDataPoint[];
  meta: {
    table: string;         // Which table was queried
    resolution: string;    // Data resolution
    cached: boolean;       // Whether result was cached
  };
}

// ============ Dashboards ============

export interface Dashboard {
  id: string;
  name: string;
  description?: string;
  ownerId: number;
  panels: Panel[];
  layout: PanelLayout[];
  createdAt: string;
  updatedAt: string;
}

export interface Panel {
  id: string;
  dashboardId: string;
  title: string;
  type: PanelType;
  query: string;
  options: PanelOptions;
  position: Position;
}

export type PanelType = 'line' | 'area' | 'bar' | 'gauge' | 'stat';

export interface Position {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanelOptions {
  unit?: string;
  color?: string;
  showLegend?: boolean;
  thresholds?: {
    warning: number;
    critical: number;
  };
  // Stat-specific
  calculation?: 'last' | 'avg' | 'min' | 'max' | 'sum';
  // Gauge-specific
  min?: number;
  max?: number;
}

export interface PanelLayout {
  i: string;  // Panel ID
  x: number;
  y: number;
  w: number;
  h: number;
}

// ============ Alerts ============

export interface AlertRule {
  id: string;
  name: string;
  query: string;
  condition: AlertCondition;
  threshold: number;
  duration: string;        // PostgreSQL interval format
  severity: AlertSeverity;
  enabled: boolean;
  notification: AlertNotification;
  createdAt: string;
  updatedAt: string;
}

export type AlertCondition = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne';
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertNotification {
  type: 'email' | 'webhook';
  target: string;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  ruleName?: string;
  status: 'firing' | 'resolved';
  value: number;
  triggeredAt: string;
  resolvedAt?: string;
}

// ============ API Responses ============

export interface ApiResponse<T> {
  data: T;
  meta?: {
    total?: number;
    page?: number;
    pageSize?: number;
  };
}

export interface ApiError {
  error: string;
  code?: string;
  details?: Record<string, string>;
}
```

### Zod Validation Schemas (Used by Both)

```typescript
// shared/validation.ts

import { z } from 'zod';

// Metric ingestion validation
export const MetricPointSchema = z.object({
  name: z.string().min(1).max(255).regex(/^[a-zA-Z_][a-zA-Z0-9_.]*$/),
  value: z.number().finite(),
  tags: z.record(z.string().max(256)).optional(),
  timestamp: z.number().int().positive().optional(),
});

export const MetricBatchSchema = z.array(MetricPointSchema).min(1).max(1000);

// Query validation
export const QueryParamsSchema = z.object({
  query: z.string().min(1).max(255),
  start: z.string().datetime(),
  end: z.string().datetime(),
  aggregation: z.enum(['avg', 'min', 'max', 'sum', 'count']).optional(),
  step: z.string().regex(/^\d+[mhd]$/).optional(),
  tags: z.record(z.string()).optional(),
}).refine(
  (data) => new Date(data.start) < new Date(data.end),
  { message: 'Start must be before end' }
);

// Panel creation validation
export const CreatePanelSchema = z.object({
  title: z.string().min(1).max(255),
  type: z.enum(['line', 'area', 'bar', 'gauge', 'stat']),
  query: z.string().min(1),
  options: z.object({
    unit: z.string().optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    showLegend: z.boolean().optional(),
    thresholds: z.object({
      warning: z.number(),
      critical: z.number(),
    }).optional(),
    calculation: z.enum(['last', 'avg', 'min', 'max', 'sum']).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }).optional(),
  position: z.object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    w: z.number().int().min(1).max(12),
    h: z.number().int().min(1).max(8),
  }),
});

// Alert rule validation
export const CreateAlertRuleSchema = z.object({
  name: z.string().min(1).max(255),
  query: z.string().min(1),
  condition: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'ne']),
  threshold: z.number().finite(),
  duration: z.string().regex(/^\d+ (minute|minutes|hour|hours)$/),
  severity: z.enum(['info', 'warning', 'critical']),
  notification: z.object({
    type: z.enum(['email', 'webhook']),
    target: z.string().min(1),
  }),
});

// Type inference from schemas
export type CreatePanelInput = z.infer<typeof CreatePanelSchema>;
export type CreateAlertRuleInput = z.infer<typeof CreateAlertRuleSchema>;
```

---

## Step 3: End-to-End Data Flow

### Dashboard Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Dashboard View Flow                                 │
└─────────────────────────────────────────────────────────────────────────────┘

  1. User navigates to /dashboard/:id

  ┌──────────────────────┐
  │   Frontend Router    │
  │   (TanStack Router)  │
  └──────────┬───────────┘
             │ Route match → dashboardStore.fetchDashboard(id)
             ▼
  ┌──────────────────────┐      GET /api/v1/dashboards/:id
  │   API Client         │─────────────────────────────────────────┐
  │   (fetch wrapper)    │                                         │
  └──────────┬───────────┘                                         ▼
             │                                          ┌──────────────────────┐
             │                                          │   API Server         │
             │                                          │   (Express)          │
             │                                          └──────────┬───────────┘
             │                                                     │
             │                                                     ▼
             │                                          ┌──────────────────────┐
             │                                          │   PostgreSQL         │
             │                                          │   SELECT dashboard,  │
             │                                          │   panels JOIN        │
             │                                          └──────────┬───────────┘
             │                                                     │
  ┌──────────▼───────────┐      { dashboard, panels }              │
  │   Zustand Store      │◄────────────────────────────────────────┘
  │   (dashboardStore)   │
  └──────────┬───────────┘
             │ State update triggers re-render
             ▼
  ┌──────────────────────┐
  │   DashboardGrid      │  For each panel:
  │   Component          │
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐      POST /api/v1/query
  │   DashboardPanel     │─────────────────────────────────────────┐
  │   useQuery hook      │                                         │
  │   (with polling)     │                                         ▼
  └──────────┬───────────┘                              ┌──────────────────────┐
             │                                          │   Query Service      │
             │                                          │   - Cache check      │
             │                                          │   - Table selection  │
             │                                          │   - Query execution  │
             │                                          └──────────┬───────────┘
             │                                                     │
             │                                                     ▼
             │                                          ┌──────────────────────┐
             │                                          │   TimescaleDB        │
             │                                          │   - metrics_raw      │
             │                                          │   - metrics_1min     │
             │                                          │   - metrics_1hour    │
             │                                          └──────────┬───────────┘
             │                                                     │
  ┌──────────▼───────────┐      { data: [...], meta: {...} }       │
  │   Chart Component    │◄────────────────────────────────────────┘
  │   (Recharts)         │
  └──────────────────────┘

  2. Auto-refresh every 10 seconds (polling in useQuery hook)
```

### Panel Update Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Panel Edit Flow                                     │
└─────────────────────────────────────────────────────────────────────────────┘

  1. User drags panel to new position

  ┌──────────────────────┐
  │   react-grid-layout  │
  │   onLayoutChange     │
  └──────────┬───────────┘
             │ Debounced callback (500ms)
             ▼
  ┌──────────────────────┐
  │   dashboardStore     │
  │   updateLayout()     │
  │   - Immediate local  │
  └──────────┬───────────┘
             │
             ├──► Optimistic UI update (instant feedback)
             │
             ▼
  ┌──────────────────────┐      PUT /api/v1/dashboards/:id
  │   API Client         │─────────────────────────────────────────┐
  │   (async, fire once) │                                         │
  └──────────────────────┘                                         ▼
                                                        ┌──────────────────────┐
                                                        │   API Server         │
                                                        │   - Validate layout  │
                                                        │   - Check ownership  │
                                                        └──────────┬───────────┘
                                                                   │
                                                                   ▼
                                                        ┌──────────────────────┐
                                                        │   PostgreSQL         │
                                                        │   UPDATE panels      │
                                                        │   SET position = ... │
                                                        └──────────┬───────────┘
                                                                   │
                                                                   │ 200 OK
                                                                   ▼
                                                        ┌──────────────────────┐
                                                        │   Cache Invalidation │
                                                        │   DEL cache:dash:id  │
                                                        └──────────────────────┘

  Success: No visible change (already updated optimistically)
  Failure: Show error toast, optionally revert to server state
```

---

## Step 4: API Layer Implementation

### Backend API Routes

```typescript
// backend/src/routes/dashboards.ts

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireOwnerOrAdmin } from '../shared/auth.js';
import { dashboardService } from '../services/dashboardService.js';
import { CreatePanelSchema } from '../../shared/validation.js';
import type { Dashboard, Panel, ApiResponse } from '../../shared/types.js';

const router = Router();

// List dashboards
router.get('/', requireAuth, async (req, res) => {
  const dashboards = await dashboardService.listForUser(req.user.id);
  res.json({ data: dashboards } satisfies ApiResponse<Dashboard[]>);
});

// Get single dashboard with panels
router.get('/:id', requireAuth, async (req, res) => {
  const dashboard = await dashboardService.getById(req.params.id);

  if (!dashboard) {
    return res.status(404).json({ error: 'Dashboard not found' });
  }

  // Check access (owner or public)
  if (dashboard.ownerId !== req.user.id && !dashboard.isPublic) {
    return res.status(403).json({ error: 'Access denied' });
  }

  res.json({ data: dashboard } satisfies ApiResponse<Dashboard>);
});

// Create dashboard
router.post('/', requireAuth, async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).max(255),
    description: z.string().max(1000).optional(),
  });

  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({
      error: 'Validation failed',
      details: result.error.flatten().fieldErrors,
    });
  }

  const dashboard = await dashboardService.create({
    ...result.data,
    ownerId: req.user.id,
  });

  res.status(201).json({ data: dashboard } satisfies ApiResponse<Dashboard>);
});

// Update dashboard
router.put('/:id', requireAuth, requireOwnerOrAdmin('dashboard'), async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(1000).optional(),
    layout: z.array(z.object({
      i: z.string(),
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      w: z.number().int().min(1).max(12),
      h: z.number().int().min(1).max(8),
    })).optional(),
  });

  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({
      error: 'Validation failed',
      details: result.error.flatten().fieldErrors,
    });
  }

  const updated = await dashboardService.update(req.params.id, result.data);

  // Invalidate cache
  await redis.del(`cache:dashboard:${req.params.id}`);

  res.json({ data: updated } satisfies ApiResponse<Dashboard>);
});

// Add panel to dashboard
router.post('/:id/panels', requireAuth, requireOwnerOrAdmin('dashboard'), async (req, res) => {
  const result = CreatePanelSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({
      error: 'Validation failed',
      details: result.error.flatten().fieldErrors,
    });
  }

  const panel = await dashboardService.addPanel(req.params.id, result.data);

  res.status(201).json({ data: panel } satisfies ApiResponse<Panel>);
});

export default router;
```

### Frontend API Client

```typescript
// frontend/src/services/api.ts

import type {
  Dashboard,
  Panel,
  AlertRule,
  AlertEvent,
  QueryParams,
  QueryResult,
  MetricPoint,
  ApiResponse,
  ApiError,
  CreatePanelInput,
  CreateAlertRuleInput,
} from '../../shared/types';

const API_BASE = import.meta.env.VITE_API_URL || '/api/v1';

class ApiClient {
  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include', // Include session cookie
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error: ApiError = await response.json();
      throw new Error(error.error || 'Request failed');
    }

    const result: ApiResponse<T> = await response.json();
    return result.data;
  }

  // Dashboards
  async getDashboards(): Promise<Dashboard[]> {
    return this.request('GET', '/dashboards');
  }

  async getDashboard(id: string): Promise<Dashboard> {
    return this.request('GET', `/dashboards/${id}`);
  }

  async createDashboard(data: { name: string; description?: string }): Promise<Dashboard> {
    return this.request('POST', '/dashboards', data);
  }

  async updateDashboard(id: string, data: Partial<Dashboard>): Promise<Dashboard> {
    return this.request('PUT', `/dashboards/${id}`, data);
  }

  async deleteDashboard(id: string): Promise<void> {
    return this.request('DELETE', `/dashboards/${id}`);
  }

  // Panels
  async addPanel(dashboardId: string, panel: CreatePanelInput): Promise<Panel> {
    return this.request('POST', `/dashboards/${dashboardId}/panels`, panel);
  }

  async updatePanel(id: string, data: Partial<Panel>): Promise<Panel> {
    return this.request('PUT', `/panels/${id}`, data);
  }

  async deletePanel(id: string): Promise<void> {
    return this.request('DELETE', `/panels/${id}`);
  }

  // Queries
  async executeQuery(params: QueryParams): Promise<QueryResult> {
    return this.request('POST', '/query', params);
  }

  // Alerts
  async getAlertRules(): Promise<AlertRule[]> {
    return this.request('GET', '/alerts');
  }

  async createAlertRule(data: CreateAlertRuleInput): Promise<AlertRule> {
    return this.request('POST', '/alerts', data);
  }

  async updateAlertRule(id: string, data: Partial<AlertRule>): Promise<AlertRule> {
    return this.request('PUT', `/alerts/${id}`, data);
  }

  async deleteAlertRule(id: string): Promise<void> {
    return this.request('DELETE', `/alerts/${id}`);
  }

  async getAlertHistory(ruleId?: string): Promise<AlertEvent[]> {
    const path = ruleId ? `/alerts/${ruleId}/history` : '/alerts/history';
    return this.request('GET', path);
  }

  async evaluateAlertRule(id: string): Promise<{ firing: boolean; value: number }> {
    return this.request('POST', `/alerts/${id}/evaluate`);
  }

  // Metrics
  async ingestMetrics(metrics: MetricPoint[]): Promise<{ accepted: number }> {
    return this.request('POST', '/metrics', metrics);
  }

  async listMetrics(): Promise<{ name: string; type: string }[]> {
    return this.request('GET', '/metrics');
  }

  async getMetricTags(name: string): Promise<Record<string, string[]>> {
    return this.request('GET', `/metrics/${encodeURIComponent(name)}/tags`);
  }
}

export const api = new ApiClient();
```

---

## Step 5: Query Service with Table Routing

### Backend Query Service

```typescript
// backend/src/services/queryService.ts

import { pool } from '../shared/db.js';
import { redis } from '../shared/cache.js';
import { queryCircuitBreaker } from '../shared/circuitBreaker.js';
import type { QueryParams, QueryResult, MetricDataPoint } from '../../shared/types.js';
import crypto from 'crypto';

export class QueryService {
  /**
   * Execute a metrics query with automatic table selection and caching.
   */
  async execute(params: QueryParams): Promise<QueryResult> {
    const start = new Date(params.start);
    const end = new Date(params.end);

    // Generate cache key
    const cacheKey = this.generateCacheKey(params);

    // Check cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      const result = JSON.parse(cached) as QueryResult;
      return { ...result, meta: { ...result.meta, cached: true } };
    }

    // Select appropriate table based on time range
    const { table, resolution } = this.selectTable(start, end);

    // Build and execute query
    const data = await queryCircuitBreaker.fire(async () => {
      return this.executeQuery(params, table, start, end);
    });

    const result: QueryResult = {
      data,
      meta: { table, resolution, cached: false },
    };

    // Cache result (shorter TTL for live data)
    const isHistorical = end < new Date(Date.now() - 60000);
    const ttl = isHistorical ? 300 : 10;
    await redis.setex(cacheKey, ttl, JSON.stringify(result));

    return result;
  }

  private selectTable(start: Date, end: Date): { table: string; resolution: string } {
    const rangeMs = end.getTime() - start.getTime();
    const rangeHours = rangeMs / (1000 * 60 * 60);

    if (rangeHours <= 1) {
      return { table: 'metrics_raw', resolution: '1 second' };
    } else if (rangeHours <= 24) {
      return { table: 'metrics_1min', resolution: '1 minute' };
    } else {
      return { table: 'metrics_1hour', resolution: '1 hour' };
    }
  }

  private async executeQuery(
    params: QueryParams,
    table: string,
    start: Date,
    end: Date
  ): Promise<MetricDataPoint[]> {
    const agg = params.aggregation || 'avg';
    const step = params.step || this.getDefaultStep(table);

    let sql: string;
    const queryParams: (string | Date)[] = [];

    if (table === 'metrics_raw') {
      sql = `
        SELECT
          time_bucket($1::interval, time) AS time,
          ${agg}(value) AS value
        FROM metrics_raw m
        JOIN metric_definitions md ON m.metric_id = md.id
        WHERE md.name = $2
          AND m.time >= $3
          AND m.time < $4
      `;
      queryParams.push(step, params.query, start, end);
    } else {
      // Use pre-aggregated columns from continuous aggregate
      const valueColumn = agg === 'count' ? 'sample_count' :
                         agg === 'sum' ? 'avg_value * sample_count' :
                         `${agg}_value`;
      sql = `
        SELECT
          time_bucket($1::interval, bucket) AS time,
          ${agg.toUpperCase()}(${valueColumn}) AS value
        FROM ${table} m
        JOIN metric_definitions md ON m.metric_id = md.id
        WHERE md.name = $2
          AND bucket >= $3
          AND bucket < $4
      `;
      queryParams.push(step, params.query, start, end);
    }

    // Add tag filters if provided
    if (params.tags && Object.keys(params.tags).length > 0) {
      sql += ` AND m.tags @> $${queryParams.length + 1}::jsonb`;
      queryParams.push(JSON.stringify(params.tags) as unknown as Date);
    }

    sql += ` GROUP BY time ORDER BY time`;

    const result = await pool.query(sql, queryParams);

    return result.rows.map((row) => ({
      time: row.time.toISOString(),
      value: parseFloat(row.value),
    }));
  }

  private getDefaultStep(table: string): string {
    switch (table) {
      case 'metrics_raw': return '10 seconds';
      case 'metrics_1min': return '1 minute';
      case 'metrics_1hour': return '1 hour';
      default: return '1 minute';
    }
  }

  private generateCacheKey(params: QueryParams): string {
    const normalized = {
      query: params.query.trim().toLowerCase(),
      start: Math.floor(new Date(params.start).getTime() / 10000) * 10000,
      end: Math.floor(new Date(params.end).getTime() / 10000) * 10000,
      agg: params.aggregation || 'avg',
      step: params.step,
      tags: JSON.stringify(params.tags || {}),
    };

    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex')
      .substring(0, 16);

    return `cache:query:${hash}`;
  }
}

export const queryService = new QueryService();
```

---

## Step 6: Alert System End-to-End

### Backend Alert Evaluator

```typescript
// backend/src/services/alertEvaluator.ts

import { pool } from '../shared/db.js';
import { redis } from '../shared/cache.js';
import { queryService } from './queryService.js';
import { notificationService } from './notificationService.js';
import type { AlertRule, AlertEvent } from '../../shared/types.js';

export class AlertEvaluator {
  private evaluationIntervalMs = 10000;

  start(): void {
    setInterval(() => this.evaluateAll(), this.evaluationIntervalMs);
    console.log('Alert evaluator started');
  }

  private async evaluateAll(): Promise<void> {
    const result = await pool.query<AlertRule>(
      'SELECT * FROM alert_rules WHERE enabled = true'
    );

    for (const rule of result.rows) {
      try {
        await this.evaluateRule(rule);
      } catch (error) {
        console.error(`Alert evaluation failed for rule ${rule.id}:`, error);
      }
    }
  }

  private async evaluateRule(rule: AlertRule): Promise<void> {
    // Query recent data
    const duration = this.parseDuration(rule.duration);
    const end = new Date();
    const start = new Date(end.getTime() - duration);

    const result = await queryService.execute({
      query: rule.query,
      start: start.toISOString(),
      end: end.toISOString(),
      aggregation: 'avg',
    });

    if (result.data.length === 0) return;

    const latestValue = result.data[result.data.length - 1].value;
    const conditionMet = this.checkCondition(latestValue, rule.condition, rule.threshold);

    // Get alert state from Redis
    const stateKey = `alert:state:${rule.id}`;
    const state = await redis.hgetall(stateKey);

    if (conditionMet) {
      if (!state.firstTriggered) {
        // Start tracking
        await redis.hset(stateKey, {
          firstTriggered: Date.now().toString(),
          currentValue: latestValue.toString(),
        });
        await redis.expire(stateKey, 3600);
      } else {
        // Check if duration met
        const triggerTime = parseInt(state.firstTriggered, 10);
        if (Date.now() - triggerTime >= duration) {
          await this.fireAlert(rule, latestValue);
        }
      }
    } else {
      // Resolve if was firing
      if (state.firing === 'true') {
        await this.resolveAlert(rule);
      }
      await redis.del(stateKey);
    }
  }

  private checkCondition(value: number, condition: string, threshold: number): boolean {
    switch (condition) {
      case 'gt': return value > threshold;
      case 'gte': return value >= threshold;
      case 'lt': return value < threshold;
      case 'lte': return value <= threshold;
      case 'eq': return Math.abs(value - threshold) < 0.0001;
      case 'ne': return Math.abs(value - threshold) >= 0.0001;
      default: return false;
    }
  }

  private async fireAlert(rule: AlertRule, value: number): Promise<void> {
    const stateKey = `alert:state:${rule.id}`;
    const state = await redis.hgetall(stateKey);

    if (state.firing === 'true') return; // Already firing

    // Mark as firing
    await redis.hset(stateKey, { firing: 'true', firedAt: Date.now().toString() });

    // Record event
    await pool.query(
      `INSERT INTO alert_events (rule_id, status, value, triggered_at)
       VALUES ($1, 'firing', $2, NOW())`,
      [rule.id, value]
    );

    // Send notification
    await notificationService.send(rule, value);

    console.log(`Alert fired: ${rule.name} (value: ${value})`);
  }

  private async resolveAlert(rule: AlertRule): Promise<void> {
    await pool.query(
      `UPDATE alert_events SET status = 'resolved', resolved_at = NOW()
       WHERE rule_id = $1 AND status = 'firing'`,
      [rule.id]
    );

    await redis.del(`alert:state:${rule.id}`);

    console.log(`Alert resolved: ${rule.name}`);
  }

  private parseDuration(duration: string): number {
    const match = duration.match(/^(\d+)\s*(minute|minutes|hour|hours)$/);
    if (!match) return 300000; // Default 5 minutes

    const value = parseInt(match[1], 10);
    const unit = match[2];

    if (unit.startsWith('hour')) {
      return value * 60 * 60 * 1000;
    }
    return value * 60 * 1000;
  }
}
```

### Frontend Alert Hook

```typescript
// frontend/src/hooks/useAlerts.ts

import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import type { AlertRule, AlertEvent, CreateAlertRuleInput } from '../../shared/types';

interface UseAlertsReturn {
  rules: AlertRule[];
  events: AlertEvent[];
  loading: boolean;
  error: string | null;
  createRule: (data: CreateAlertRuleInput) => Promise<void>;
  updateRule: (id: string, data: Partial<AlertRule>) => Promise<void>;
  deleteRule: (id: string) => Promise<void>;
  evaluateRule: (id: string) => Promise<{ firing: boolean; value: number }>;
  refetch: () => Promise<void>;
}

export function useAlerts(): UseAlertsReturn {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const [rulesData, eventsData] = await Promise.all([
        api.getAlertRules(),
        api.getAlertHistory(),
      ]);
      setRules(rulesData);
      setEvents(eventsData);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load alerts');
      setLoading(false);
    }
  }, []);

  // Initial fetch and polling
  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [fetchData]);

  const createRule = async (data: CreateAlertRuleInput): Promise<void> => {
    const newRule = await api.createAlertRule(data);
    setRules((prev) => [...prev, newRule]);
  };

  const updateRule = async (id: string, data: Partial<AlertRule>): Promise<void> => {
    const updated = await api.updateAlertRule(id, data);
    setRules((prev) => prev.map((r) => (r.id === id ? updated : r)));
  };

  const deleteRule = async (id: string): Promise<void> => {
    await api.deleteAlertRule(id);
    setRules((prev) => prev.filter((r) => r.id !== id));
  };

  const evaluateRule = async (id: string): Promise<{ firing: boolean; value: number }> => {
    return api.evaluateAlertRule(id);
  };

  return {
    rules,
    events,
    loading,
    error,
    createRule,
    updateRule,
    deleteRule,
    evaluateRule,
    refetch: fetchData,
  };
}
```

---

## Step 7: Database Schema

```sql
-- shared/db/init.sql

-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Users
CREATE TABLE users (
    id              SERIAL PRIMARY KEY,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    role            VARCHAR(20) DEFAULT 'viewer',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Metric definitions
CREATE TABLE metric_definitions (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL UNIQUE,
    description     TEXT,
    unit            VARCHAR(50),
    type            VARCHAR(20) DEFAULT 'gauge',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_metric_definitions_name ON metric_definitions(name);

-- Raw metrics (hypertable)
CREATE TABLE metrics_raw (
    time            TIMESTAMPTZ NOT NULL,
    metric_id       INTEGER NOT NULL REFERENCES metric_definitions(id),
    value           DOUBLE PRECISION NOT NULL,
    tags            JSONB DEFAULT '{}'::jsonb
);
SELECT create_hypertable('metrics_raw', 'time', chunk_time_interval => INTERVAL '1 day');
CREATE INDEX idx_metrics_raw_metric_time ON metrics_raw(metric_id, time DESC);
CREATE INDEX idx_metrics_raw_tags ON metrics_raw USING GIN(tags);

-- Continuous aggregates
CREATE MATERIALIZED VIEW metrics_1min
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', time) AS bucket,
    metric_id,
    tags,
    AVG(value) AS avg_value,
    MIN(value) AS min_value,
    MAX(value) AS max_value,
    COUNT(*) AS sample_count
FROM metrics_raw
GROUP BY bucket, metric_id, tags
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_1min',
    start_offset => INTERVAL '1 hour',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute'
);

CREATE MATERIALIZED VIEW metrics_1hour
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', bucket) AS bucket,
    metric_id,
    tags,
    AVG(avg_value) AS avg_value,
    MIN(min_value) AS min_value,
    MAX(max_value) AS max_value,
    SUM(sample_count) AS sample_count
FROM metrics_1min
GROUP BY time_bucket('1 hour', bucket), metric_id, tags
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_1hour',
    start_offset => INTERVAL '1 day',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour'
);

-- Retention policies
SELECT add_retention_policy('metrics_raw', INTERVAL '7 days');
SELECT add_retention_policy('metrics_1min', INTERVAL '30 days');
SELECT add_retention_policy('metrics_1hour', INTERVAL '365 days');

-- Dashboards
CREATE TABLE dashboards (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    owner_id        INTEGER REFERENCES users(id),
    is_public       BOOLEAN DEFAULT false,
    layout          JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Panels
CREATE TABLE panels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id    UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    title           VARCHAR(255) NOT NULL,
    type            VARCHAR(50) NOT NULL,
    query           TEXT NOT NULL,
    options         JSONB DEFAULT '{}'::jsonb,
    position        JSONB NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_panels_dashboard ON panels(dashboard_id);

-- Alert rules
CREATE TABLE alert_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    query           TEXT NOT NULL,
    condition       VARCHAR(20) NOT NULL,
    threshold       DOUBLE PRECISION NOT NULL,
    duration        INTERVAL NOT NULL DEFAULT '5 minutes',
    severity        VARCHAR(20) DEFAULT 'warning',
    enabled         BOOLEAN DEFAULT true,
    notification    JSONB NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Alert events
CREATE TABLE alert_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id         UUID NOT NULL REFERENCES alert_rules(id),
    status          VARCHAR(20) NOT NULL,
    value           DOUBLE PRECISION,
    triggered_at    TIMESTAMPTZ DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ
);
CREATE INDEX idx_alert_events_rule_time ON alert_events(rule_id, triggered_at DESC);
```

---

## Step 8: Real-Time Data Synchronization

### Polling with Optimistic Updates

```typescript
// Frontend pattern for real-time feel with polling

// 1. Optimistic local update
function DashboardPanel({ panel }: { panel: Panel }) {
  const { start, end, refreshInterval } = useTimeRangeStore();

  const { data, isLoading, error } = useQuery({
    queryKey: ['panel', panel.id, start.toISOString(), end.toISOString()],
    queryFn: () => api.executeQuery({
      query: panel.query,
      start: start.toISOString(),
      end: end.toISOString(),
    }),
    refetchInterval: refreshInterval * 1000,
    // Don't show loading on refetch (prevents flicker)
    staleTime: refreshInterval * 1000 * 0.9,
  });

  // ... render chart
}

// 2. Dashboard layout with optimistic save
function DashboardGrid({ dashboard }: { dashboard: Dashboard }) {
  const { updateLayout } = useDashboardStore();
  const saveToServer = useDebouncedCallback(async (layout: Layout[]) => {
    await api.updateDashboard(dashboard.id, { layout });
  }, 500);

  const handleLayoutChange = (layout: Layout[]) => {
    // Immediate local update
    updateLayout(layout);
    // Debounced server save
    saveToServer(layout);
  };

  // ... render grid
}

// 3. Alert toggle with optimistic update
function AlertRuleCard({ rule }: { rule: AlertRule }) {
  const { updateRule } = useAlerts();
  const [optimisticEnabled, setOptimisticEnabled] = useState(rule.enabled);

  const handleToggle = async () => {
    // Optimistic update
    setOptimisticEnabled(!optimisticEnabled);

    try {
      await updateRule(rule.id, { enabled: !rule.enabled });
    } catch (error) {
      // Revert on failure
      setOptimisticEnabled(rule.enabled);
      toast.error('Failed to update alert');
    }
  };

  // ... render with optimisticEnabled
}
```

### Cache Invalidation Pattern

```typescript
// Backend: Invalidate cache when data changes

// On dashboard update
router.put('/:id', async (req, res) => {
  const updated = await dashboardService.update(req.params.id, req.body);

  // Invalidate dashboard cache
  await redis.del(`cache:dashboard:${req.params.id}`);

  res.json({ data: updated });
});

// On panel update
router.put('/panels/:id', async (req, res) => {
  const updated = await panelService.update(req.params.id, req.body);

  // Invalidate parent dashboard cache
  await redis.del(`cache:dashboard:${updated.dashboardId}`);

  res.json({ data: updated });
});

// Frontend: Refetch after mutation
const useDashboardStore = create((set, get) => ({
  updatePanel: async (panelId, updates) => {
    await api.updatePanel(panelId, updates);

    // Local state update
    set((state) => ({
      currentDashboard: {
        ...state.currentDashboard,
        panels: state.currentDashboard.panels.map((p) =>
          p.id === panelId ? { ...p, ...updates } : p
        ),
      },
    }));

    // Query cache is time-based, no explicit invalidation needed
  },
}));
```

---

## Step 9: Error Handling Across the Stack

### Backend Error Handling

```typescript
// backend/src/middleware/errorHandler.ts

import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import type { ApiError } from '../../shared/types.js';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error(`[${req.method} ${req.path}]`, err);

  // Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: err.flatten().fieldErrors,
    } satisfies ApiError);
    return;
  }

  // Custom application errors
  if (err.name === 'NotFoundError') {
    res.status(404).json({
      error: err.message,
      code: 'NOT_FOUND',
    } satisfies ApiError);
    return;
  }

  if (err.name === 'UnauthorizedError') {
    res.status(401).json({
      error: err.message,
      code: 'UNAUTHORIZED',
    } satisfies ApiError);
    return;
  }

  if (err.name === 'ForbiddenError') {
    res.status(403).json({
      error: err.message,
      code: 'FORBIDDEN',
    } satisfies ApiError);
    return;
  }

  // Database errors
  if (err.message.includes('unique constraint')) {
    res.status(409).json({
      error: 'Resource already exists',
      code: 'CONFLICT',
    } satisfies ApiError);
    return;
  }

  // Generic server error
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  } satisfies ApiError);
}
```

### Frontend Error Handling

```typescript
// frontend/src/components/common/ErrorBoundary.tsx

import { Component, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="flex flex-col items-center justify-center p-8 text-center">
          <AlertTriangle size={48} className="text-red-400 mb-4" />
          <h3 className="text-lg font-medium text-dashboard-text mb-2">
            Something went wrong
          </h3>
          <p className="text-dashboard-muted mb-4">
            {this.state.error?.message}
          </p>
          <button
            onClick={this.handleRetry}
            className="flex items-center gap-2 px-4 py-2 bg-dashboard-accent rounded"
          >
            <RefreshCw size={16} />
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

// API error handling in hooks
function useQuery<T>({ queryFn, onError }: Options<T>) {
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    try {
      setError(null);
      const result = await queryFn();
      setData(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      onError?.(err);
    }
  };

  // ...
}
```

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| Type Sharing | Shared TypeScript types | OpenAPI codegen | Simpler for monorepo, direct imports |
| Validation | Zod (both ends) | Joi, Yup | Type inference, same library both ends |
| Real-time Updates | Polling | WebSocket | Simpler, caching-friendly, sufficient for 10s refresh |
| State Management | Zustand | Redux, Context | Lightweight, TypeScript support |
| Error Handling | Error boundaries + try/catch | Global error store | React-native pattern, localized recovery |
| Cache Strategy | Redis + short TTL | Stale-while-revalidate | Backend-controlled freshness |

---

## Summary

"To summarize the fullstack architecture for this dashboarding system:

1. **Shared Types**: TypeScript interfaces and Zod schemas used by both frontend and backend ensure type safety across the stack

2. **API Contract**: RESTful endpoints with consistent response format, validation errors include field-level details

3. **Data Flow**: Frontend polls backend every 10 seconds, backend routes queries to appropriate TimescaleDB tables based on time range

4. **State Management**: Zustand stores on frontend mirror backend data, optimistic updates provide instant feedback

5. **Error Handling**: Zod validation on both ends, error boundaries in React, consistent error response format

Key fullstack insights:
- Shared types prevent drift between frontend and backend
- Optimistic updates + debounced saves provide responsive UX
- Table routing (raw vs. aggregated) is transparent to frontend
- Cache invalidation is time-based for simplicity

What aspect would you like me to elaborate on?"
