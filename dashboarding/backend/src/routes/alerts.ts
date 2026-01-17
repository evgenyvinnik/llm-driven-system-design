/**
 * @fileoverview Alert rules and instances API routes.
 *
 * Exposes REST endpoints for:
 * - Alert rule CRUD operations (create, read, update, delete)
 * - Alert instance querying (firing and resolved alerts)
 * - Manual alert rule evaluation for testing
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  createAlertRule,
  getAlertRule,
  getAlertRules,
  updateAlertRule,
  deleteAlertRule,
  getAlertInstances,
  evaluateAlertRule,
} from '../services/alertService.js';
import logger from '../shared/logger.js';

const router = Router();

/**
 * Zod schema for alert condition configuration.
 */
const AlertConditionSchema = z.object({
  operator: z.enum(['>', '<', '>=', '<=', '==', '!=']),
  threshold: z.number(),
  aggregation: z.enum(['avg', 'min', 'max', 'sum', 'count']).default('avg'),
});

/**
 * Zod schema for alert notification channel configuration.
 */
const AlertNotificationSchema = z.object({
  channel: z.enum(['console', 'webhook']),
  target: z.string().min(1),
});

/**
 * Zod schema for alert rule creation requests.
 */
const CreateAlertRuleSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  metric_name: z.string().min(1),
  tags: z.record(z.string()).optional(),
  condition: AlertConditionSchema,
  window_seconds: z.number().min(30).max(3600).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  notifications: z.array(AlertNotificationSchema).optional(),
  enabled: z.boolean().optional(),
});

/**
 * Zod schema for alert rule update requests.
 */
const UpdateAlertRuleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  metric_name: z.string().min(1).optional(),
  tags: z.record(z.string()).optional(),
  condition: AlertConditionSchema.optional(),
  window_seconds: z.number().min(30).max(3600).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  notifications: z.array(AlertNotificationSchema).optional(),
  enabled: z.boolean().optional(),
});

/**
 * GET /rules
 * Lists all alert rules, optionally filtered by enabled status.
 *
 * @query enabled - Filter by enabled/disabled status ('true' or 'false')
 * @returns {rules: AlertRule[]} - Array of alert rules
 */
router.get('/rules', async (req: Request, res: Response) => {
  try {
    const enabled = req.query.enabled === 'true' ? true : req.query.enabled === 'false' ? false : undefined;
    const rules = await getAlertRules({ enabled });
    res.json({ rules });
  } catch (error) {
    logger.error({ error }, 'Get alert rules error');
    res.status(500).json({ error: 'Failed to get alert rules' });
  }
});

/**
 * GET /rules/:id
 * Retrieves a single alert rule by ID.
 *
 * @param id - Alert rule UUID
 * @returns The alert rule if found
 */
router.get('/rules/:id', async (req: Request, res: Response) => {
  try {
    const rule = await getAlertRule(req.params.id);
    if (!rule) {
      return res.status(404).json({ error: 'Alert rule not found' });
    }
    res.json(rule);
  } catch (error) {
    logger.error({ error, ruleId: req.params.id }, 'Get alert rule error');
    res.status(500).json({ error: 'Failed to get alert rule' });
  }
});

/**
 * POST /rules
 * Creates a new alert rule.
 *
 * @body {name, metric_name, condition, window_seconds?, severity?, notifications?, enabled?}
 * @returns The newly created alert rule
 */
router.post('/rules', async (req: Request, res: Response) => {
  try {
    const validation = CreateAlertRuleSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        details: validation.error.errors,
      });
    }

    const {
      name,
      description,
      metric_name,
      tags,
      condition,
      window_seconds,
      severity,
      notifications,
      enabled,
    } = validation.data;

    const rule = await createAlertRule({
      name,
      description,
      metricName: metric_name,
      tags,
      condition,
      windowSeconds: window_seconds,
      severity,
      notifications,
      enabled,
    });

    logger.info({ ruleId: rule.id, name: rule.name }, 'Alert rule created');
    res.status(201).json(rule);
  } catch (error) {
    logger.error({ error }, 'Create alert rule error');
    res.status(500).json({ error: 'Failed to create alert rule' });
  }
});

/**
 * PUT /rules/:id
 * Updates an existing alert rule's properties.
 *
 * @param id - Alert rule UUID
 * @body Partial alert rule properties to update
 * @returns The updated alert rule
 */
router.put('/rules/:id', async (req: Request, res: Response) => {
  try {
    const validation = UpdateAlertRuleSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        details: validation.error.errors,
      });
    }

    const {
      name,
      description,
      metric_name,
      tags,
      condition,
      window_seconds,
      severity,
      notifications,
      enabled,
    } = validation.data;

    const rule = await updateAlertRule(req.params.id, {
      name,
      description,
      metricName: metric_name,
      tags,
      condition,
      windowSeconds: window_seconds,
      severity,
      notifications,
      enabled,
    });

    if (!rule) {
      return res.status(404).json({ error: 'Alert rule not found' });
    }

    logger.info({ ruleId: rule.id }, 'Alert rule updated');
    res.json(rule);
  } catch (error) {
    logger.error({ error, ruleId: req.params.id }, 'Update alert rule error');
    res.status(500).json({ error: 'Failed to update alert rule' });
  }
});

/**
 * DELETE /rules/:id
 * Deletes an alert rule and all its instances.
 *
 * @param id - Alert rule UUID
 * @returns 204 No Content on success
 */
router.delete('/rules/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await deleteAlertRule(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Alert rule not found' });
    }
    logger.info({ ruleId: req.params.id }, 'Alert rule deleted');
    res.status(204).send();
  } catch (error) {
    logger.error({ error, ruleId: req.params.id }, 'Delete alert rule error');
    res.status(500).json({ error: 'Failed to delete alert rule' });
  }
});

/**
 * GET /instances
 * Retrieves alert instances (active and historical alerts).
 *
 * @query rule_id - Filter by specific alert rule
 * @query status - Filter by 'firing' or 'resolved'
 * @query limit - Maximum results (default: 100)
 * @returns {instances: AlertInstance[]} - Array of alert instances
 */
router.get('/instances', async (req: Request, res: Response) => {
  try {
    const ruleId = req.query.rule_id as string | undefined;
    const status = req.query.status as 'firing' | 'resolved' | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;

    const instances = await getAlertInstances({ ruleId, status, limit });
    res.json({ instances });
  } catch (error) {
    logger.error({ error }, 'Get alert instances error');
    res.status(500).json({ error: 'Failed to get alert instances' });
  }
});

/**
 * POST /rules/:id/evaluate
 * Manually evaluates an alert rule against current data.
 * Useful for testing alert configurations without waiting for the scheduler.
 *
 * @param id - Alert rule UUID
 * @returns {should_fire, current_value, condition} - Evaluation result
 */
router.post('/rules/:id/evaluate', async (req: Request, res: Response) => {
  try {
    const rule = await getAlertRule(req.params.id);
    if (!rule) {
      return res.status(404).json({ error: 'Alert rule not found' });
    }

    const result = await evaluateAlertRule(rule);
    res.json({
      rule_id: rule.id,
      rule_name: rule.name,
      should_fire: result.shouldFire,
      current_value: result.currentValue,
      condition: rule.condition,
    });
  } catch (error) {
    logger.error({ error, ruleId: req.params.id }, 'Evaluate alert rule error');
    res.status(500).json({ error: 'Failed to evaluate alert rule' });
  }
});

export default router;
