/**
 * @fileoverview Alert rules management and evaluation service.
 *
 * Provides complete lifecycle management for alerting:
 * - CRUD operations for alert rules (threshold-based conditions on metrics)
 * - Alert instance tracking (firing/resolved states)
 * - Periodic evaluation engine that checks all enabled rules
 * - Notification dispatch (console logging and webhook support)
 */

import pool from '../db/pool.js';
import _redis from '../db/redis.js';
import { queryMetrics } from './queryService.js';
import logger from '../shared/logger.js';
import { alertsFiring as _alertsFiring, alertEvaluationsTotal } from '../shared/metrics.js';
import type {
  AlertRule,
  AlertInstance,
  AlertCondition,
  AlertNotification,
  AlertSeverity,
} from '../types/index.js';

/**
 * Creates a new alert rule in the database.
 *
 * @param options - Alert rule configuration
 * @param options.name - Display name for the alert
 * @param options.description - Optional description of what the alert monitors
 * @param options.metricName - The metric to evaluate
 * @param options.tags - Tag filters for the metric (defaults to {})
 * @param options.condition - Threshold condition with operator, threshold, and aggregation
 * @param options.windowSeconds - Time window for evaluation (defaults to 300s)
 * @param options.severity - Alert severity level (defaults to 'warning')
 * @param options.notifications - Notification channels (defaults to console)
 * @param options.enabled - Whether the rule is active (defaults to true)
 * @returns The newly created alert rule
 */
