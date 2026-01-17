import pool from '../db/pool.js';
import redis from '../db/redis.js';
import { queryMetrics } from './queryService.js';
import type {
  AlertRule,
  AlertInstance,
  AlertCondition,
  AlertNotification,
  AlertSeverity,
} from '../types/index.js';

// Alert rule CRUD
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

export async function getAlertRule(id: string): Promise<AlertRule | null> {
  const result = await pool.query<AlertRule>(
    'SELECT * FROM alert_rules WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

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

export async function deleteAlertRule(id: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM alert_rules WHERE id = $1', [id]);
  return result.rowCount !== null && result.rowCount > 0;
}

// Alert instances
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

// Alert evaluation
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

// Run alert evaluation for all enabled rules
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
        }
      } else if (!shouldFire && currentFiring) {
        // Resolve the alert
        await resolveAlertInstance(currentFiring.id);
        console.log(`Alert resolved: ${rule.name}`);
      }
    } catch (error) {
      console.error(`Error evaluating alert rule ${rule.id}:`, error);
    }
  }
}

async function sendNotifications(
  rule: AlertRule,
  instance: AlertInstance,
  value: number
): Promise<void> {
  const notifications = rule.notifications as AlertNotification[];

  for (const notification of notifications) {
    switch (notification.channel) {
      case 'console':
        console.log(
          `[ALERT] ${rule.severity.toUpperCase()}: ${rule.name} - Value: ${value.toFixed(2)} (threshold: ${rule.condition.operator} ${rule.condition.threshold})`
        );
        break;
      case 'webhook':
        // In a real system, would send HTTP request
        console.log(`Would send webhook to ${notification.target}`);
        break;
    }
  }

  // Mark notification as sent
  await pool.query(
    'UPDATE alert_instances SET notification_sent = true WHERE id = $1',
    [instance.id]
  );
}

// Start periodic alert evaluation
let alertInterval: ReturnType<typeof setInterval> | null = null;

export function startAlertEvaluator(intervalSeconds: number = 30): void {
  if (alertInterval) {
    clearInterval(alertInterval);
  }

  console.log(`Starting alert evaluator (interval: ${intervalSeconds}s)`);

  alertInterval = setInterval(async () => {
    try {
      await evaluateAllAlerts();
    } catch (error) {
      console.error('Alert evaluation error:', error);
    }
  }, intervalSeconds * 1000);

  // Run once immediately
  evaluateAllAlerts().catch(console.error);
}

export function stopAlertEvaluator(): void {
  if (alertInterval) {
    clearInterval(alertInterval);
    alertInterval = null;
  }
}
