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

const router = Router();

// Alert condition schema
const AlertConditionSchema = z.object({
  operator: z.enum(['>', '<', '>=', '<=', '==', '!=']),
  threshold: z.number(),
  aggregation: z.enum(['avg', 'min', 'max', 'sum', 'count']).default('avg'),
});

// Alert notification schema
const AlertNotificationSchema = z.object({
  channel: z.enum(['console', 'webhook']),
  target: z.string().min(1),
});

// Create alert rule schema
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

// Update alert rule schema
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

// Get all alert rules
router.get('/rules', async (req: Request, res: Response) => {
  try {
    const enabled = req.query.enabled === 'true' ? true : req.query.enabled === 'false' ? false : undefined;
    const rules = await getAlertRules({ enabled });
    res.json({ rules });
  } catch (error) {
    console.error('Get alert rules error:', error);
    res.status(500).json({ error: 'Failed to get alert rules' });
  }
});

// Get single alert rule
router.get('/rules/:id', async (req: Request, res: Response) => {
  try {
    const rule = await getAlertRule(req.params.id);
    if (!rule) {
      return res.status(404).json({ error: 'Alert rule not found' });
    }
    res.json(rule);
  } catch (error) {
    console.error('Get alert rule error:', error);
    res.status(500).json({ error: 'Failed to get alert rule' });
  }
});

// Create alert rule
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

    res.status(201).json(rule);
  } catch (error) {
    console.error('Create alert rule error:', error);
    res.status(500).json({ error: 'Failed to create alert rule' });
  }
});

// Update alert rule
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

    res.json(rule);
  } catch (error) {
    console.error('Update alert rule error:', error);
    res.status(500).json({ error: 'Failed to update alert rule' });
  }
});

// Delete alert rule
router.delete('/rules/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await deleteAlertRule(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Alert rule not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Delete alert rule error:', error);
    res.status(500).json({ error: 'Failed to delete alert rule' });
  }
});

// Get alert instances
router.get('/instances', async (req: Request, res: Response) => {
  try {
    const ruleId = req.query.rule_id as string | undefined;
    const status = req.query.status as 'firing' | 'resolved' | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;

    const instances = await getAlertInstances({ ruleId, status, limit });
    res.json({ instances });
  } catch (error) {
    console.error('Get alert instances error:', error);
    res.status(500).json({ error: 'Failed to get alert instances' });
  }
});

// Test/evaluate an alert rule
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
    console.error('Evaluate alert rule error:', error);
    res.status(500).json({ error: 'Failed to evaluate alert rule' });
  }
});

export default router;