export async function createAlertRule(options: {
  name: string;
  description?: string;
  metricName: string;
  tags?: Record<string, string>;
  condition: AlertCondition;
  windowSeconds?: number;
  severity?: AlertSeverity;
  notifications?: AlertNotification[];
  enabled?: boolean;
}): Promise<AlertRule> {
  const {
    name,
    description,
    metricName,
    tags = {},
    condition,
    windowSeconds = 300,
    severity = 'warning',
    notifications = [{ channel: 'console', target: 'default' }],
    enabled = true,
  } = options;

  const result = await pool.query<AlertRule>(
    `INSERT INTO alert_rules
     (name, description, metric_name, tags, condition, window_seconds, severity, notifications, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      name,
      description || null,
      metricName,
      JSON.stringify(tags),
      JSON.stringify(condition),
      windowSeconds,
      severity,
      JSON.stringify(notifications),
      enabled,
    ]
  );

  return result.rows[0];
}

/**
 * Retrieves a single alert rule by ID.
 *
 * @param id - The alert rule UUID
 * @returns The alert rule, or null if not found
 */
export async function getAlertRule(id: string): Promise<AlertRule | null> {
  const result = await pool.query<AlertRule>(
    'SELECT * FROM alert_rules WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Retrieves alert rules with optional filtering.
 *
 * @param options - Filter options
 * @param options.enabled - Filter by enabled/disabled status
 * @returns Array of matching alert rules, sorted by creation date descending
 */
export async function getAlertRules(options?: {
  enabled?: boolean;
}): Promise<AlertRule[]> {
  let query = 'SELECT * FROM alert_rules WHERE 1=1';
  const params: unknown[] = [];

  if (options?.enabled !== undefined) {
    params.push(options.enabled);
    query += ` AND enabled = $${params.length}`;
  }

  query += ' ORDER BY created_at DESC';

  const result = await pool.query<AlertRule>(query, params);
  return result.rows;
}

/**
 * Updates an existing alert rule's properties.
 *
 * Only provided fields are updated; others remain unchanged.
 * Automatically updates the updated_at timestamp.
 *
 * @param id - The alert rule UUID to update
 * @param updates - Partial object with fields to update
 * @returns The updated alert rule, or null if not found
 */
export async function updateAlertRule(
  id: string,
  updates: Partial<{
    name: string;
    description: string;
    metricName: string;
    tags: Record<string, string>;
    condition: AlertCondition;
    windowSeconds: number;
    severity: AlertSeverity;
    notifications: AlertNotification[];
    enabled: boolean;
  }>
): Promise<AlertRule | null> {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.name !== undefined) {
    params.push(updates.name);
    setClauses.push(`name = $${params.length}`);
  }

  if (updates.description !== undefined) {
    params.push(updates.description);
    setClauses.push(`description = $${params.length}`);
  }

  if (updates.metricName !== undefined) {
    params.push(updates.metricName);
    setClauses.push(`metric_name = $${params.length}`);
  }

  if (updates.tags !== undefined) {
    params.push(JSON.stringify(updates.tags));
    setClauses.push(`tags = $${params.length}`);
  }

  if (updates.condition !== undefined) {
    params.push(JSON.stringify(updates.condition));
    setClauses.push(`condition = $${params.length}`);
  }

  if (updates.windowSeconds !== undefined) {
    params.push(updates.windowSeconds);
    setClauses.push(`window_seconds = $${params.length}`);
  }

  if (updates.severity !== undefined) {
    params.push(updates.severity);
    setClauses.push(`severity = $${params.length}`);
  }

  if (updates.notifications !== undefined) {
    params.push(JSON.stringify(updates.notifications));
    setClauses.push(`notifications = $${params.length}`);
  }

  if (updates.enabled !== undefined) {
    params.push(updates.enabled);
    setClauses.push(`enabled = $${params.length}`);
  }

  if (setClauses.length === 0) {
    return getAlertRule(id);
  }

  setClauses.push('updated_at = NOW()');
  params.push(id);

  const result = await pool.query<AlertRule>(
    `UPDATE alert_rules SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  return result.rows[0] || null;
}

/**
 * Deletes an alert rule and all its instances (via CASCADE).
 *
 * @param id - The alert rule UUID to delete
 * @returns true if deleted, false if not found
 */
export async function deleteAlertRule(id: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM alert_rules WHERE id = $1', [id]);
  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Retrieves alert instances (historical and active alerts).
 *
 * @param options - Query options
 * @param options.ruleId - Filter by specific alert rule
 * @param options.status - Filter by firing/resolved status
 * @param options.limit - Maximum number of results
 * @returns Array of alert instances, sorted by fired_at descending
 */
export async function getAlertInstances(options?: {
  ruleId?: string;
  status?: 'firing' | 'resolved';
  limit?: number;
}): Promise<AlertInstance[]> {
  let query = 'SELECT * FROM alert_instances WHERE 1=1';
  const params: unknown[] = [];

  if (options?.ruleId) {
    params.push(options.ruleId);
    query += ` AND rule_id = $${params.length}`;
  }

  if (options?.status) {
    params.push(options.status);
    query += ` AND status = $${params.length}`;
  }

  query += ' ORDER BY fired_at DESC';

  if (options?.limit) {
    params.push(options.limit);
    query += ` LIMIT $${params.length}`;
  }

  const result = await pool.query<AlertInstance>(query, params);
  return result.rows;
}

/**
 * Creates a new firing alert instance for a rule.
 *
 * @param ruleId - The alert rule that triggered
 * @param value - The metric value that caused the alert
 * @returns The newly created alert instance with 'firing' status
 */
export async function createAlertInstance(
  ruleId: string,
  value: number
): Promise<AlertInstance> {
  const result = await pool.query<AlertInstance>(
    `INSERT INTO alert_instances (rule_id, status, value, fired_at)
     VALUES ($1, 'firing', $2, NOW())
     RETURNING *`,
    [ruleId, value]
  );
  return result.rows[0];
}

/**
 * Marks an alert instance as resolved.
 *
 * Sets the status to 'resolved' and records the resolution timestamp.
 *
 * @param id - The alert instance UUID to resolve
 * @returns The updated alert instance, or null if not found
 */
export async function resolveAlertInstance(id: string): Promise<AlertInstance | null> {
  const result = await pool.query<AlertInstance>(
    `UPDATE alert_instances
     SET status = 'resolved', resolved_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Evaluates a comparison condition against a numeric value.
 *
 * @param value - The metric value to evaluate
 * @param condition - The condition with operator and threshold
 * @returns true if the condition is met (alert should fire)
 */
function evaluateCondition(value: number, condition: AlertCondition): boolean {
  const { operator, threshold } = condition;
  switch (operator) {
    case '>':
      return value > threshold;
    case '<':
      return value < threshold;
    case '>=':
      return value >= threshold;
    case '<=':
      return value <= threshold;
    case '==':
      return value === threshold;
    case '!=':
      return value !== threshold;
    default:
      return false;
  }
}

/**
 * Evaluates a single alert rule against current metric data.
 *
 * Queries metrics for the rule's time window and calculates the
 * aggregated value. Compares against the threshold condition.
 *
 * @param rule - The alert rule to evaluate
 * @returns Object with shouldFire boolean and current aggregated value
 */
export async function evaluateAlertRule(rule: AlertRule): Promise<{
  shouldFire: boolean;
  currentValue: number | null;
}> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - rule.window_seconds * 1000);

  const results = await queryMetrics({
    metric_name: rule.metric_name,
    tags: rule.tags as Record<string, string>,
    start_time: startTime,
    end_time: endTime,
    aggregation: rule.condition.aggregation,
  });

  if (results.length === 0 || results[0].data.length === 0) {
    return { shouldFire: false, currentValue: null };
  }

  // Calculate aggregated value over the window
  const dataPoints = results.flatMap((r) => r.data);
  let currentValue: number;

  switch (rule.condition.aggregation) {
    case 'avg':
      currentValue =
        dataPoints.reduce((sum, dp) => sum + dp.value, 0) / dataPoints.length;
      break;
    case 'min':
      currentValue = Math.min(...dataPoints.map((dp) => dp.value));
      break;
    case 'max':
      currentValue = Math.max(...dataPoints.map((dp) => dp.value));
      break;
    case 'sum':
      currentValue = dataPoints.reduce((sum, dp) => sum + dp.value, 0);
      break;
    case 'count':
      currentValue = dataPoints.length;
      break;
    default:
      currentValue = dataPoints[dataPoints.length - 1].value;
  }

  const shouldFire = evaluateCondition(currentValue, rule.condition);

  return { shouldFire, currentValue };
}

/**
 * Evaluates all enabled alert rules and manages alert lifecycle.
 *
 * For each enabled rule:
 * - Queries current metric value
 * - Creates new alert instance if condition met and not already firing
 * - Resolves existing alert if condition no longer met
 * - Sends notifications for newly firing alerts
 *
 * @returns Promise that resolves when all rules have been evaluated
 */
export async function evaluateAllAlerts(): Promise<void> {
  const rules = await getAlertRules({ enabled: true });

  for (const rule of rules) {
    try {
      const { shouldFire, currentValue } = await evaluateAlertRule(rule);

      // Get current firing instance for this rule
      const firingInstances = await getAlertInstances({
        ruleId: rule.id,
        status: 'firing',
        limit: 1,
      });
      const currentFiring = firingInstances[0];

      if (shouldFire && currentValue !== null) {
        if (!currentFiring) {
          // Create new alert instance
          const instance = await createAlertInstance(rule.id, currentValue);
          await sendNotifications(rule, instance, currentValue);
          alertEvaluationsTotal.inc({ result: 'firing' });
        }
      } else if (!shouldFire && currentFiring) {
        // Resolve the alert
        await resolveAlertInstance(currentFiring.id);
        logger.info({ ruleId: rule.id, ruleName: rule.name }, 'Alert resolved');
        alertEvaluationsTotal.inc({ result: 'resolved' });
      } else {
        alertEvaluationsTotal.inc({ result: 'no_change' });
      }
    } catch (error) {
      logger.error({ error, ruleId: rule.id }, 'Error evaluating alert rule');
      alertEvaluationsTotal.inc({ result: 'error' });
    }
  }
}

/**
 * Dispatches notifications for a firing alert through configured channels.
 *
 * Currently supports:
 * - console: Logs alert to stdout (useful for development/debugging)
 * - webhook: Placeholder for HTTP webhook integration
 *
 * @param rule - The alert rule that triggered
 * @param instance - The alert instance being notified about
 * @param value - The metric value that triggered the alert
 */
async function sendNotifications(
  rule: AlertRule,
  instance: AlertInstance,
  value: number
): Promise<void> {
  const notifications = rule.notifications as AlertNotification[];

  for (const notification of notifications) {
    switch (notification.channel) {
      case 'console':
        logger.warn({
          alertName: rule.name,
          severity: rule.severity,
          value,
          threshold: rule.condition.threshold,
          operator: rule.condition.operator,
        }, 'Alert fired');
        break;
      case 'webhook':
        // In a real system, would send HTTP request
        logger.info({ target: notification.target }, 'Would send webhook notification');
        break;
    }
  }

  // Mark notification as sent
  await pool.query(
    'UPDATE alert_instances SET notification_sent = true WHERE id = $1',
    [instance.id]
  );
}

/**
 * Reference to the alert evaluation interval timer.
 * Used to stop the evaluator on shutdown.
 */
let alertInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the periodic alert evaluation background process.
 *
 * Runs evaluateAllAlerts on a fixed interval. Only one evaluator
 * can be active at a time - calling this again will restart with
 * the new interval.
 *
 * @param intervalSeconds - Seconds between evaluation cycles (default: 30)
 */
export function startAlertEvaluator(intervalSeconds: number = 30): void {
  if (alertInterval) {
    clearInterval(alertInterval);
  }

  logger.info({ intervalSeconds }, 'Starting alert evaluator');

  alertInterval = setInterval(async () => {
    try {
      await evaluateAllAlerts();
    } catch (error) {
      logger.error({ error }, 'Alert evaluation error');
    }
  }, intervalSeconds * 1000);

  // Run once immediately
  evaluateAllAlerts().catch((error) => logger.error({ error }, 'Initial alert evaluation failed'));
}

/**
 * Stops the periodic alert evaluation process.
 *
 * Should be called during graceful shutdown to clean up the interval.
 */
export function stopAlertEvaluator(): void {
  if (alertInterval) {
    clearInterval(alertInterval);
    alertInterval = null;
  }
}
